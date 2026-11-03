"""Ticket check-in for the mobile scanner (contract: mobile/API.md).

Safe to retry: the check-in row is the receipt, so resending the same request_id returns it instead of
admitting twice. The unique ticket_id makes a second admission impossible even under concurrency.
"""
import uuid
from typing import Optional

from fastapi import APIRouter, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.dependencies.auth import CurrentUser
from app.dependencies.db import DbSession
from app.dependencies.events import can_scan, get_event_or_404
from app.errors import api_error
from app.models import CheckIn, Event, EventStatus, Ticket, User
from app.schemas.check_in import CheckInReceipt, CheckInRequest

router = APIRouter(tags=["check-in"])


def _receipt(record: CheckIn) -> CheckInReceipt:
    return CheckInReceipt(
        event_id=record.event_id,
        ticket_id=record.ticket_id,
        request_id=str(record.request_id),
        checked_in_at=record.checked_in_at,
    )


def _find_by_request_id(db: Session, request_id: uuid.UUID) -> Optional[CheckIn]:
    return db.scalar(select(CheckIn).where(CheckIn.request_id == request_id))


def _replay(record: CheckIn, event: Event, user: User, payload: CheckInRequest) -> CheckInReceipt:
    """Same request_id: return the original receipt only if it really is the same request."""
    if record.staff_id != user.id or record.event_id != event.id or record.ticket.qr_payload != payload.qr_payload:
        raise api_error(
            status.HTTP_409_CONFLICT, "REQUEST_ID_CONFLICT", "This request_id was already used for a different scan"
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
    event = get_event_or_404(db, event_id)
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

    ticket = db.scalar(select(Ticket).where(Ticket.qr_payload == payload.qr_payload, Ticket.event_id == event.id))
    if ticket is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "INVALID_TICKET", "Unknown ticket or ticket for another event")
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
