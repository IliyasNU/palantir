"""Ticket check-in and its undo for the mobile scanner (contract: mobile/API.md).

Safe to retry: the check-in row is the receipt, so resending the same request_id returns it instead of
admitting twice. A ticket has at most one check-in that is not undone, enforced by a partial unique index,
so a second admission is impossible even under concurrency.

Undo keeps the row as history. Its request_id then answers CHECK_IN_UNDONE: it can neither admit again nor
read as a current admission. Admitting the ticket again needs a new scan with a new request_id.

Lock order everywhere a ticket changes: the event row first, then the ticket row.
"""
import uuid
from typing import Optional

from fastapi import APIRouter, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.dependencies.auth import CurrentUser
from app.dependencies.db import DbSession
from app.db.base import utcnow
from app.dependencies.events import can_manage, can_scan
from app.errors import api_error
from app.models import CheckIn, Event, EventStatus, Ticket, TicketStatus, User
from app.schemas.check_in import CheckInReceipt, CheckInRequest, UndoReceipt, UndoRequest

router = APIRouter(tags=["check-in"])


def _receipt(record: CheckIn) -> CheckInReceipt:
    return CheckInReceipt(
        event_id=record.event_id,
        ticket_id=record.ticket_id,
        check_in_id=record.id,
        request_id=str(record.request_id),
        checked_in_at=record.checked_in_at,
    )


def _undo_receipt(record: CheckIn) -> UndoReceipt:
    return UndoReceipt(
        event_id=record.event_id,
        ticket_id=record.ticket_id,
        check_in_id=record.id,
        request_id=str(record.undo_request_id),
        undone_at=record.undone_at,
    )


def _lock_event_for_scan(db: Session, event_id: int) -> Event:
    # FOR SHARE until commit: a concurrent cancel or publish (an UPDATE of this row) waits for this request,
    # so its status and access checks see one consistent state. Parallel scans do not block each other.
    event = db.scalar(select(Event).where(Event.id == event_id).with_for_update(read=True))
    if event is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "EVENT_NOT_FOUND", "Event not found")
    return event


def _lock_ticket(db: Session, *conditions) -> Optional[Ticket]:
    """Lock one ticket row until commit and reload its current admission.

    Check-in, undo, cancel and refund of the same ticket take this lock, so each sees the committed result
    of the previous one.
    """
    query = select(Ticket).where(*conditions).with_for_update(of=Ticket).execution_options(populate_existing=True)
    return db.scalar(query)


def _find_by_request_id(db: Session, request_id: uuid.UUID) -> Optional[CheckIn]:
    return db.scalar(select(CheckIn).where(CheckIn.request_id == request_id))


def _replay(record: CheckIn, event: Event, user: User, payload: CheckInRequest) -> CheckInReceipt:
    """Same request_id: return the original receipt only if it really is the same request."""
    if record.staff_id != user.id or record.event_id != event.id or record.ticket.qr_payload != payload.qr_payload:
        raise api_error(
            status.HTTP_409_CONFLICT, "REQUEST_ID_CONFLICT", "This request_id was already used for a different scan"
        )
    if record.undone_at is not None:
        # The request did commit, but that admission was reversed. It is history, not a current admission.
        raise api_error(
            status.HTTP_409_CONFLICT, "CHECK_IN_UNDONE", "This check-in was undone; scan the ticket again to admit"
        )
    return _receipt(record)


def _ticket_taken(db: Session, request_id: uuid.UUID, event: Event, user: User, payload: CheckInRequest):
    """The ticket is already admitted. A parallel retry of this very request may have done it: replay it."""
    previous = _find_by_request_id(db, request_id)
    if previous is not None:
        return _replay(previous, event, user, payload)
    raise api_error(status.HTTP_409_CONFLICT, "ALREADY_CHECKED_IN", "Ticket already used")


@router.post("/events/{event_id}/check-in", response_model=CheckInReceipt)
def check_in(event_id: int, payload: CheckInRequest, db: DbSession, current_user: CurrentUser):
    event = _lock_event_for_scan(db, event_id)
    # Checked before the replay lookup so revoked staff cannot read receipts through retries.
    if not can_scan(db, event, current_user):
        raise api_error(status.HTTP_403_FORBIDDEN, "FORBIDDEN", "You are not staff for this event")

    request_id = uuid.UUID(payload.request_id)
    previous = _find_by_request_id(db, request_id)
    if previous is not None:
        return _replay(previous, event, current_user, payload)

    if event.status == EventStatus.CANCELLED.value:
        raise api_error(status.HTTP_409_CONFLICT, "EVENT_CANCELLED", "Event is cancelled")
    if event.status == EventStatus.DRAFT.value:
        raise api_error(status.HTTP_409_CONFLICT, "EVENT_NOT_PUBLISHED", "Event is not published yet")

    ticket = None
    if "\x00" not in payload.qr_payload:  # PostgreSQL text cannot hold NUL, so no ticket can match it
        ticket = _lock_ticket(db, Ticket.qr_payload == payload.qr_payload, Ticket.event_id == event.id)
    if ticket is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "INVALID_TICKET", "Unknown ticket or ticket for another event")
    # Final ticket states. They are about this one ticket; EVENT_CANCELLED above is about the whole event.
    if ticket.status == TicketStatus.CANCELLED.value:
        raise api_error(status.HTTP_409_CONFLICT, "TICKET_CANCELLED", "Ticket was cancelled")
    if ticket.status == TicketStatus.REFUNDED.value:
        raise api_error(status.HTTP_409_CONFLICT, "TICKET_REFUNDED", "Ticket was refunded")
    if ticket.check_in is not None:
        return _ticket_taken(db, request_id, event, current_user, payload)

    record = CheckIn(ticket_id=ticket.id, event_id=event.id, staff_id=current_user.id, request_id=request_id)
    db.add(record)
    try:
        db.commit()
    except IntegrityError:  # lost a race: either the same request_id or the same ticket was committed first
        db.rollback()
        return _ticket_taken(db, request_id, event, current_user, payload)
    db.refresh(record)
    return _receipt(record)


def _find_by_undo_request_id(db: Session, request_id: uuid.UUID) -> Optional[CheckIn]:
    return db.scalar(select(CheckIn).where(CheckIn.undo_request_id == request_id))


def _undo_result(record: CheckIn, previous: Optional[CheckIn], user: User) -> UndoReceipt:
    """Answer for a check-in that is already undone, or for an undo request_id that was already used."""
    if previous is not None:
        if previous.id == record.id and previous.undone_by_id == user.id:
            return _undo_receipt(previous)  # a retry of this very undo
        raise api_error(
            status.HTTP_409_CONFLICT, "REQUEST_ID_CONFLICT", "This request_id was already used for a different undo"
        )
    raise api_error(status.HTTP_409_CONFLICT, "CHECK_IN_ALREADY_UNDONE", "This check-in was already undone")


@router.post("/events/{event_id}/check-ins/{check_in_id}/undo", response_model=UndoReceipt)
def undo_check_in(event_id: int, check_in_id: int, payload: UndoRequest, db: DbSession, current_user: CurrentUser):
    """Reverse one admission (the event's organizer or an admin). The ticket can then be scanned again."""
    event = _lock_event_for_scan(db, event_id)
    if not can_scan(db, event, current_user):
        raise api_error(status.HTTP_403_FORBIDDEN, "FORBIDDEN", "You are not staff for this event")
    if not can_manage(event, current_user):
        raise api_error(
            status.HTTP_403_FORBIDDEN, "UNDO_NOT_ALLOWED", "Only the event organizer or an admin can undo a check-in"
        )

    record = db.scalar(select(CheckIn).where(CheckIn.id == check_in_id, CheckIn.event_id == event.id))
    if record is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "CHECK_IN_NOT_FOUND", "No such check-in at this event")
    _lock_ticket(db, Ticket.id == record.ticket_id)
    db.refresh(record)  # a concurrent undo of the same check-in has committed by now

    request_id = uuid.UUID(payload.request_id)
    previous = _find_by_undo_request_id(db, request_id)
    if previous is not None or record.undone_at is not None:
        return _undo_result(record, previous, current_user)

    record.undone_at = utcnow()
    record.undone_by_id = current_user.id
    record.undo_request_id = request_id
    try:
        db.commit()
    except IntegrityError:  # the same undo request_id was committed for another check-in at the same moment
        db.rollback()
        record = db.scalar(select(CheckIn).where(CheckIn.id == check_in_id, CheckIn.event_id == event.id))
        return _undo_result(record, _find_by_undo_request_id(db, request_id), current_user)
    db.refresh(record)
    return _undo_receipt(record)
