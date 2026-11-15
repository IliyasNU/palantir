"""Platform administration: find and suspend users and events, and read the whole action history.

Suspending a user disables the account (``users.is_active``): sign-in and every request with an existing token
are refused. Suspending an event hides it from everyone except its organizer and admins and stops ticket
claims; tickets already issued still admit. Both are reversible, and every change is written to the action log.
"""
from typing import Annotated, Optional

from fastapi import APIRouter, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit import read_actions, record_action
from app.db.base import utcnow
from app.dependencies.action_log import LogFilters
from app.dependencies.db import DbSession
from app.dependencies.roles import AdminUser
from app.errors import api_error
from app.models import Event, User
from app.schemas.admin import AdminEventRead, SuspendRequest
from app.schemas.ticket_type import ActionLogRead
from app.schemas.user import UserRead
from app.ticket_types import lock_event

router = APIRouter(prefix="/admin", tags=["admin"])

SEARCH_LIMIT = 50
SearchLimit = Annotated[int, Query(ge=1, le=SEARCH_LIMIT)]


def _contains(column, term: str):
    # autoescape: "%" and "_" in the query are literal characters, not wildcards.
    return func.lower(column).contains(term.lower(), autoescape=True)


def _search_term(q: Optional[str]) -> Optional[str]:
    """The trimmed query, or None when nothing can match it (PostgreSQL text cannot hold NUL)."""
    term = (q or "").strip()
    return None if "\x00" in term else term


# ------------------------------------------------------------------ users
@router.get("/users", response_model=list[UserRead])
def search_users(db: DbSession, admin: AdminUser, q: Optional[str] = None, limit: SearchLimit = SEARCH_LIMIT):
    """Users whose name or e-mail contains ``q`` (case-insensitive); the newest accounts when ``q`` is empty."""
    term = _search_term(q)
    if term is None:
        return []
    query = select(User)
    if term:
        query = query.where(_contains(User.full_name, term) | _contains(User.email, term))
    return db.scalars(query.order_by(User.id.desc()).limit(limit)).all()


def _set_user_active(db: Session, admin: User, user_id: int, active: bool, reason: Optional[str]) -> User:
    user = db.scalar(
        select(User).where(User.id == user_id).with_for_update(of=User).execution_options(populate_existing=True)
    )
    if user is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "USER_NOT_FOUND", "User not found")
    if not active and user.id == admin.id:
        raise api_error(status.HTTP_409_CONFLICT, "CANNOT_SUSPEND_SELF", "You cannot suspend your own account")
    if user.is_active != active:  # repeating the same change is a no-op and writes no second record
        user.is_active = active
        record_action(
            db, event_id=None, actor_id=admin.id, action="user.reactivated" if active else "user.suspended",
            entity_type="user", entity_id=user.id,
            description="Reactivated the account" if active else f"Suspended the account: {reason}",
        )
    db.commit()
    return user


@router.post("/users/{user_id}/suspend", response_model=UserRead)
def suspend_user(user_id: int, payload: SuspendRequest, db: DbSession, admin: AdminUser):
    """Disable an account. Its tokens stop working at once. Suspending twice is a no-op."""
    return _set_user_active(db, admin, user_id, active=False, reason=payload.reason)


@router.post("/users/{user_id}/reactivate", response_model=UserRead)
def reactivate_user(user_id: int, db: DbSession, admin: AdminUser):
    """Enable a suspended account again. Reactivating an active account is a no-op."""
    return _set_user_active(db, admin, user_id, active=True, reason=None)


# ------------------------------------------------------------------ events
@router.get("/events", response_model=list[AdminEventRead])
def search_events(
    db: DbSession, admin: AdminUser, q: Optional[str] = None, suspended: Optional[bool] = None,
    limit: SearchLimit = SEARCH_LIMIT,
):
    """Events in every status whose title contains ``q``; optionally only suspended or only not suspended."""
    term = _search_term(q)
    if term is None:
        return []
    query = select(Event)
    if term:
        query = query.where(_contains(Event.title, term))
    if suspended is not None:
        query = query.where(Event.suspended_at.is_not(None) if suspended else Event.suspended_at.is_(None))
    return db.scalars(query.order_by(Event.id.desc()).limit(limit)).all()


@router.post("/events/{event_id}/suspend", response_model=AdminEventRead)
def suspend_event(event_id: int, payload: SuspendRequest, db: DbSession, admin: AdminUser):
    """Hide an event from the public and stop ticket claims. Suspending twice is a no-op."""
    # The exclusive row lock waits for ticket claims in flight; claims that start later see the suspension.
    event = lock_event(db, event_id)
    if event.suspended_at is None:
        event.suspended_at = utcnow()
        record_action(
            db, event_id=event.id, actor_id=admin.id, action="event.suspended", entity_type="event",
            entity_id=event.id, description=f"Suspended by a platform admin: {payload.reason}",
        )
    db.commit()
    db.refresh(event)
    return event


@router.post("/events/{event_id}/reactivate", response_model=AdminEventRead)
def reactivate_event(event_id: int, db: DbSession, admin: AdminUser):
    """Lift a suspension; the event returns exactly as it was. Reactivating an event that is not suspended is a no-op."""
    event = lock_event(db, event_id)
    if event.suspended_at is not None:
        event.suspended_at = None
        record_action(
            db, event_id=event.id, actor_id=admin.id, action="event.reactivated", entity_type="event",
            entity_id=event.id, description="Suspension lifted by a platform admin",
        )
    db.commit()
    db.refresh(event)
    return event


# ------------------------------------------------------------------ history
@router.get("/action-log", response_model=list[ActionLogRead])
def read_platform_action_log(
    db: DbSession, admin: AdminUser, filters: LogFilters,
    event_id: Annotated[Optional[int], Query(ge=1, le=2_147_483_647)] = None,
):
    """Every recorded action, newest first, including platform actions that belong to no event."""
    return read_actions(
        db, event_id=event_id, date_from=filters.date_from, date_to=filters.date_to, action=filters.action,
        limit=filters.limit, offset=filters.offset,
    )
