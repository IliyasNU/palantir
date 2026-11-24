"""Simulated checkout and refunds. Lock the event before reading mutable order or ticket state."""
from datetime import date, timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import notifications
from app.analytics import event_analytics, sales_amounts
from app.audit import record_action
from app.campaigns import discount_for, validate_campaign
from app.db.base import utcnow
from app.demo_fees import DEMO_NOTICE, PAYMENT_PROCESSING_FEE_BPS, processing_fee
from app.dependencies.auth import CurrentUser
from app.dependencies.db import DbSession
from app.dependencies.events import can_manage, ensure_can_manage, ensure_not_suspended, get_event_or_404
from app.errors import api_error
from app.models import CheckIn, Event, EventStatus, Ticket, TicketStatus, TicketType, User
from app.models.order import Order
from app.order_inventory import ensure_no_pending_order, expire_event_orders, refresh_inventory, release_order
from app.paid_sales import activation_state
from app.schemas.common import to_utc
from app.schemas.analytics import EventAnalyticsRead
from app.schemas.order import BulkRefundRead, EventOrdersRead, OrderCreate, OrderRead, PaymentRequest
from app.ticket_lifecycle import close_ticket, lock_ticket
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
                existing.attendee_name != payload.attendee_name or existing.attendee_email != str(payload.attendee_email) or \
                existing.promo_code != payload.promo_code:
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
        campaign = validate_campaign(db, event_id, payload.promo_code, kind) if payload.promo_code else None
        discount = discount_for(campaign, kind.price_tiyn)
        total = kind.price_tiyn - discount
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
                  campaign_id=campaign.id if campaign else None, promo_code=campaign.code if campaign else None,
                  discount_tiyn=discount, subtotal_tiyn=kind.price_tiyn, processing_fee_tiyn=processing_fee(total),
                  processing_fee_bps=PAYMENT_PROCESSING_FEE_BPS, total_tiyn=total,
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
        notifications.payment_failed(db, user, order, event)
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
        notifications.order_paid(db, user, order, event)
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
    paid = Order.status == "paid"
    refunded = Order.status == "refunded"
    gross, discounts, refunds, fees = db.execute(
        select(
            func.coalesce(func.sum(Order.subtotal_tiyn).filter(or_(paid, refunded)), 0),
            func.coalesce(func.sum(Order.discount_tiyn).filter(or_(paid, refunded)), 0),
            func.coalesce(func.sum(Order.total_tiyn).filter(refunded), 0),
            func.coalesce(func.sum(Order.processing_fee_tiyn).filter(paid), 0),
        ).where(Order.event_id == event_id)
    ).one()
    db.commit()
    return {"event_id": event_id, **sales_amounts(gross, discounts, refunds, fees),
            "simulation": True, "demo_notice": DEMO_NOTICE}


@router.get("/events/{event_id}/analytics", response_model=EventAnalyticsRead)
def read_analytics(event_id: int, db: DbSession, user: CurrentUser,
                   ticket_type_id: Annotated[int | None, Query(ge=1, le=2147483647)] = None,
                   date_from: date | None = None, date_to: date | None = None):
    event = get_event_or_404(db, event_id)
    if not can_manage(event, user):
        raise api_error(404, "EVENT_NOT_FOUND", "Event not found")
    return event_analytics(db, event, ticket_type_id, date_from, date_to)


def event_orders_access(db: Session, event_id: int, user: User) -> Event:
    event = lock_event(db, event_id)
    ensure_can_manage(event, user)
    ensure_not_suspended(event)
    return event


@router.get("/events/{event_id}/orders/manage", response_model=EventOrdersRead)
def manage_event_orders(event_id: int, db: DbSession, user: CurrentUser):
    event_orders_access(db, event_id, user)
    expire_event_orders(db, event_id)

    orders = db.scalars(select(Order).where(Order.event_id == event_id, Order.subtotal_tiyn > 0).order_by(Order.id.desc())).all()
    has_order = select(Order.id).where(Order.ticket_id == Ticket.id, Order.subtotal_tiyn > 0).exists()
    free_registrations = db.execute(
        select(
            Ticket.id, User.full_name.label("attendee_name"), User.email.label("attendee_email"),
            Ticket.status, Ticket.ticket_type_id, CheckIn.checked_in_at,
        )
        .join(User, User.id == Ticket.attendee_id)
        .outerjoin(CheckIn, and_(CheckIn.ticket_id == Ticket.id, CheckIn.undone_at.is_(None)))
        .where(Ticket.event_id == event_id, ~has_order)
        .order_by(Ticket.id.desc())
    ).mappings().all()
    db.commit()
    return {"orders": orders, "free_registrations": free_registrations}


def refund_paid_order(db: Session, event: Event, order: Order, actor: User) -> None:
    """Refund inside the caller's transaction while holding the event lock."""
    if order.subtotal_tiyn == 0:
        raise api_error(409, "FREE_REGISTRATION", "Cancel the free registration through its ticket")
    if order.status == "refunded":
        return
    if order.status != "paid" or order.ticket_id is None:
        raise api_error(409, "ORDER_NOT_PAID", "Only a paid order can be refunded")

    ticket = lock_ticket(db, order.ticket_id)
    if ticket.event_id != event.id or ticket.attendee_id != order.buyer_id:
        raise api_error(409, "ORDER_TICKET_MISMATCH", "The issued ticket does not match this order")
    # An order may still be paid if the legacy ticket endpoint closed its ticket before P5.
    close_ticket(db, ticket, actor.id, TicketStatus.REFUNDED, manager=True, reconcile_paid_refund=True)
    order.status = "refunded"
    order.refunded_at = utcnow()
    record_action(
        db, event_id=event.id, actor_id=actor.id, action="order.refunded", entity_type="order",
        entity_id=order.id, description=f"Full demo refund: {order.total_tiyn} tiyn",
    )
    notifications.refund_completed(db, db.get(User, order.buyer_id), order, event)


@router.post("/events/{event_id}/orders/{order_id}/refund", response_model=OrderRead)
def refund_order(event_id: int, order_id: int, db: DbSession, user: CurrentUser):
    event = event_orders_access(db, event_id, user)
    order = db.scalar(select(Order).where(Order.id == order_id, Order.event_id == event_id))
    if order is None:
        raise api_error(404, "ORDER_NOT_FOUND", "Order not found at this event")
    refund_paid_order(db, event, order, user)
    db.commit()
    return order


@router.post("/events/{event_id}/orders/refund-all", response_model=BulkRefundRead)
def refund_all_orders(event_id: int, db: DbSession, user: CurrentUser):
    event = event_orders_access(db, event_id, user)
    if event.status != EventStatus.CANCELLED.value:
        raise api_error(409, "EVENT_NOT_CANCELLED", "Bulk refunds require a cancelled event")
    orders = db.scalars(select(Order).where(Order.event_id == event_id, Order.status == "paid", Order.subtotal_tiyn > 0).order_by(Order.id)).all()
    try:
        for order in orders:
            refund_paid_order(db, event, order, user)
    except HTTPException:
        # Roll back both any prior refunds and the notifications queued on this session.
        db.rollback()
        raise
    db.commit()
    return {"refunded_count": len(orders), "refunds_tiyn": sum(order.total_tiyn for order in orders)}
