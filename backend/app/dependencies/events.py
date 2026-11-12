"""Loading events and deciding who may manage or scan them."""
from typing import Optional

from fastapi import status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.dependencies.roles import is_admin
from app.errors import api_error
from app.models import Event, EventStaff, EventStatus, User


def get_event_or_404(db: Session, event_id: int) -> Event:
    event = db.get(Event, event_id)
    if event is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "EVENT_NOT_FOUND", "Event not found")
    return event


def can_manage(event: Event, user: User) -> bool:
    """The event's organizer and admins manage it."""
    return is_admin(user) or event.organizer_id == user.id


def ensure_can_manage(event: Event, user: User) -> None:
    if not can_manage(event, user):
        raise api_error(status.HTTP_403_FORBIDDEN, "FORBIDDEN", "You can only manage your own events")


def can_scan(db: Session, event: Event, user: User) -> bool:
    """Managers plus the users assigned as staff for this event."""
    if can_manage(event, user):
        return True
    assignment = select(EventStaff).where(EventStaff.event_id == event.id, EventStaff.user_id == user.id)
    return db.scalar(assignment) is not None


def ensure_can_scan(db: Session, event: Event, user: User) -> None:
    if not can_scan(db, event, user):
        raise api_error(status.HTTP_403_FORBIDDEN, "FORBIDDEN", "You are not staff for this event")


def is_visible(event: Event, user: Optional[User]) -> bool:
    """Drafts and suspended events are private to their managers; other published and cancelled events are public."""
    if event.status == EventStatus.DRAFT.value or event.suspended_at is not None:
        return user is not None and can_manage(event, user)
    return True


def ensure_not_suspended(event: Event) -> None:
    """Refuse to sell or issue anything at a suspended event: ``409 EVENT_SUSPENDED``.

    The shared check of every sales and issuing path (free claims now; checkout, promo codes and the like later).
    Call it on the event row read under ``lock_event`` and keep ``suspended_at IS NULL`` in the path's
    conditional ``UPDATE``: see "Suspension contract for later phases" in docs/architecture.md.
    """
    if event.suspended_at is not None:
        raise api_error(status.HTTP_409_CONFLICT, "EVENT_SUSPENDED", "Ticket sales for this event are suspended")
