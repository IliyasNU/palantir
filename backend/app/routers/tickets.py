"""Free tickets: claim one per event, list and view your own, cancel or mark refunded.

``cancelled`` and ``refunded`` are admission states of one ticket: such a ticket can never be checked in.
Tickets are free, so no payment exists here; marking a ticket refunded records the state only and moves no money.
"""
import secrets
from typing import Optional

from fastapi import APIRouter, Response, status
from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.dependencies.auth import CurrentUser
from app.dependencies.db import DbSession
from app.db.base import utcnow
from app.dependencies.events import can_manage, get_event_or_404, is_visible
from app.dependencies.roles import is_admin
from app.errors import api_error
from app.models import Event, EventStatus, Ticket, TicketStatus, TicketType, User
from app.schemas.ticket import TicketRead
from app.schemas.ticket_type import TicketClaimRequest
from app.ticket_pdf import build_ticket_pdf
from app.ticket_types import select_claim_type

router = APIRouter(tags=["tickets"])

QR_PAYLOAD_PREFIX = "biletflow:ticket:v1:"


_STATE_CODES = {
    TicketStatus.CANCELLED.value: ("TICKET_CANCELLED", "Ticket was cancelled"),
    TicketStatus.REFUNDED.value: ("TICKET_REFUNDED", "Ticket was refunded"),
}


def new_qr_payload() -> str:
    return QR_PAYLOAD_PREFIX + secrets.token_urlsafe(24)


def _find_ticket(db: Session, event_id: int, attendee_id: int) -> Optional[Ticket]:
    return db.scalar(select(Ticket).where(Ticket.event_id == event_id, Ticket.attendee_id == attendee_id))


def _ensure_open_for_tickets(event: Event) -> None:
    if event.status == EventStatus.DRAFT.value:
        raise api_error(status.HTTP_409_CONFLICT, "EVENT_NOT_PUBLISHED", "Event is not published yet")
    if event.status == EventStatus.CANCELLED.value:
        raise api_error(status.HTTP_409_CONFLICT, "EVENT_CANCELLED", "Event is cancelled")


@router.post("/events/{event_id}/tickets", response_model=TicketRead, status_code=status.HTTP_201_CREATED)
def claim_ticket(event_id: int, db: DbSession, current_user: CurrentUser, response: Response,
                 payload: Optional[TicketClaimRequest] = None):
    """Claim your free ticket (201). Claiming again returns the ticket you already have (200)."""
    event = get_event_or_404(db, event_id)
    if not is_visible(event, current_user):
        raise api_error(status.HTTP_404_NOT_FOUND, "EVENT_NOT_FOUND", "Event not found")

    existing = _find_ticket(db, event.id, current_user.id)
    if existing is not None:
        response.status_code = status.HTTP_200_OK
        return existing
    _ensure_open_for_tickets(event)

    # One atomic statement takes a seat, so concurrent claims for the last seat cannot both succeed.
    seat_taken = db.execute(
        update(Event)
        .where(
            Event.id == event.id,
            Event.status == EventStatus.PUBLISHED.value,
            Event.tickets_issued < Event.capacity,
        )
        .values(tickets_issued=Event.tickets_issued + 1)
        .execution_options(synchronize_session=False)
    ).rowcount
    if not seat_taken:
        db.rollback()
        existing = _find_ticket(db, event.id, current_user.id)  # a parallel claim by the same user won
        if existing is not None:
            response.status_code = status.HTTP_200_OK
            return existing
        _ensure_open_for_tickets(event)
        raise api_error(status.HTTP_409_CONFLICT, "SOLD_OUT", "No tickets left")

    # The event UPDATE above is unchanged. It serialises inventory writers at this event; recheck the
    # attendee after taking its lock so a concurrent identical claim returns the existing ticket.
    existing = _find_ticket(db, event.id, current_user.id)
    if existing is not None:
        db.rollback()
        response.status_code = status.HTTP_200_OK
        return _find_ticket(db, event.id, current_user.id)
    ticket_type = select_claim_type(db, event.id, payload.ticket_type_id if payload else None)
    now = utcnow()
    type_seat_taken = db.execute(
        update(TicketType)
        .where(
            TicketType.id == ticket_type.id,
            TicketType.event_id == event.id,
            TicketType.hidden.is_(False),
            TicketType.price_tiyn == 0,
            TicketType.order_limit >= 1,
            TicketType.tickets_issued < TicketType.quantity,
            or_(TicketType.sales_start.is_(None), TicketType.sales_start <= now),
            or_(TicketType.sales_end.is_(None), TicketType.sales_end > now),
        )
        .values(tickets_issued=TicketType.tickets_issued + 1)
        .execution_options(synchronize_session=False)
    ).rowcount
    if not type_seat_taken:
        db.rollback()  # also return the event seat: both counters are one transaction
        raise api_error(409, "TICKET_TYPE_SOLD_OUT", "No tickets left for this type")
    ticket = Ticket(event_id=event.id, attendee_id=current_user.id, ticket_type_id=ticket_type.id,
                    qr_payload=new_qr_payload())
    db.add(ticket)
    try:
        db.commit()
    except IntegrityError:  # a parallel claim by the same user won; the rollback also returns the seat
        db.rollback()
        existing = _find_ticket(db, event.id, current_user.id)
        if existing is None:
            raise
        response.status_code = status.HTTP_200_OK
        return existing
    db.refresh(ticket)
    return ticket


@router.get("/tickets/me", response_model=list[TicketRead])
def list_my_tickets(db: DbSession, current_user: CurrentUser):
    """Your tickets, newest first."""
    query = (
        select(Ticket)
        .where(Ticket.attendee_id == current_user.id)
        .order_by(Ticket.created_at.desc(), Ticket.id.desc())
    )
    return db.scalars(query).unique().all()


def _readable_ticket(db: Session, ticket_id: int, user: User) -> Ticket:
    ticket = db.get(Ticket, ticket_id)
    if ticket is None or (ticket.attendee_id != user.id and not is_admin(user)):
        raise api_error(status.HTTP_404_NOT_FOUND, "TICKET_NOT_FOUND", "Ticket not found")
    return ticket


@router.get("/tickets/{ticket_id}", response_model=TicketRead)
def get_ticket(ticket_id: int, db: DbSession, current_user: CurrentUser):
    """One of your tickets (admins may read any). Other people's tickets look like they do not exist."""
    return _readable_ticket(db, ticket_id, current_user)


@router.get(
    "/tickets/{ticket_id}/pdf",
    response_class=Response,
    responses={200: {"content": {"application/pdf": {}}, "description": "The ticket as one A4 page"}},
)
def get_ticket_pdf(ticket_id: int, db: DbSession, current_user: CurrentUser):
    """The printable ticket with the same QR as the screen. Only a ticket that can still admit is printed."""
    ticket = _readable_ticket(db, ticket_id, current_user)
    if ticket.status != TicketStatus.ACTIVE.value:
        raise api_error(status.HTTP_409_CONFLICT, *_STATE_CODES[ticket.status])
    if ticket.event.status == EventStatus.CANCELLED.value:
        raise api_error(status.HTTP_409_CONFLICT, "EVENT_CANCELLED", "Event is cancelled")
    attendee = db.get(User, ticket.attendee_id)
    return Response(
        build_ticket_pdf(ticket, attendee),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="biletflow-ticket-{ticket.id}.pdf"',
            # The page carries the admission QR: keep it out of shared caches.
            "Cache-Control": "private, no-store",
        },
    )


def _close_ticket(db: Session, ticket_id: int, user: User, target: TicketStatus, owner_allowed: bool) -> Ticket:
    """Move an active ticket to a final state and give its seat back. Repeating the same change is a no-op."""
    ticket = db.get(Ticket, ticket_id)
    manager = ticket is not None and can_manage(ticket.event, user)
    owner = ticket is not None and ticket.attendee_id == user.id
    if ticket is None or not (manager or owner):
        raise api_error(status.HTTP_404_NOT_FOUND, "TICKET_NOT_FOUND", "Ticket not found")
    if not manager and not owner_allowed:
        raise api_error(
            status.HTTP_403_FORBIDDEN, "FORBIDDEN", "Only the event organizer or an admin can mark a ticket refunded"
        )

    # Same lock order as check-in: the event row, then the ticket row. The exclusive event lock waits for
    # scans in flight, and the ticket lock makes a parallel scan of this ticket see the result.
    db.execute(select(Event.id).where(Event.id == ticket.event_id).with_for_update())
    ticket = db.scalar(
        select(Ticket).where(Ticket.id == ticket_id).with_for_update(of=Ticket)
        .execution_options(populate_existing=True)
    )
    if ticket.status == target.value:
        db.rollback()
        return db.get(Ticket, ticket_id)
    if ticket.status != TicketStatus.ACTIVE.value:
        db.rollback()
        raise api_error(status.HTTP_409_CONFLICT, *_STATE_CODES[ticket.status])
    if ticket.check_in is not None:
        db.rollback()
        raise api_error(
            status.HTTP_409_CONFLICT, "TICKET_CHECKED_IN", "The ticket is checked in; undo the check-in first"
        )

    ticket.status = target.value
    ticket.status_changed_at = utcnow()
    ticket.status_changed_by_id = user.id
    db.execute(
        update(Event)
        .where(Event.id == ticket.event_id)
        .values(tickets_issued=Event.tickets_issued - 1)
        .execution_options(synchronize_session=False)
    )
    db.execute(
        update(TicketType).where(TicketType.id == ticket.ticket_type_id)
        .values(tickets_issued=TicketType.tickets_issued - 1)
        .execution_options(synchronize_session=False)
    )
    db.commit()
    db.expire_all()  # the event counter changed outside the ORM
    return db.get(Ticket, ticket_id)


@router.post("/tickets/{ticket_id}/cancel", response_model=TicketRead)
def cancel_ticket(ticket_id: int, db: DbSession, current_user: CurrentUser):
    """Cancel a ticket for good (its attendee, the event's organizer or an admin). It can no longer be checked in."""
    return _close_ticket(db, ticket_id, current_user, TicketStatus.CANCELLED, owner_allowed=True)


@router.post("/tickets/{ticket_id}/refund", response_model=TicketRead)
def refund_ticket(ticket_id: int, db: DbSession, current_user: CurrentUser):
    """Mark a ticket refunded (the event's organizer or an admin). Records the admission state; moves no money."""
    return _close_ticket(db, ticket_id, current_user, TicketStatus.REFUNDED, owner_allowed=False)
