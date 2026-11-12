import enum
from datetime import datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, utcnow

if TYPE_CHECKING:
    from app.models.check_in import CheckIn
    from app.models.event import Event
    from app.models.ticket_type import TicketType


class TicketStatus(str, enum.Enum):
    """Admission state of one ticket. ``cancelled`` and ``refunded`` are final and never admit."""

    ACTIVE = "active"
    CANCELLED = "cancelled"
    REFUNDED = "refunded"


class Ticket(Base):
    """A free ticket: one per attendee per event."""

    __tablename__ = "tickets"
    __table_args__ = (
        UniqueConstraint("event_id", "attendee_id", name="uq_tickets_event_id_attendee_id"),
        CheckConstraint("status IN ('active', 'cancelled', 'refunded')", name="status_valid"),
        CheckConstraint(
            "(status = 'active') = (status_changed_at IS NULL) "
            "AND (status_changed_at IS NULL) = (status_changed_by_id IS NULL)",
            name="status_change_recorded",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="RESTRICT"), index=True)
    attendee_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), index=True)
    ticket_type_id: Mapped[int] = mapped_column(ForeignKey("ticket_types.id", ondelete="RESTRICT"), index=True)
    # Opaque string encoded into the QR code; scanners send it back unchanged.
    qr_payload: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    status: Mapped[str] = mapped_column(String(20), default=TicketStatus.ACTIVE.value, server_default="active")
    # Who cancelled or refunded the ticket and when; both stay NULL while it is active.
    status_changed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    status_changed_by_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))

    event: Mapped["Event"] = relationship(lazy="joined")
    ticket_type: Mapped["TicketType"] = relationship(lazy="joined")
    # The current admission only. Undone check-ins stay in ``check_ins`` as history and are not loaded here.
    check_in: Mapped[Optional["CheckIn"]] = relationship(
        primaryjoin="and_(CheckIn.ticket_id == Ticket.id, CheckIn.undone_at.is_(None))",
        uselist=False,
        lazy="selectin",
        viewonly=True,
    )

    @property
    def checked_in_at(self) -> Optional[datetime]:
        return self.check_in.checked_in_at if self.check_in is not None else None
