"""Per-event staff: who may scan tickets at which event."""
from typing import Optional

from fastapi import APIRouter, Response, status
from sqlalchemy import delete, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.audit import record_action
from app.dependencies.auth import CurrentUser
from app.dependencies.db import DbSession
from app.dependencies.events import can_manage, ensure_can_manage, get_event_or_404
from app.dependencies.roles import is_admin
from app.errors import api_error
from app.models import Event, EventStaff, EventStatus, User
from app.schemas.event import StaffEventRead
from app.schemas.staff import StaffAssign, StaffRead

router = APIRouter(tags=["staff"])


def _find_assignment(db: Session, event_id: int, user_id: int) -> Optional[EventStaff]:
    return db.scalar(select(EventStaff).where(EventStaff.event_id == event_id, EventStaff.user_id == user_id))


@router.get("/events/{event_id}/staff", response_model=list[StaffRead])
def list_staff(event_id: int, db: DbSession, current_user: CurrentUser):
    event = get_event_or_404(db, event_id)
    ensure_can_manage(event, current_user)
    query = (
        select(EventStaff)
        .where(EventStaff.event_id == event.id)
        .order_by(EventStaff.created_at, EventStaff.user_id)
    )
    return [StaffRead.from_assignment(assignment) for assignment in db.scalars(query)]


@router.post("/events/{event_id}/staff", response_model=StaffRead, status_code=status.HTTP_201_CREATED)
def assign_staff(event_id: int, payload: StaffAssign, db: DbSession, current_user: CurrentUser, response: Response):
    """Let a registered user scan tickets at this event (201). Assigning again returns the assignment (200)."""
    event = get_event_or_404(db, event_id)
    ensure_can_manage(event, current_user)
    user = db.scalar(select(User).where(User.email == payload.email))
    if user is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "USER_NOT_FOUND", "No user with this email")

    assignment = _find_assignment(db, event.id, user.id)
    if assignment is not None:
        response.status_code = status.HTTP_200_OK
        return StaffRead.from_assignment(assignment)

    assignment = EventStaff(event_id=event.id, user=user)
    db.add(assignment)
    record_action(db, event_id=event.id, actor_id=current_user.id, action="staff.assigned", entity_type="user",
                  entity_id=user.id, description=f"Assigned {user.email} as check-in staff")
    try:
        db.commit()
    except IntegrityError:  # assigned concurrently
        db.rollback()
        assignment = _find_assignment(db, event.id, user.id)
        if assignment is None:  # ...and already revoked again
            raise api_error(status.HTTP_409_CONFLICT, "STAFF_CHANGED", "Staff changed concurrently, please retry")
        response.status_code = status.HTTP_200_OK
    return StaffRead.from_assignment(assignment)


@router.delete("/events/{event_id}/staff/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_staff(event_id: int, user_id: int, db: DbSession, current_user: CurrentUser):
    """Revoke scanning access. Removing someone who is not assigned is a no-op."""
    event = get_event_or_404(db, event_id)
    ensure_can_manage(event, current_user)
    removed = db.execute(
        delete(EventStaff).where(EventStaff.event_id == event.id, EventStaff.user_id == user_id)
    ).rowcount
    if removed:
        record_action(db, event_id=event.id, actor_id=current_user.id, action="staff.removed", entity_type="user",
                      entity_id=user_id, description="Removed check-in staff access")
    db.commit()


@router.get("/staff/events", response_model=list[StaffEventRead])
def list_scannable_events(db: DbSession, current_user: CurrentUser):
    """Published events the caller may check tickets in at: assigned, owned, or any for an admin. May be []."""
    query = select(Event).where(Event.status == EventStatus.PUBLISHED.value)
    if not is_admin(current_user):
        assigned = select(EventStaff.event_id).where(EventStaff.user_id == current_user.id)
        query = query.where(or_(Event.organizer_id == current_user.id, Event.id.in_(assigned)))
    return [
        StaffEventRead(
            id=event.id, title=event.title, date=event.date, location=event.location, status=event.status,
            can_manage=can_manage(event, current_user),
        )
        for event in db.scalars(query.order_by(Event.date, Event.id))
    ]
