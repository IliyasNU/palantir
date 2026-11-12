"""Record an action inside the caller's transaction; never commit independently."""
from sqlalchemy.orm import Session

from app.models.action_log import ActionLog


def record_action(db: Session, *, event_id: int, actor_id: int, action: str,
                  entity_type: str, entity_id: int, description: str) -> ActionLog:
    record = ActionLog(event_id=event_id, actor_id=actor_id, action=action,
                       entity_type=entity_type, entity_id=entity_id, description=description[:500])
    db.add(record)
    return record
