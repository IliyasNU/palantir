"""Event inventory. Closing a ticket releases both the event and its type counter."""
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, String, Text, false, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, utcnow
from app.ticket_type_name import TICKET_TYPE_NAME_MAX_LENGTH


class TicketType(Base):
    __tablename__ = "ticket_types"
    __table_args__ = (
        CheckConstraint("price_tiyn >= 0", name="price_nonnegative"),
        CheckConstraint("quantity >= 0 AND tickets_issued >= 0 AND tickets_issued <= quantity", name="tickets_within_quantity"),
        CheckConstraint("order_limit >= 1", name="order_limit_positive"),
        CheckConstraint("sales_start IS NULL OR sales_end IS NULL OR sales_start < sales_end", name="sales_window_valid"),
        Index("uq_ticket_types_default_event", "event_id", unique=True,
              postgresql_where=text("is_default"), sqlite_where=text("is_default = 1")),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="RESTRICT"), index=True)
    name: Mapped[str] = mapped_column(String(TICKET_TYPE_NAME_MAX_LENGTH))
    description: Mapped[Optional[str]] = mapped_column(Text)
    price_tiyn: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    quantity: Mapped[int] = mapped_column(Integer)
    tickets_issued: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    sales_start: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    sales_end: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    order_limit: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    hidden: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, server_default=func.now())

    @property
    def remaining(self) -> int:
        return self.quantity - self.tickets_issued
