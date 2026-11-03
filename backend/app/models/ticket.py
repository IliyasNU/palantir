from datetime import datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, utcnow

if TYPE_CHECKING:
    from app.models.check_in import CheckIn
    from app.models.event import Event


class Ticket(Base):
    """A free ticket: one per attendee per event."""

    __tablename__ = "tickets"
    __table_args__ = (UniqueConstraint("event_id", "attendee_id", name="uq_tickets_event_id_attendee_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="RESTRICT"), index=True)
    attendee_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), index=True)
    # Opaque string encoded into the QR code; scanners send it back unchanged.
    qr_payload: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    event: Mapped["Event"] = relationship(lazy="joined")
    check_in: Mapped[Optional["CheckIn"]] = relationship(back_populates="ticket", uselist=False, lazy="selectin")

    @property
    def checked_in_at(self) -> Optional[datetime]:
        return self.check_in.checked_in_at if self.check_in is not None else None
