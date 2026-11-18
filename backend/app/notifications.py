"""In-app notifications with an email copy (BE-3a); messages for tickets, events and orders (BE-3b, BE-3c).

``notify`` adds the notification to the caller's transaction and queues its email on the session. The email goes
out only after that transaction commits, from a worker thread, so a rolled-back change sends nothing and a slow or
unreachable mail server never delays or fails the request.
"""
import logging
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from sqlalchemy import event, select
from sqlalchemy.orm import Session

from app import email
from app.demo_fees import DEMO_NOTICE
from app.models import Event, Notification, Ticket, TicketStatus, User
from app.models.order import Order
from app.ticket_pdf import build_ticket_pdf, venue_time

logger = logging.getLogger(__name__)

_PENDING = "pending_emails"

# Builds an attachment in the worker from its own session, so the caller's locks are not held while it renders.
AttachmentFactory = Callable[[Session], email.Attachment]

# One worker keeps emails in the order their changes committed.
# ponytail: in-process queue; emails queued when the process dies are lost (the notification row stays),
# and one worker sends one email at a time. A database-backed outbox lifts both limits.
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="email")
_submit = _executor.submit


def notify(
    db: Session,
    user: User,
    kind: str,
    title: str,
    body: str,
    link: Optional[str] = None,
    attachment: Optional[AttachmentFactory] = None,
) -> None:
    db.add(Notification(user_id=user.id, kind=kind, title=title, body=body, link=link))
    db.info.setdefault(_PENDING, []).append((db.get_bind(), user.email, title, body, attachment))


def notify_ticket_holders(db: Session, event_id: int, kind: str, title: str, body: str) -> None:
    """Notify everyone holding an active ticket for the event."""
    holders = db.scalars(
        select(User).join(Ticket, Ticket.attendee_id == User.id)
        .where(Ticket.event_id == event_id, Ticket.status == TicketStatus.ACTIVE.value)
        .order_by(User.id)
    ).all()
    for holder in holders:
        notify(db, holder, kind, title, body, link=f"/events/{event_id}")


def _deliver(bind, to: str, subject: str, body: str, attachment: Optional[AttachmentFactory]) -> None:
    try:
        file = None
        if attachment is not None:
            with Session(bind=bind) as session:
                file = attachment(session)
        email.send_email(to, subject, body, file)
    except Exception:  # a worker has no caller to report to
        logger.exception("Could not deliver email %r to %s", subject, to)


@event.listens_for(Session, "after_commit")
def _send_after_commit(session: Session) -> None:
    for pending in session.info.pop(_PENDING, []):
        _submit(_deliver, *pending)


@event.listens_for(Session, "after_rollback")
def _drop_after_rollback(session: Session) -> None:
    session.info.pop(_PENDING, None)


# ------------------------------------------------------------------ messages (BE-3b)
def _ticket_pdf(ticket_id: int) -> AttachmentFactory:
    def pdf(session: Session) -> email.Attachment:
        issued = session.get(Ticket, ticket_id)
        return f"biletflow-ticket-{ticket_id}.pdf", build_ticket_pdf(issued, session.get(User, issued.attendee_id))

    return pdf


def _when_where(event: Event) -> str:
    return f"Когда: {venue_time(event.date)}\nГде: {event.location}"


def _tenge(tiyn: int) -> str:
    return f"{tiyn // 100:,}".replace(",", "\u00a0") + f",{tiyn % 100:02d} ₸"


_SHOW_QR = "Билет с QR-кодом во вложении и в разделе «Мои билеты». Покажите QR-код на входе."


def ticket_issued(db: Session, user: User, ticket: Ticket, event: Event) -> None:
    """Call for a newly issued ticket only, never for a repeated claim that returns the existing one."""
    notify(
        db, user, "ticket.issued", f"Ваш билет: {event.title}",
        f"Билет на «{event.title}» оформлен.\n\n{_when_where(event)}\n\n{_SHOW_QR}",
        link=f"/tickets/{ticket.id}", attachment=_ticket_pdf(ticket.id),
    )


# Call these two only on the order's transition out of `pending`, so each order sends one email (BE-3c).
def order_paid(db: Session, user: User, order: Order, event: Event) -> None:
    notify(
        db, user, "order.paid", f"Заказ №{order.id} оплачен: {event.title}",
        f"Заказ №{order.id} на «{event.title}» оплачен: {_tenge(order.total_tiyn)}.\n{DEMO_NOTICE}.\n\n"
        f"{_when_where(event)}\n\n{_SHOW_QR}",
        link=f"/tickets/{order.ticket_id}", attachment=_ticket_pdf(order.ticket_id),
    )


def payment_failed(db: Session, user: User, order: Order, event: Event) -> None:
    notify(
        db, user, "payment.failed", f"Оплата заказа №{order.id} не прошла",
        f"Оплата заказа №{order.id} на «{event.title}» ({_tenge(order.total_tiyn)}) не прошла.\n{DEMO_NOTICE}.\n\n"
        "Место освобождено. Вы можете оформить заказ заново на странице события.",
        link=f"/events/{event.id}",
    )


def event_updated(db: Session, event_id: int, title: str, changes: list[str]) -> None:
    notify_ticket_holders(
        db, event_id, "event.updated", f"Изменения в событии «{title}»",
        "Организатор изменил событие, на которое у вас есть билет:\n\n" + "\n".join(changes)
        + "\n\nВаш билет остаётся действительным.",
    )


def event_cancelled(db: Session, event_id: int, title: str) -> None:
    notify_ticket_holders(
        db, event_id, "event.cancelled", f"Событие «{title}» отменено",
        f"Организатор отменил событие «{title}». Ваш билет больше не действует, вход по нему невозможен.",
    )
