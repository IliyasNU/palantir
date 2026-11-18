"""Simulated checkout. Lock order: event, orders; issuance and payment commit together."""
from datetime import timedelta

from fastapi import APIRouter, HTTPException, Response
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError

from app.audit import record_action
from app.db.base import utcnow
from app.demo_fees import DEMO_NOTICE, PAYMENT_PROCESSING_FEE_BPS, processing_fee
from app.dependencies.auth import CurrentUser
from app.dependencies.db import DbSession
from app.dependencies.events import ensure_can_manage, ensure_not_suspended
from app.errors import api_error
from app.models import Event, Ticket, TicketType
from app.models.order import Order
from app.order_inventory import ensure_no_pending_order, expire_event_orders, refresh_inventory, release_order
from app.paid_sales import activation_state
from app.schemas.common import to_utc
from app.schemas.order import OrderCreate, OrderRead, PaymentRequest
from app.ticket_types import lock_event

router = APIRouter(tags=["demo orders"])


def reject_ticket(db, event_id, user_id):
    ticket = db.scalar(select(Ticket).where(Ticket.event_id == event_id, Ticket.attendee_id == user_id))
    if ticket is not None:
        code = "ACTIVE_TICKET_EXISTS" if ticket.status == "active" else "CLOSED_TICKET_EXISTS"
        raise api_error(409, code, "You already have a ticket for this event; repeat purchases are not supported")


def ensure_sale(db, event, actor_id):
    ensure_not_suspended(event)
    if event.status != "published":
        raise api_error(409, "EVENT_CANCELLED" if event.status == "cancelled" else "EVENT_NOT_PUBLISHED",
                        "Event is not open for demo checkout")
    state = activation_state(db, event, actor_id)
    if state["paid_sales_suspended"]:
        raise api_error(409, "PAID_SALES_SUSPENDED", "Paid sales are suspended")
    if not state["activated"]:
        raise api_error(409, "PAID_SALES_NOT_ACTIVATED", "Complete paid-sales activation first")


def own_order(db, order_id, user):
    order = db.get(Order, order_id)
    if order is None or order.buyer_id != user.id:
        raise api_error(404, "ORDER_NOT_FOUND", "Order not found")
    return order


@router.post("/events/{event_id}/orders", response_model=OrderRead, status_code=201)
def create_order(event_id: int, payload: OrderCreate, response: Response, db: DbSession, user: CurrentUser):
    event = lock_event(db, event_id)
    expire_event_orders(db, event_id)
    existing = db.scalar(select(Order).where(Order.buyer_id == user.id, Order.request_id == str(payload.request_id)))
    if existing is not None:
        if existing.event_id != event_id or existing.ticket_type_id != payload.ticket_type_id or \
                existing.attendee_name != payload.attendee_name or existing.attendee_email != str(payload.attendee_email):
            db.commit()  # persist expired reservations, without taking a new seat
            raise api_error(409, "IDEMPOTENCY_CONFLICT", "This request_id was used for another checkout")
        db.commit()
        response.status_code = 200
        return existing
    try:
        ensure_sale(db, event, user.id)
        reject_ticket(db, event_id, user.id)
        ensure_no_pending_order(db, event_id, user.id)
        kind = db.scalar(select(TicketType).where(TicketType.id == payload.ticket_type_id,
                                                 TicketType.event_id == event_id)
                         .execution_options(populate_existing=True))
        if kind is None:
            raise api_error(404, "TICKET_TYPE_NOT_FOUND", "Ticket type not found at this event")
        if kind.hidden:
            raise api_error(409, "TICKET_TYPE_HIDDEN", "Ticket type is hidden")
        if kind.price_tiyn == 0:
            raise api_error(409, "FREE_TICKET_USE_CLAIM", "Use the free ticket claim route")
        now = utcnow()
        if kind.sales_start and to_utc(kind.sales_start) > now:
            raise api_error(409, "TICKET_TYPE_SALES_NOT_STARTED", "Sales have not started")
        if kind.sales_end and to_utc(kind.sales_end) <= now:
            raise api_error(409, "TICKET_TYPE_SALES_ENDED", "Sales have ended")
        if kind.order_limit < 1:
            raise api_error(409, "ORDER_LIMIT_EXCEEDED", "This type does not allow a one-ticket order")
        if event.tickets_issued >= event.capacity:
            raise api_error(409, "SOLD_OUT", "No seats left")
        if kind.tickets_issued >= kind.quantity:
            raise api_error(409, "TICKET_TYPE_SOLD_OUT", "No seats left for this type")
    except HTTPException:
        # All validation precedes inventory writes. Only cleanup / activation history can commit here.
        db.commit()
        raise
    taken = db.execute(update(Event).where(Event.id == event_id, Event.status == "published",
                                          Event.suspended_at.is_(None), Event.tickets_issued < Event.capacity)
                       .values(tickets_issued=Event.tickets_issued + 1)).rowcount
    type_taken = db.execute(update(TicketType).where(TicketType.id == kind.id, TicketType.event_id == event_id,
                             TicketType.hidden.is_(False), TicketType.price_tiyn > 0, TicketType.order_limit >= 1,
                             TicketType.tickets_issued < TicketType.quantity,
                             or_(TicketType.sales_start.is_(None), TicketType.sales_start <= now),
                             or_(TicketType.sales_end.is_(None), TicketType.sales_end > now))
                            .values(tickets_issued=TicketType.tickets_issued + 1)).rowcount
    if not taken or not type_taken:
        db.rollback()
        raise api_error(409, "SOLD_OUT", "Inventory changed; retry checkout")
    order = Order(event_id=event_id, ticket_type_id=kind.id, buyer_id=user.id, request_id=str(payload.request_id),
                  attendee_name=payload.attendee_name, attendee_email=str(payload.attendee_email),
                  subtotal_tiyn=kind.price_tiyn, processing_fee_tiyn=processing_fee(kind.price_tiyn),
                  processing_fee_bps=PAYMENT_PROCESSING_FEE_BPS, total_tiyn=kind.price_tiyn,
                  expires_at=now + timedelta(minutes=15))
    db.add(order)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        # Same buyer/key used concurrently at another event; no seat is retained by this transaction.
        raise api_error(409, "IDEMPOTENCY_CONFLICT", "This request_id was already used")
    db.refresh(order)
    return order


@router.get("/orders/me", response_model=list[OrderRead])
def my_orders(db: DbSession, user: CurrentUser):
    event_ids = list(db.scalars(select(Order.event_id).where(Order.buyer_id == user.id, Order.status == "pending")))
    refresh_inventory(db, event_ids)
    return db.scalars(select(Order).where(Order.buyer_id == user.id).order_by(Order.id.desc())).all()


@router.get("/orders/{order_id}", response_model=OrderRead)
def read_order(order_id: int, db: DbSession, user: CurrentUser):
    order = own_order(db, order_id, user)
    refresh_inventory(db, [order.event_id])
    return own_order(db, order_id, user)


@router.post("/orders/{order_id}/pay", response_model=OrderRead)
def pay_order(order_id: int, payload: PaymentRequest, db: DbSession, user: CurrentUser):
    order = own_order(db, order_id, user)
    event = lock_event(db, order.event_id)
    db.refresh(order)
    expire_event_orders(db, event.id)
    if order.status == "expired":
        db.commit()
        raise api_error(409, "ORDER_EXPIRED", "Demo order expired; its reservation was released")
    if order.status != "pending":
        db.commit()
        return order  # first result wins, including a retry with a different outcome
    if payload.outcome == "failure":
        release_order(db, order, "failed")
        action = "order.failed"
    else:
        try:
            ensure_sale(db, event, user.id)
            reject_ticket(db, event.id, user.id)
        except HTTPException:
            db.commit()
            raise
        from app.routers.tickets import new_qr_payload
        ticket = Ticket(event_id=event.id, attendee_id=user.id, ticket_type_id=order.ticket_type_id,
                        qr_payload=new_qr_payload())
        db.add(ticket)
        db.flush()
        order.ticket_id = ticket.id
        order.status = "paid"
        order.completed_at = utcnow()
        action = "order.paid"
    record_action(db, event_id=event.id, actor_id=user.id, action=action, entity_type="order",
                  entity_id=order.id, description=f"Demo payment {order.status}: {order.total_tiyn} tiyn")
    db.commit()
    return order


@router.post("/orders/{order_id}/cancel", response_model=OrderRead)
def cancel_order(order_id: int, db: DbSession, user: CurrentUser):
    order = own_order(db, order_id, user)
    lock_event(db, order.event_id)
    db.refresh(order)
    expire_event_orders(db, order.event_id)
    release_order(db, order, "cancelled")
    db.commit()
    return order


@router.get("/events/{event_id}/orders/summary")
def orders_summary(event_id: int, db: DbSession, user: CurrentUser):
    event = lock_event(db, event_id)
    ensure_can_manage(event, user)
    expire_event_orders(db, event_id)
    gross, fees = db.execute(select(func.coalesce(func.sum(Order.total_tiyn), 0),
                                   func.coalesce(func.sum(Order.processing_fee_tiyn), 0))
                             .where(Order.event_id == event_id, Order.status == "paid")).one()
    db.commit()
    return {"event_id": event_id, "gross_sales_tiyn": gross, "processing_fees_tiyn": fees,
            "refunds_tiyn": 0, "estimated_payout_tiyn": gross - fees,
            "simulation": True, "demo_notice": DEMO_NOTICE}
