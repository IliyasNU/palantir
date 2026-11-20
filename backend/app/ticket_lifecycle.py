"""Ticket closing shared by ticket-only actions and paid order refunds."""
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.audit import record_action
from app.db.base import utcnow
from app.errors import api_error
from app.models import Event, Ticket, TicketStatus, TicketType

TICKET_STATE_ERRORS = {
    TicketStatus.CANCELLED.value: ("TICKET_CANCELLED", "Ticket was cancelled"),
    TicketStatus.REFUNDED.value: ("TICKET_REFUNDED", "Ticket was refunded"),
}


def lock_ticket(db: Session, ticket_id: int) -> Ticket:
    """Call after locking the event, as in check-in and undo."""
    ticket = db.scalar(
        select(Ticket).where(Ticket.id == ticket_id).with_for_update(of=Ticket)
        .execution_options(populate_existing=True)
    )
    if ticket is None:
        raise api_error(404, "TICKET_NOT_FOUND", "Ticket not found")
    return ticket


def close_ticket(
    db: Session,
    ticket: Ticket,
    actor_id: int,
    target: TicketStatus,
    *,
    manager: bool,
    reconcile_paid_refund: bool = False,
) -> None:
    """Set the final state under the event and ticket locks. The caller owns the transaction."""
    if ticket.check_in is not None:
        raise api_error(409, "TICKET_CHECKED_IN", "The ticket is checked in; undo the check-in first")
    if ticket.status == target.value:
        return

    held_seat = ticket.status == TicketStatus.ACTIVE.value
    if not held_seat and not (reconcile_paid_refund and target == TicketStatus.REFUNDED):
        raise api_error(409, *TICKET_STATE_ERRORS[ticket.status])

    ticket.status = target.value
    ticket.status_changed_at = utcnow()
    ticket.status_changed_by_id = actor_id
    if held_seat:
        db.execute(
            update(Event).where(Event.id == ticket.event_id)
            .values(tickets_issued=Event.tickets_issued - 1)
            .execution_options(synchronize_session=False)
        )
        db.execute(
            update(TicketType).where(TicketType.id == ticket.ticket_type_id)
            .values(tickets_issued=TicketType.tickets_issued - 1)
            .execution_options(synchronize_session=False)
        )
    record_action(
        db, event_id=ticket.event_id, actor_id=actor_id, action=f"ticket.{target.value}", entity_type="ticket",
        entity_id=ticket.id,
        description=f"Ticket {target.value} by {'event management' if manager else 'its attendee'}",
    )
