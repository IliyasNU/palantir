"""Release expired demo reservations. Run: python -m scripts.expire_orders."""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.base import utcnow
from app.db.session import engine
from app.models.order import Order
from app.order_inventory import expire_event_orders
from app.ticket_types import lock_event


def main():
    count = 0
    with Session(engine) as db:
        event_ids = db.scalars(select(Order.event_id).where(Order.status == "pending", Order.expires_at <= utcnow())
                               .distinct().order_by(Order.event_id)).all()
        for event_id in event_ids:
            lock_event(db, event_id)
            count += expire_event_orders(db, event_id)
            db.commit()
    print(f"Expired demo reservations: {count}")


if __name__ == "__main__":
    main()
