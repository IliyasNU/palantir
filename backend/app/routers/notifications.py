"""The signed-in user's notifications: newest first, and marking one as read."""
from typing import Annotated

from fastapi import APIRouter, Query, status
from sqlalchemy import select

from app.db.base import utcnow
from app.dependencies.auth import CurrentUser
from app.dependencies.db import DbSession
from app.errors import api_error
from app.models import Notification
from app.schemas.notification import NotificationRead

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("/me", response_model=list[NotificationRead])
def list_my_notifications(
    db: DbSession,
    current_user: CurrentUser,
    unread: bool = False,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    """Your notifications, newest first. ``unread=true`` leaves out the ones already read."""
    query = select(Notification).where(Notification.user_id == current_user.id)
    if unread:
        query = query.where(Notification.read_at.is_(None))
    return db.scalars(query.order_by(Notification.id.desc()).limit(limit).offset(offset)).all()


@router.post("/{notification_id}/read", response_model=NotificationRead)
def mark_read(notification_id: int, db: DbSession, current_user: CurrentUser):
    """Mark one of your notifications as read. Repeating it keeps the first time."""
    notification = db.get(Notification, notification_id)
    if notification is None or notification.user_id != current_user.id:
        raise api_error(status.HTTP_404_NOT_FOUND, "NOTIFICATION_NOT_FOUND", "Notification not found")
    if notification.read_at is None:
        notification.read_at = utcnow()
        db.commit()
    return notification
