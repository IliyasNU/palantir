"""Inventory helpers. All writers lock the event before touching one of its ticket types."""
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit import record_action
from app.db.base import utcnow
from app.errors import api_error
from app.models import Event, TicketType
from app.schemas.common import to_utc

DEFAULT_TYPE_NAME = "Бесплатный"


def lock_event(db: Session, event_id: int) -> Event:
    event = db.scalar(select(Event).where(Event.id == event_id).with_for_update()
                      .execution_options(populate_existing=True))
    if event is None:
        raise api_error(404, "EVENT_NOT_FOUND", "Event not found")
    return event


def create_default_type(db: Session, event: Event, actor_id: int) -> TicketType:
    ticket_type = TicketType(event_id=event.id, name=DEFAULT_TYPE_NAME, quantity=event.capacity, is_default=True)
    db.add(ticket_type)
    db.flush()
    record_action(db, event_id=event.id, actor_id=actor_id, action="ticket_type.created",
                  entity_type="ticket_type", entity_id=ticket_type.id, description="Created the default free ticket type")
    return ticket_type


def check_allocation(db: Session, event: Event, quantity: int, excluding: int | None = None) -> None:
    query = select(func.coalesce(func.sum(TicketType.quantity), 0)).where(TicketType.event_id == event.id)
    if excluding is not None:
        query = query.where(TicketType.id != excluding)
    if db.scalar(query) + quantity > event.capacity:
        raise api_error(409, "TICKET_TYPES_CAPACITY", "Ticket type quantities exceed the event capacity")


def resize_default_or_check_allocation(db: Session, event: Event, capacity: int, actor_id: int) -> None:
    """The untouched single default follows legacy capacity edits; configured allocations never silently change."""
    types = db.scalars(select(TicketType).where(TicketType.event_id == event.id)).all()
    if len(types) == 1 and types[0].is_default and types[0].quantity == event.capacity:
        ticket_type = types[0]
        old = ticket_type.quantity
        ticket_type.quantity = capacity
        if old != capacity:
            record_action(db, event_id=event.id, actor_id=actor_id, action="ticket_type.updated",
                          entity_type="ticket_type", entity_id=ticket_type.id,
                          description=f"quantity: {old} -> {capacity} (event capacity)")
    elif sum(ticket_type.quantity for ticket_type in types) > capacity:
        raise api_error(409, "TICKET_TYPES_CAPACITY", "Capacity cannot be lower than allocated ticket quantities")


def select_claim_type(db: Session, event_id: int, ticket_type_id: int | None) -> TicketType:
    """Called after claim_ticket's unchanged event UPDATE, so it already owns the event lock."""
    query = select(TicketType).where(TicketType.event_id == event_id).execution_options(populate_existing=True)
    if ticket_type_id is None:
        choices = db.scalars(query.where(TicketType.hidden.is_(False), TicketType.price_tiyn == 0)).all()
        if len(choices) != 1:
            raise api_error(422, "TICKET_TYPE_REQUIRED", "Choose a ticket type explicitly")
        ticket_type = choices[0]
    else:
        ticket_type = db.scalar(query.where(TicketType.id == ticket_type_id))
        if ticket_type is None:
            raise api_error(404, "TICKET_TYPE_NOT_FOUND", "Ticket type not found at this event")
    if ticket_type.hidden:
        raise api_error(409, "TICKET_TYPE_HIDDEN", "Ticket type is hidden")
    if ticket_type.price_tiyn:
        raise api_error(409, "PAID_TICKETS_NOT_SUPPORTED", "Use POST /events/{id}/orders for simulated paid checkout")
    now = utcnow()
    if ticket_type.sales_start is not None and to_utc(ticket_type.sales_start) > now:
        raise api_error(409, "TICKET_TYPE_SALES_NOT_STARTED", "Sales have not started for this ticket type")
    if ticket_type.sales_end is not None and to_utc(ticket_type.sales_end) <= now:
        raise api_error(409, "TICKET_TYPE_SALES_ENDED", "Sales have ended for this ticket type")
    return ticket_type
