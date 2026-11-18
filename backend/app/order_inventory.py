"""Shared reservation maintenance. Callers hold the event lock and own the transaction."""
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.db.base import utcnow
from app.errors import api_error
from app.models import Event, TicketType
from app.models.order import Order


def release_order(db: Session, order: Order, state: str) -> None:
    """Exactly once under the event lock; the event is always locked before orders."""
    if order.status != "pending":
        return
    order.status = state
    order.completed_at = utcnow()
    db.execute(update(Event).where(Event.id == order.event_id)
               .values(tickets_issued=Event.tickets_issued - 1))
    db.execute(update(TicketType).where(TicketType.id == order.ticket_type_id)
               .values(tickets_issued=TicketType.tickets_issued - 1))
    db.flush()


def expire_event_orders(db: Session, event_id: int) -> int:
    orders = db.scalars(select(Order).where(Order.event_id == event_id, Order.status == "pending",
                                            Order.expires_at <= utcnow())
                        .execution_options(populate_existing=True)).all()
    for order in orders:
        release_order(db, order, "expired")
    return len(orders)


def ensure_no_pending_order(db: Session, event_id: int, buyer_id: int) -> None:
    if db.scalar(select(Order.id).where(Order.event_id == event_id, Order.buyer_id == buyer_id,
                                       Order.status == "pending")) is not None:
        raise api_error(409, "PENDING_ORDER_EXISTS", "Finish or cancel your pending demo order first")


def refresh_inventory(db: Session, event_ids: list[int]) -> None:
    """Lazy cleanup for inventory reads, in a deterministic lock order."""
    from app.ticket_types import lock_event
    for event_id in sorted(set(event_ids)):
        lock_event(db, event_id)
        expire_event_orders(db, event_id)
    db.commit()
    db.expire_all()
