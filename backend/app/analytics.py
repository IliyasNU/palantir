"""Read-only event rollups from completed orders, tickets and active check-ins."""
from collections import defaultdict
from datetime import date, datetime, time, timezone

from sqlalchemy import and_, case, func, literal, or_, select, union_all
from sqlalchemy.orm import Session

from app.db.base import utcnow
from app.errors import api_error
from app.models import CheckIn, Event, Order, Ticket, TicketType
from app.models.campaign import Campaign

MEASURES = ("sold", "checked_in", "redemptions", "gross", "discounts", "refunds", "fees")


def sales_amounts(gross: int, discounts: int, refunds: int, fees: int) -> dict[str, int]:
    charged = gross - discounts
    net = charged - refunds
    return {
        "gross_before_discount_tiyn": gross,
        "discounts_tiyn": discounts,
        "gross_sales_tiyn": charged,  # The existing P2 field is the amount actually charged.
        "refunds_tiyn": refunds,
        "net_sales_tiyn": net,
        "processing_fees_tiyn": fees,
        "estimated_payout_tiyn": net - fees,
    }


def _day(db: Session, timestamp):
    # Session timezone can differ from UTC on PostgreSQL. SQLite stores these columns in UTC.
    if db.get_bind().dialect.name == "postgresql":
        timestamp = func.timezone("UTC", timestamp)
    return func.date(timestamp)


def _period(timestamp, date_from: date | None, date_to: date | None):
    bounds = []
    if date_from is not None:
        bounds.append(timestamp >= datetime.combine(date_from, time.min, timezone.utc))
    if date_to is not None:
        bounds.append(timestamp <= datetime.combine(date_to, time.max, timezone.utc))
    return bounds


def _daily_groups(db: Session, event_id: int, ticket_type_id: int | None,
                  date_from: date | None, date_to: date | None):
    paid = Order.status == "paid"
    valid_ticket = and_(paid, Ticket.status == "active")
    admitted = and_(CheckIn.ticket_id == Ticket.id, CheckIn.undone_at.is_(None))
    paid_at = func.coalesce(Order.completed_at, Order.created_at)
    order_rows = (
        select(
            _day(db, paid_at).label("day"), Order.ticket_type_id.label("type_id"), Order.campaign_id,
            case((valid_ticket, 1), else_=0).label("sold"),
            case((and_(valid_ticket, CheckIn.id.is_not(None)), 1), else_=0).label("checked_in"),
            case((and_(paid, Order.campaign_id.is_not(None)), 1), else_=0).label("redemptions"),
            Order.subtotal_tiyn.label("gross"), Order.discount_tiyn.label("discounts"),
            case((Order.status == "refunded", Order.total_tiyn), else_=0).label("refunds"),
            case((paid, Order.processing_fee_tiyn), else_=0).label("fees"),
        ).select_from(Order)
        .join(Ticket, Ticket.id == Order.ticket_id)
        .outerjoin(CheckIn, admitted)
        .where(Order.event_id == event_id, Order.status.in_(("paid", "refunded")), Order.subtotal_tiyn > 0,
               *_period(paid_at, date_from, date_to))
    )
    free_rows = (
        select(
            _day(db, Ticket.created_at).label("day"), Ticket.ticket_type_id, literal(None),
            literal(1), case((CheckIn.id.is_not(None), 1), else_=0),
            literal(0), literal(0), literal(0), literal(0), literal(0),
        ).select_from(Ticket)
        .outerjoin(CheckIn, admitted)
        .where(Ticket.event_id == event_id, Ticket.status == "active",
               ~select(Order.id).where(Order.ticket_id == Ticket.id, Order.subtotal_tiyn > 0).exists(),
               *_period(Ticket.created_at, date_from, date_to))
    )
    if ticket_type_id is not None:
        order_rows = order_rows.where(Order.ticket_type_id == ticket_type_id)
        free_rows = free_rows.where(Ticket.ticket_type_id == ticket_type_id)
    facts = union_all(order_rows, free_rows).subquery()
    keys = (facts.c.day, facts.c.type_id, facts.c.campaign_id)
    return db.execute(
        select(*keys, *(func.sum(facts.c[name]).label(name) for name in MEASURES))
        .group_by(*keys).order_by(facts.c.day)
    ).mappings()


def _occupancy(db: Session, event_id: int, ticket_type_id: int | None) -> int:
    tickets = select(func.count()).select_from(Ticket).where(Ticket.event_id == event_id, Ticket.status == "active")
    holds = select(func.count()).select_from(Order).where(
        Order.event_id == event_id, Order.status == "pending", Order.expires_at > utcnow(),
    )
    if ticket_type_id is not None:
        tickets = tickets.where(Ticket.ticket_type_id == ticket_type_id)
        holds = holds.where(Order.ticket_type_id == ticket_type_id)
    return db.scalar(select(tickets.scalar_subquery() + holds.scalar_subquery()))


def _metrics(values: dict[str, int]) -> dict[str, int]:
    return {
        "sold": values["sold"],
        "checked_in": values["checked_in"],
        **sales_amounts(values["gross"], values["discounts"], values["refunds"], values["fees"]),
    }


def _rate(part: int, whole: int) -> float:
    return round(100 * part / whole, 2) if whole else 0.0


def event_analytics(db: Session, event: Event, ticket_type_id: int | None,
                    date_from: date | None, date_to: date | None) -> dict:
    if date_from is not None and date_to is not None and date_from > date_to:
        raise api_error(422, "INVALID_DATE_RANGE", "Start date must not follow end date")
    kinds = select(TicketType.id, TicketType.name, TicketType.quantity).where(TicketType.event_id == event.id)
    if ticket_type_id is not None:
        kinds = kinds.where(TicketType.id == ticket_type_id)
    kinds = db.execute(kinds.order_by(TicketType.id)).all()
    if ticket_type_id is not None and not kinds:
        raise api_error(404, "TICKET_TYPE_NOT_FOUND", "Ticket type not found at this event")
    capacity = event.capacity if ticket_type_id is None else kinds[0].quantity

    total = dict.fromkeys(MEASURES, 0)
    by_day = defaultdict(lambda: dict.fromkeys(MEASURES, 0))
    by_type = defaultdict(lambda: dict.fromkeys(MEASURES, 0))
    by_campaign = defaultdict(lambda: dict.fromkeys(MEASURES, 0))
    for row in _daily_groups(db, event.id, ticket_type_id, date_from, date_to):
        groups = [total, by_day[str(row["day"])], by_type[row["type_id"]]]
        if row["campaign_id"] is not None:
            groups.append(by_campaign[row["campaign_id"]])
        for group in groups:
            for name in MEASURES:
                group[name] += row[name]

    campaigns = db.execute(select(Campaign.id, Campaign.name).where(Campaign.event_id == event.id)
                           .order_by(Campaign.id))
    sold, checked_in = total["sold"], total["checked_in"]
    return {
        "event_id": event.id, "event_title": event.title, "capacity": capacity,
        "remaining": max(0, capacity - _occupancy(db, event.id, ticket_type_id)),
        "percent_sold": _rate(sold, capacity), "absent": sold - checked_in,
        "percent_checked_in": _rate(checked_in, sold), **_metrics(total),
        "daily": [{"date": day, **_metrics(values)} for day, values in by_day.items()],
        "ticket_types": [{"id": kind.id, "name": kind.name, **_metrics(by_type[kind.id])} for kind in kinds],
        "campaigns": [
            {"id": campaign.id, "name": campaign.name, "redemptions": by_campaign[campaign.id]["redemptions"],
             **_metrics(by_campaign[campaign.id])} for campaign in campaigns if campaign.id in by_campaign
        ],
    }
