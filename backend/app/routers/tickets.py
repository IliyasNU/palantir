"""Free tickets: claim one per event, list and view your own."""
import secrets
from typing import Optional

from fastapi import APIRouter, Response, status
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.dependencies.auth import CurrentUser
from app.dependencies.db import DbSession
from app.dependencies.events import get_event_or_404, is_visible
from app.dependencies.roles import is_admin
from app.errors import api_error
from app.models import Event, EventStatus, Ticket
from app.schemas.ticket import TicketRead

router = APIRouter(tags=["tickets"])

QR_PAYLOAD_PREFIX = "biletflow:ticket:v1:"


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
def claim_ticket(event_id: int, db: DbSession, current_user: CurrentUser, response: Response):
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

    ticket = Ticket(event_id=event.id, attendee_id=current_user.id, qr_payload=new_qr_payload())
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


@router.get("/tickets/{ticket_id}", response_model=TicketRead)
def get_ticket(ticket_id: int, db: DbSession, current_user: CurrentUser):
    """One of your tickets (admins may read any). Other people's tickets look like they do not exist."""
    ticket = db.get(Ticket, ticket_id)
    if ticket is None or (ticket.attendee_id != current_user.id and not is_admin(current_user)):
        raise api_error(status.HTTP_404_NOT_FOUND, "TICKET_NOT_FOUND", "Ticket not found")
    return ticket
