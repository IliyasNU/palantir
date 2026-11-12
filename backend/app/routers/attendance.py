"""Attendance totals and manual attendee lookup for the people who scan an event.

Access matches check-in: the event's assigned staff, its organizer, or an admin. Manual admission reuses
POST /events/{id}/check-in with the ``qr_payload`` returned by the search; there is no separate write path.
"""
from typing import Optional

from fastapi import APIRouter, status
from sqlalchemy import func, select

from app.dependencies.auth import CurrentUser
from app.dependencies.db import DbSession
from app.dependencies.events import ensure_can_scan, get_event_or_404
from app.errors import api_error
from app.models import CheckIn, Event, Ticket, User
from app.schemas.attendance import AttendanceRead, AttendeeSearchResult, mask_email

router = APIRouter(tags=["attendance"])

SEARCH_MIN_LENGTH = 3
SEARCH_LIMIT = 20


@router.get("/events/{event_id}/attendance", response_model=AttendanceRead)
def get_attendance(event_id: int, db: DbSession, current_user: CurrentUser):
    event = get_event_or_404(db, event_id)
    ensure_can_scan(db, event, current_user)
    # Current admissions only: an undone check-in is history and no longer counts.
    checked_in = (
        select(func.count(CheckIn.id))
        .where(CheckIn.event_id == Event.id, CheckIn.undone_at.is_(None))
        .scalar_subquery()
    )
    # One statement, so all three counters come from a single snapshot of the database.
    capacity, tickets_issued, checked_in_count = db.execute(
        select(Event.capacity, Event.tickets_issued, checked_in).where(Event.id == event.id)
    ).one()
    return AttendanceRead(
        event_id=event.id, capacity=capacity, tickets_issued=tickets_issued, checked_in=checked_in_count
    )


@router.get("/events/{event_id}/attendees", response_model=list[AttendeeSearchResult])
def search_attendees(event_id: int, db: DbSession, current_user: CurrentUser, q: Optional[str] = None):
    """Ticket holders whose name or e-mail contains ``q`` (case-insensitive), at most 20."""
    event = get_event_or_404(db, event_id)
    # Access first: the query is validated only for callers who may see the list at all.
    ensure_can_scan(db, event, current_user)

    term = (q or "").strip()
    if len(term) < SEARCH_MIN_LENGTH:
        raise api_error(
            422,  # the status constant was renamed across Starlette versions
            "QUERY_TOO_SHORT",
            f"Search query must contain at least {SEARCH_MIN_LENGTH} characters",
        )
    if "\x00" in term:  # PostgreSQL text cannot hold NUL, so nothing can match it
        return []

    needle = term.lower()
    query = (
        select(
            Ticket.id, User.full_name, User.email, Ticket.status, CheckIn.checked_in_at, CheckIn.id, Ticket.qr_payload
        )
        .join(User, User.id == Ticket.attendee_id)
        .outerjoin(CheckIn, (CheckIn.ticket_id == Ticket.id) & CheckIn.undone_at.is_(None))
        .where(
            Ticket.event_id == event.id,
            # autoescape: "%" and "_" in the query are literal characters, not wildcards.
            func.lower(User.full_name).contains(needle, autoescape=True)
            | func.lower(User.email).contains(needle, autoescape=True),
        )
        .order_by(func.lower(User.full_name), Ticket.id)
        .limit(SEARCH_LIMIT)
    )
    return [
        AttendeeSearchResult(
            ticket_id=ticket_id,
            full_name=full_name,
            masked_email=mask_email(email),
            status=ticket_status,
            checked_in_at=checked_in_at,
            check_in_id=check_in_id,
            qr_payload=qr_payload,
        )
        for ticket_id, full_name, email, ticket_status, checked_in_at, check_in_id, qr_payload in db.execute(query)
    ]
