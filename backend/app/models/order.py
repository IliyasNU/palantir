"""Demo orders reserve inventory; only paid orders have a ticket."""
from datetime import datetime
from typing import Optional

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, utcnow


class PaidSalesActivation(Base):
    __tablename__ = "paid_sales_activations"

    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="RESTRICT"), primary_key=True)
    terms_accepted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    fee_paid_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    fee_tiyn: Mapped[Optional[int]] = mapped_column(Integer)
    activated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    suspended_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    suspension_reason: Mapped[Optional[str]] = mapped_column(String(300))


class Order(Base):
    __tablename__ = "orders"
    __table_args__ = (
        UniqueConstraint("buyer_id", "request_id", name="uq_orders_buyer_request"),
        CheckConstraint("status IN ('pending', 'paid', 'failed', 'cancelled', 'expired')", name="order_status_valid"),
        CheckConstraint("subtotal_tiyn > 0 AND total_tiyn = subtotal_tiyn AND processing_fee_tiyn >= 0 "
                        "AND processing_fee_tiyn <= subtotal_tiyn", name="order_money_valid"),
        CheckConstraint("(status = 'paid') = (ticket_id IS NOT NULL)", name="order_ticket_paid"),
        Index("uq_orders_pending_buyer_event", "event_id", "buyer_id", unique=True,
              postgresql_where=text("status = 'pending'"), sqlite_where=text("status = 'pending'")),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="RESTRICT"), index=True)
    ticket_type_id: Mapped[int] = mapped_column(ForeignKey("ticket_types.id", ondelete="RESTRICT"))
    buyer_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), index=True)
    request_id: Mapped[str] = mapped_column(String(36))
    attendee_name: Mapped[str] = mapped_column(String(200))
    attendee_email: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(20), default="pending")
    subtotal_tiyn: Mapped[int] = mapped_column(Integer)
    processing_fee_tiyn: Mapped[int] = mapped_column(Integer)
    total_tiyn: Mapped[int] = mapped_column(Integer)
    processing_fee_bps: Mapped[int] = mapped_column(Integer)
    ticket_id: Mapped[Optional[int]] = mapped_column(ForeignKey("tickets.id", ondelete="RESTRICT"), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
