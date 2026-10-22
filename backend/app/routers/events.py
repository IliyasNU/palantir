"""Event creation and editing for organizers."""
from fastapi import APIRouter, HTTPException, status
from sqlalchemy.orm import Session

from app.dependencies.auth import CurrentUser
from app.dependencies.db import DbSession
from app.dependencies.roles import OrganizerUser, is_admin
from app.models import Event, User
from app.schemas.event import EventCreate, EventRead, EventUpdate

router = APIRouter(prefix="/events", tags=["events"])


def _get_event_or_404(db: Session, event_id: int) -> Event:
    event = db.get(Event, event_id)
    if event is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Event not found")
    return event


def _ensure_can_manage(event: Event, user: User) -> None:
    """Only the event's organizer - or an admin - may read or change it."""
    if not is_admin(user) and event.organizer_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only manage your own events")


@router.post("", response_model=EventRead, status_code=status.HTTP_201_CREATED)
def create_event(payload: EventCreate, db: DbSession, current_user: OrganizerUser):
    """Create an event owned by the logged-in organizer."""
    event = Event(organizer_id=current_user.id, **payload.model_dump())
    db.add(event)
    db.commit()
    db.refresh(event)
    return event


@router.get("/{event_id}", response_model=EventRead)
def get_event(event_id: int, db: DbSession, current_user: CurrentUser):
    """Fetch an event (owner or admin) - used to pre-fill the edit form."""
    event = _get_event_or_404(db, event_id)
    _ensure_can_manage(event, current_user)
    return event


@router.patch("/{event_id}", response_model=EventRead)
@router.put("/{event_id}", response_model=EventRead)
def update_event(event_id: int, payload: EventUpdate, db: DbSession, current_user: CurrentUser):
    """Edit an event (owner or admin). Only the fields you send are changed (PUT and PATCH behave the same)."""
    event = _get_event_or_404(db, event_id)
    _ensure_can_manage(event, current_user)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(event, field, value)
    db.commit()
    db.refresh(event)
    return event
