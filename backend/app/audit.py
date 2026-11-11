"""The append-only action history: record inside the caller's transaction, read with filters.

``record_action`` never commits, so a history entry exists exactly when the change it describes was committed.
"""
from datetime import datetime
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import User
from app.models.action_log import ActionLog
from app.schemas.ticket_type import ActionLogRead


def record_action(db: Session, *, event_id: Optional[int], actor_id: int, action: str,
                  entity_type: str, entity_id: int, description: str) -> ActionLog:
    """``event_id`` is None only for platform actions that belong to no event."""
    record = ActionLog(event_id=event_id, actor_id=actor_id, action=action,
                       entity_type=entity_type, entity_id=entity_id, description=description[:500])
    db.add(record)
    return record


def read_actions(
    db: Session,
    *,
    event_id: Optional[int] = None,
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    action: Optional[str] = None,
    limit: int = 200,
    offset: int = 0,
) -> list[ActionLogRead]:
    """Newest first. ``event_id=None`` reads the whole platform's history (admins only: the caller checks)."""
    if action and "\x00" in action:  # PostgreSQL text cannot hold NUL, so no action can match it
        return []
    query = select(ActionLog, User.full_name).join(User, User.id == ActionLog.actor_id)
    if event_id is not None:
        query = query.where(ActionLog.event_id == event_id)
    if date_from is not None:
        query = query.where(ActionLog.occurred_at >= date_from)
    if date_to is not None:
        query = query.where(ActionLog.occurred_at <= date_to)
    if action:
        # A prefix, so "check_in" selects "check_in.created" and "check_in.undone". "_" and "%" are literal.
        query = query.where(ActionLog.action.startswith(action, autoescape=True))
    query = query.order_by(ActionLog.occurred_at.desc(), ActionLog.id.desc()).limit(limit).offset(offset)
    return [
        ActionLogRead(
            id=entry.id, event_id=entry.event_id, occurred_at=entry.occurred_at, actor_id=entry.actor_id,
            actor_name=actor_name, action=entry.action, entity_type=entry.entity_type,
            entity_id=entry.entity_id, description=entry.description,
        )
        for entry, actor_name in db.execute(query)
    ]
