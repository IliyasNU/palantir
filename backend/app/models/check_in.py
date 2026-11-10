import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Uuid, func, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, utcnow

if TYPE_CHECKING:
    from app.models.ticket import Ticket

_NOT_UNDONE = text("undone_at IS NULL")


class CheckIn(Base):
    """One admission and the receipt replayed for retries of the same ``request_id``.

    Undoing an admission keeps the row: ``undone_at`` marks it as history, so its ``request_id`` can never
    admit again and never reads as a current admission. A ticket has at most one row that is not undone.
    """

    __tablename__ = "check_ins"
    __table_args__ = (
        Index(
            "uq_check_ins_active_ticket_id", "ticket_id", unique=True,
            postgresql_where=_NOT_UNDONE, sqlite_where=_NOT_UNDONE,
        ),
        CheckConstraint(
            "(undone_at IS NULL) = (undone_by_id IS NULL) AND (undone_at IS NULL) = (undo_request_id IS NULL)",
            name="undo_recorded",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    ticket_id: Mapped[int] = mapped_column(ForeignKey("tickets.id", ondelete="RESTRICT"), index=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="RESTRICT"), index=True)
    staff_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), index=True)
    request_id: Mapped[uuid.UUID] = mapped_column(Uuid, unique=True)
    checked_in_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    undone_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    undone_by_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    # Idempotency key of the undo request, so a retry after a lost response gets the same undo receipt.
    undo_request_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, unique=True)

    ticket: Mapped["Ticket"] = relationship(lazy="joined")
