"""Ticket types and the read-only event action journal."""
from fastapi import APIRouter, status
from sqlalchemy import select

from app.audit import read_actions, record_action
from app.dependencies.action_log import LogFilters
from app.dependencies.auth import CurrentUser, OptionalUser
from app.dependencies.db import DbSession
from app.dependencies.events import ensure_can_manage, get_event_or_404, is_visible
from app.errors import api_error
from app.models import TicketType
from app.schemas.common import to_utc
from app.schemas.ticket_type import ActionLogRead, TicketTypeCreate, TicketTypeRead, TicketTypeUpdate
from app.ticket_types import check_allocation, lock_event
from app.order_inventory import expire_event_orders, refresh_inventory
from app.paid_sales import activation_state

router = APIRouter(tags=["ticket types"])


@router.get("/events/{event_id}/ticket-types", response_model=list[TicketTypeRead])
def list_ticket_types(event_id: int, db: DbSession, current_user: OptionalUser):
    event = get_event_or_404(db, event_id)
    if not is_visible(event, current_user):
        raise api_error(404, "EVENT_NOT_FOUND", "Event not found")
    refresh_inventory(db, [event_id])
    return db.scalars(select(TicketType).where(TicketType.event_id == event_id, TicketType.hidden.is_(False))
                      .order_by(TicketType.id)).all()


@router.get("/events/{event_id}/ticket-types/manage", response_model=list[TicketTypeRead])
def manage_ticket_types(event_id: int, db: DbSession, current_user: CurrentUser):
    event = get_event_or_404(db, event_id)
    ensure_can_manage(event, current_user)
    refresh_inventory(db, [event_id])
    return db.scalars(select(TicketType).where(TicketType.event_id == event_id).order_by(TicketType.id)).all()


@router.post("/events/{event_id}/ticket-types", response_model=TicketTypeRead, status_code=status.HTTP_201_CREATED)
def create_ticket_type(event_id: int, payload: TicketTypeCreate, db: DbSession, current_user: CurrentUser):
    event = get_event_or_404(db, event_id)
    ensure_can_manage(event, current_user)
    if payload.event_id is not None and payload.event_id != event_id:
        raise api_error(404, "EVENT_NOT_FOUND", "Ticket type event does not match the route")
    event = lock_event(db, event_id)
    expire_event_orders(db, event_id)
    check_allocation(db, event, payload.quantity)
    ticket_type = TicketType(event_id=event_id, **payload.model_dump(exclude={"event_id"}))
    db.add(ticket_type)
    db.flush()
    record_action(db, event_id=event_id, actor_id=current_user.id, action="ticket_type.created",
                  entity_type="ticket_type", entity_id=ticket_type.id,
                  description=f"Created ticket type {ticket_type.name}: price_tiyn={ticket_type.price_tiyn}, "
                              f"quantity={ticket_type.quantity}, hidden={ticket_type.hidden}")
    activation_state(db, event, current_user.id)
    db.commit()
    db.refresh(ticket_type)
    return ticket_type


@router.patch("/events/{event_id}/ticket-types/{type_id}", response_model=TicketTypeRead)
def update_ticket_type(event_id: int, type_id: int, payload: TicketTypeUpdate, db: DbSession, current_user: CurrentUser):
    event = get_event_or_404(db, event_id)
    ensure_can_manage(event, current_user)
    event = lock_event(db, event_id)
    expire_event_orders(db, event_id)
    ticket_type = db.scalar(select(TicketType).where(TicketType.id == type_id, TicketType.event_id == event_id)
                            .with_for_update().execution_options(populate_existing=True))
    if ticket_type is None:
        raise api_error(404, "TICKET_TYPE_NOT_FOUND", "Ticket type not found at this event")
    changes = payload.model_dump(exclude_unset=True)
    quantity = changes.get("quantity", ticket_type.quantity)
    if quantity < ticket_type.tickets_issued:
        raise api_error(409, "TICKET_TYPE_BELOW_ISSUED", "Quantity cannot be lower than active tickets already issued")
    check_allocation(db, event, quantity, excluding=ticket_type.id)
    start = changes.get("sales_start", ticket_type.sales_start)
    end = changes.get("sales_end", ticket_type.sales_end)
    if start is not None and end is not None and to_utc(start) >= to_utc(end):
        raise api_error(422, "INVALID_INPUT", "sales_start must be before sales_end")
    changed = [field for field, value in changes.items() if getattr(ticket_type, field) != value]
    # Keep inventory changes visible even when a new name/description is very long.
    priority = ("price_tiyn", "quantity", "hidden", "order_limit", "sales_start", "sales_end", "name", "description")
    description = "; ".join(
        f"{field}: {getattr(ticket_type, field)} -> {changes[field]}"
        if field not in ("name", "description") else f"{field}: changed"
        for field in priority if field in changed
    )
    for field, value in changes.items():
        setattr(ticket_type, field, value)
    if changed:
        record_action(db, event_id=event_id, actor_id=current_user.id, action="ticket_type.updated",
                      entity_type="ticket_type", entity_id=ticket_type.id, description=description)
    db.flush()
    activation_state(db, event, current_user.id)
    db.commit()
    db.refresh(ticket_type)
    return ticket_type


@router.get("/events/{event_id}/action-log", response_model=list[ActionLogRead])
def read_action_log(event_id: int, db: DbSession, current_user: CurrentUser, filters: LogFilters):
    """The event's timeline, newest first (its organizer or an admin). Optional date, action and paging filters."""
    event = get_event_or_404(db, event_id)
    ensure_can_manage(event, current_user)
    return read_actions(
        db, event_id=event.id, date_from=filters.date_from, date_to=filters.date_to, action=filters.action,
        limit=filters.limit, offset=filters.offset,
    )
