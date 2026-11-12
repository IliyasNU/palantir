"""Events: public listing, organizer management and the draft -> published -> cancelled lifecycle."""
from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from app.db.base import utcnow
from app.dependencies.auth import CurrentUser, OptionalUser
from app.dependencies.db import DbSession
from app.dependencies.events import ensure_can_manage, get_event_or_404, is_visible
from app.dependencies.roles import OrganizerUser
from app.errors import api_error
from app.models import Event, EventStatus
from app.schemas.event import EventCreate, EventRead, EventUpdate
from app.ticket_types import create_default_type, lock_event, resize_default_or_check_allocation

router = APIRouter(prefix="/events", tags=["events"])


def _capacity_below_issued() -> HTTPException:
    return api_error(
        status.HTTP_409_CONFLICT, "CAPACITY_BELOW_ISSUED", "Capacity cannot be lower than the tickets already issued"
    )


@router.get("", response_model=list[EventRead])
def list_published_events(db: DbSession):
    """Public list of published events, soonest first."""
    query = select(Event).where(Event.status == EventStatus.PUBLISHED.value).order_by(Event.date, Event.id)
    return db.scalars(query).all()


@router.post("", response_model=EventRead, status_code=status.HTTP_201_CREATED)
def create_event(payload: EventCreate, db: DbSession, current_user: OrganizerUser):
    """Create a draft event owned by the logged-in organizer."""
    event = Event(organizer_id=current_user.id, **payload.model_dump())
    db.add(event)
    db.flush()
    create_default_type(db, event, current_user.id)
    db.commit()
    db.refresh(event)
    return event


@router.get("/mine", response_model=list[EventRead])
def list_my_events(db: DbSession, current_user: OrganizerUser):
    """The logged-in organizer's events in every status."""
    query = select(Event).where(Event.organizer_id == current_user.id).order_by(Event.date, Event.id)
    return db.scalars(query).all()


@router.get("/{event_id}", response_model=EventRead)
def get_event(event_id: int, db: DbSession, current_user: OptionalUser):
    """Anyone may read a published or cancelled event; drafts only their owner or an admin."""
    event = get_event_or_404(db, event_id)
    if not is_visible(event, current_user):
        raise api_error(status.HTTP_404_NOT_FOUND, "EVENT_NOT_FOUND", "Event not found")
    return event


@router.patch("/{event_id}", response_model=EventRead)
@router.put("/{event_id}", response_model=EventRead)
def update_event(event_id: int, payload: EventUpdate, db: DbSession, current_user: CurrentUser):
    """Edit an event (owner or admin). Only the fields you send are changed (PUT and PATCH behave the same)."""
    event = get_event_or_404(db, event_id)
    ensure_can_manage(event, current_user)
    changes = payload.model_dump(exclude_unset=True)
    if "capacity" in changes:
        event = lock_event(db, event_id)
    if changes.get("capacity", event.capacity) < event.tickets_issued:
        raise _capacity_below_issued()
    if "capacity" in changes:
        resize_default_or_check_allocation(db, event, changes["capacity"], current_user.id)
    for field, value in changes.items():
        setattr(event, field, value)
    try:
        db.commit()
    except IntegrityError:  # a ticket was issued between the check above and the commit
        db.rollback()
        raise _capacity_below_issued()
    db.refresh(event)
    return event


@router.post("/{event_id}/publish", response_model=EventRead)
def publish_event(event_id: int, db: DbSession, current_user: CurrentUser):
    """Open a draft for ticketing. Publishing an already published event is a no-op."""
    event = get_event_or_404(db, event_id)
    ensure_can_manage(event, current_user)
    # Conditional so a cancel that commits concurrently is never overwritten.
    published = db.execute(
        update(Event)
        .where(Event.id == event.id, Event.status != EventStatus.CANCELLED.value)
        .values(status=EventStatus.PUBLISHED.value, updated_at=utcnow())
        .execution_options(synchronize_session=False)
    ).rowcount
    db.commit()
    if not published:
        raise api_error(status.HTTP_409_CONFLICT, "EVENT_CANCELLED", "A cancelled event cannot be published")
    db.refresh(event)
    return event


@router.post("/{event_id}/cancel", response_model=EventRead)
def cancel_event(event_id: int, db: DbSession, current_user: CurrentUser):
    """Stop ticketing and check-in for good. Cancelling twice is a no-op."""
    event = get_event_or_404(db, event_id)
    ensure_can_manage(event, current_user)
    event.status = EventStatus.CANCELLED.value
    db.commit()
    db.refresh(event)
    return event
