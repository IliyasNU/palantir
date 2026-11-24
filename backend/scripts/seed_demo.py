"""Add a disposable set of BiletFlow demo data to a migrated local database."""
import os
import secrets
import sys
from datetime import datetime, timedelta
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import record_action
from app.auth.security import hash_password
from app.campaigns import discount_for
from app.core.config import get_settings
from app.db.base import utcnow
from app.db.seed import seed_roles
from app.demo_fees import PAID_SALES_ACTIVATION_FEE_TIYN, PAYMENT_PROCESSING_FEE_BPS, processing_fee
from app.models import ActionLog, CheckIn, Event, EventStaff, EventStatus, OrganizerProfile, Role, RoleName
from app.models import Ticket, TicketStatus, TicketType, User
from app.models.campaign import Campaign, CampaignType
from app.models.order import Order, PaidSalesActivation
from app.models.support import MessageSide, SupportCase, SupportCaseKind, SupportCaseStatus, SupportMessage
from app.ticket_types import create_default_type

DEMO_ACCOUNTS = {
    "admin": ("Demo Platform Admin", RoleName.ADMIN),
    "organizer-a": ("Demo Organizer A", RoleName.ORGANIZER),
    "organizer-b": ("Demo Organizer B", RoleName.ORGANIZER),
    "staff": ("Demo Door Staff", RoleName.ATTENDEE),
    "attendee-a": ("Demo Attendee A", RoleName.ATTENDEE),
    "attendee-b": ("Demo Attendee B", RoleName.ATTENDEE),
    "attendee-c": ("Demo Attendee C", RoleName.ATTENDEE),
}
SEED_ACTION = "demo.seeded"


class DemoSeedCollision(Exception):
    """One of the demo emails already belongs to an existing account."""


def _email(name: str) -> str:
    return f"biletflow-demo-{name}@example.com"


def _accounts(db: Session, passwords: dict[str, str], created_at: datetime) -> dict[str, User]:
    # Migrations normally provide these reference rows. The helper commits only if roles were missing.
    seed_roles(db)
    roles = {role.name: role for role in db.scalars(select(Role))}
    users = {}
    for name, (full_name, role) in DEMO_ACCOUNTS.items():
        user = User(
            email=_email(name), full_name=full_name, role=roles[role.value],
            hashed_password=hash_password(passwords[name]), email_verified_at=created_at, created_at=created_at,
        )
        if role == RoleName.ORGANIZER:
            user.organizer_profile = OrganizerProfile(
                organization_name=f"{full_name} Events", contact_email=user.email,
                demo_identity_confirmed_at=created_at, demo_payout_last4="4242", created_at=created_at,
            )
        users[name] = user
    db.add_all(users.values())
    db.flush()
    return users


def _event(
    db: Session, owner: User, name: str, starts: datetime, *, status: EventStatus = EventStatus.PUBLISHED,
) -> tuple[Event, TicketType]:
    created_at = starts - timedelta(days=14)
    event = Event(
        organizer_id=owner.id, title=f"Demo | {name}", description="BiletFlow demonstration event.",
        date=starts, location="Astana Demo Hall", capacity=40, status=status.value, created_at=created_at,
    )
    db.add(event)
    db.flush()
    record_action(db, event_id=event.id, actor_id=owner.id, action="event.created",
                  entity_type="event", entity_id=event.id, description="Created a demo event")
    free = create_default_type(db, event, owner.id)
    free.created_at = created_at
    if status != EventStatus.DRAFT:
        record_action(db, event_id=event.id, actor_id=owner.id, action="event.published",
                      entity_type="event", entity_id=event.id, description="Published the demo event")
    if status == EventStatus.CANCELLED:
        record_action(db, event_id=event.id, actor_id=owner.id, action="event.cancelled",
                      entity_type="event", entity_id=event.id, description="Cancelled the demo event")
    return event, free


def _ticket(db: Session, event: Event, kind: TicketType, attendee: User, when: datetime) -> Ticket:
    from app.routers.tickets import new_qr_payload, record_free_order

    ticket = Ticket(
        event_id=event.id, ticket_type_id=kind.id, attendee_id=attendee.id,
        qr_payload=new_qr_payload(), created_at=when,
    )
    event.tickets_issued += 1
    kind.tickets_issued += 1
    db.add(ticket)
    db.flush()
    record_action(db, event_id=event.id, actor_id=attendee.id, action="ticket.issued",
                  entity_type="ticket", entity_id=ticket.id, description="Issued a demo ticket")
    if kind.price_tiyn == 0:
        record_free_order(db, ticket, attendee)
    return ticket


def _check_in(db: Session, ticket: Ticket, staff: User, when: datetime) -> None:
    check_in = CheckIn(
        event_id=ticket.event_id, ticket_id=ticket.id, staff_id=staff.id,
        checked_in_at=when, request_id=uuid4(),
    )
    db.add(check_in)
    db.flush()
    record_action(db, event_id=ticket.event_id, actor_id=staff.id, action="check_in.created",
                  entity_type="check_in", entity_id=check_in.id, description="Recorded a demo admission")


def _paid_sales(db: Session, event: Event, free: TicketType, owner: User, now: datetime) -> tuple[TicketType, Campaign]:
    free.quantity = 20
    paid = TicketType(event_id=event.id, name="Demo Premium", price_tiyn=250_000, quantity=20, created_at=now)
    promo = Campaign(
        event_id=event.id, name="Demo 20% off", code="BF-" + secrets.token_hex(6).upper(),
        token="pc_" + secrets.token_hex(16), kind="percent", value=20, max_uses=10, enabled=True,
    )
    db.add_all([paid, promo, PaidSalesActivation(
        event_id=event.id, terms_accepted_at=now, fee_paid_at=now,
        fee_tiyn=PAID_SALES_ACTIVATION_FEE_TIYN, activated_at=now,
    )])
    db.flush()
    db.add(CampaignType(campaign_id=promo.id, ticket_type_id=paid.id))
    record_action(db, event_id=event.id, actor_id=owner.id, action="ticket_type.created",
                  entity_type="ticket_type", entity_id=paid.id, description="Created a paid demo ticket type")
    record_action(db, event_id=event.id, actor_id=owner.id, action="paid_sales.terms_accepted",
                  entity_type="event", entity_id=event.id, description="Accepted simulated paid sales terms")
    record_action(db, event_id=event.id, actor_id=owner.id, action="paid_sales.fee_paid",
                  entity_type="event", entity_id=event.id, description="Paid the simulated activation fee")
    record_action(db, event_id=event.id, actor_id=owner.id, action="paid_sales.activated",
                  entity_type="event", entity_id=event.id, description="Activated simulated paid sales")
    record_action(db, event_id=event.id, actor_id=owner.id, action="campaign.created",
                  entity_type="campaign", entity_id=promo.id, description="Created the demo promotion")
    return paid, promo


def _paid_order(
    db: Session, event: Event, paid: TicketType, buyer: User, now: datetime, *, campaign: Campaign | None = None,
) -> Order:
    discount = discount_for(campaign, paid.price_tiyn)
    total = paid.price_tiyn - discount
    ticket = _ticket(db, event, paid, buyer, now)
    order = Order(
        event_id=event.id, ticket_type_id=paid.id, ticket_id=ticket.id,
        buyer_id=buyer.id, attendee_name=buyer.full_name, attendee_email=buyer.email,
        request_id=str(uuid4()), status="paid", discount_tiyn=discount, subtotal_tiyn=paid.price_tiyn,
        processing_fee_tiyn=processing_fee(total), processing_fee_bps=PAYMENT_PROCESSING_FEE_BPS,
        total_tiyn=total, campaign_id=campaign.id if campaign else None, promo_code=campaign.code if campaign else None,
        created_at=now, completed_at=now, expires_at=now + timedelta(minutes=15),
    )
    db.add(order)
    db.flush()
    record_action(db, event_id=event.id, actor_id=buyer.id, action="order.paid", entity_type="order",
                  entity_id=order.id, description=f"Demo payment paid: {total} tiyn")
    return order


def _support_case(db: Session, order: Order, requester: User, owner: User, now: datetime) -> None:
    opened_at = now - timedelta(minutes=2)
    case = SupportCase(
        kind=SupportCaseKind.ATTENDEE.value, requester_id=requester.id,
        event_id=order.event_id, order_id=order.id, ticket_id=order.ticket_id,
        category="check_in", subject="Where is the entrance?", status=SupportCaseStatus.IN_PROGRESS.value,
        assignee_id=owner.id, created_at=opened_at, updated_at=now,
        last_message_at=now, last_message_by=MessageSide.REQUESTER.value,
    )
    db.add(case)
    db.flush()
    db.add_all([
        SupportMessage(case_id=case.id, author_id=requester.id, author_side=MessageSide.REQUESTER.value,
                       body="Where should I show my QR ticket?", created_at=opened_at),
        SupportMessage(case_id=case.id, author_id=owner.id, author_side=MessageSide.STAFF.value,
                       body="Please use the main entrance and open your ticket QR.",
                       created_at=now - timedelta(minutes=1)),
        SupportMessage(case_id=case.id, author_id=requester.id, author_side=MessageSide.REQUESTER.value,
                       body="Thanks, I found the entrance on the map.", created_at=now),
    ])
    record_action(db, event_id=order.event_id, actor_id=requester.id, action="support_case.opened",
                  entity_type="support_case", entity_id=case.id, description="Opened a demo support case")
    record_action(db, event_id=order.event_id, actor_id=owner.id, action="support_case.assigned",
                  entity_type="support_case", entity_id=case.id, description=f"Assigned to user {owner.id}")
    record_action(db, event_id=order.event_id, actor_id=owner.id, action="support_case.status_changed",
                  entity_type="support_case", entity_id=case.id, description="status: open -> in_progress")


def _seed(db: Session) -> dict[str, str]:
    from app.routers.admin import apply_event_suspension
    from app.routers.orders import event_orders_access, refund_paid_order

    existing = dict(db.execute(select(User.email, User.id).where(
        User.email.in_([_email(name) for name in DEMO_ACCOUNTS]),
    )).all())
    admin_id = existing.get(_email("admin"))
    if admin_id is not None and db.scalar(select(ActionLog.id).where(
        ActionLog.actor_id == admin_id, ActionLog.action == SEED_ACTION,
    ).limit(1)) is not None:
        return {}
    if existing:
        raise DemoSeedCollision("A reserved demo email already exists. Use a fresh local database.")

    now = utcnow()
    passwords = {name: secrets.token_urlsafe(18) for name in DEMO_ACCOUNTS}
    users = _accounts(db, passwords, now - timedelta(days=30))
    admin, owner, other_owner, staff = (users[name] for name in ("admin", "organizer-a", "organizer-b", "staff"))
    first, second, third = (users[name] for name in ("attendee-a", "attendee-b", "attendee-c"))
    future = now + timedelta(days=7)
    _event(db, owner, "Draft", future, status=EventStatus.DRAFT)
    _event(db, other_owner, "Cancelled", future, status=EventStatus.CANCELLED)
    suspended, _ = _event(db, other_owner, "Suspended", future)
    apply_event_suspension(db, suspended.id, admin.id, "Demonstrate platform moderation")

    upcoming, free = _event(db, owner, "Upcoming checkout", future)
    paid, campaign = _paid_sales(db, upcoming, free, owner, now - timedelta(hours=1))
    order = _paid_order(db, upcoming, paid, first, now - timedelta(minutes=15), campaign=campaign)
    _paid_order(db, upcoming, paid, second, now - timedelta(minutes=10))
    refunded_order = _paid_order(db, upcoming, paid, third, now - timedelta(minutes=5))
    locked_event = event_orders_access(db, upcoming.id, owner)
    refund_paid_order(db, locked_event, refunded_order, owner)
    _support_case(db, order, first, owner, now)

    active, free = _event(db, owner, "Active check-in", now - timedelta(hours=1))
    db.add(EventStaff(event_id=active.id, user_id=staff.id))
    record_action(db, event_id=active.id, actor_id=owner.id, action="staff.assigned",
                  entity_type="user", entity_id=staff.id, description="Assigned the demo door staff")
    admitted = _ticket(db, active, free, first, now - timedelta(hours=2))
    _ticket(db, active, free, second, now - timedelta(hours=2))
    refunded = _ticket(db, active, free, third, now - timedelta(hours=2))
    refunded.status = TicketStatus.REFUNDED.value
    refunded.status_changed_at = now - timedelta(minutes=30)
    refunded.status_changed_by_id = owner.id
    active.tickets_issued -= 1
    free.tickets_issued -= 1
    record_action(db, event_id=active.id, actor_id=owner.id, action="ticket.refunded",
                  entity_type="ticket", entity_id=refunded.id, description="Marked the demo admission as refunded")
    _check_in(db, admitted, staff, now - timedelta(minutes=15))

    past_start = now - timedelta(days=3)
    past, free = _event(db, other_owner, "Past check-in", past_start)
    historical = _ticket(db, past, free, third, past_start - timedelta(hours=1))
    _check_in(db, historical, other_owner, past_start + timedelta(minutes=15))
    record_action(db, event_id=None, actor_id=admin.id, action=SEED_ACTION,
                  entity_type="user", entity_id=admin.id, description="Created the local BiletFlow demo dataset")
    db.commit()
    return passwords


def main() -> int:
    if os.environ.get("ENVIRONMENT") == "production" or get_settings().environment == "production":
        print("The BiletFlow demo seed is disabled in production.", file=sys.stderr)
        return 2

    from app.db.session import SessionLocal

    with SessionLocal() as db:
        try:
            passwords = _seed(db)
        except DemoSeedCollision as exc:
            print(str(exc), file=sys.stderr)
            return 2

    if passwords:
        print("Created BiletFlow demo data. Save these local demo credentials:")
        for name, password in passwords.items():
            print(f"  {name}: {_email(name)} / {password}")
    else:
        print("BiletFlow demo data is already installed. Credentials are unchanged.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
