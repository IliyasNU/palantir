import enum
from datetime import datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, utcnow

if TYPE_CHECKING:
    from app.models.user import User
    from app.models.ticket_type import TicketType


class EventStatus(str, enum.Enum):
    DRAFT = "draft"
    PUBLISHED = "published"
    CANCELLED = "cancelled"


class Event(Base):
    __tablename__ = "events"
    __table_args__ = (
        CheckConstraint("capacity > 0", name="capacity_positive"),
        CheckConstraint("status IN ('draft', 'published', 'cancelled')", name="status_valid"),
        CheckConstraint("tickets_issued >= 0 AND tickets_issued <= capacity", name="tickets_within_capacity"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    organizer_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[Optional[str]] = mapped_column(Text)
    date: Mapped[datetime] = mapped_column(DateTime(timezone=True))  # event start (stored in UTC)
    location: Mapped[str] = mapped_column(String(255))
    capacity: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20), default=EventStatus.DRAFT.value, server_default="draft")
    # Kept in step with `tickets` inside the issuing transaction; the check constraint makes overselling impossible.
    tickets_issued: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, server_default=func.now()
    )
    # Set by a platform admin. Independent of `status`: reactivating restores the event exactly as it was.
    # Who suspended it and why are in the action log.
    suspended_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    organizer: Mapped["User"] = relationship(back_populates="events")
    ticket_types: Mapped[list["TicketType"]] = relationship(lazy="selectin", order_by="TicketType.id")

    @property
    def suspended(self) -> bool:
        return self.suspended_at is not None

    @property
    def paid_sales_available(self) -> bool:
        from sqlalchemy.orm import object_session
        from app.paid_sales import activation_state
        db = object_session(self)
        if db is None or self.suspended or self.status != "published":
            return False
        state = activation_state(db, self)
        return state["activated"] and not state["paid_sales_suspended"]

    @property
    def public_ticket_types(self) -> list["TicketType"]:
        return [ticket_type for ticket_type in self.ticket_types if not ticket_type.hidden]
