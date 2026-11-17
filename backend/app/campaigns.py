"""Campaign quotes are advisory. Checkout repeats validation while holding the event lock."""
import re

from sqlalchemy import and_, func, or_, select

from app.core.config import get_settings
from app.db.base import utcnow
from app.errors import api_error
from app.models.campaign import Campaign, CampaignType
from app.models.order import Order
from app.schemas.common import to_utc


def campaign_url(campaign):
    origin = str(get_settings().campaign_web_origin).rstrip("/")
    return f"{origin}/events/{campaign.event_id}?campaign={campaign.token}"


def campaign_qr_payload(payload):
    origin = re.escape(str(get_settings().campaign_web_origin).rstrip("/"))
    return re.fullmatch(origin + r"/events/[1-9][0-9]*\?campaign=pc_[0-9a-f]{32}", payload) is not None


def type_ids(db, campaign):
    return list(db.scalars(select(CampaignType.ticket_type_id).where(
        CampaignType.campaign_id == campaign.id).order_by(CampaignType.ticket_type_id)))


def validate_campaign(db, event_id, reference, kind=None, *, by_token=False):
    match = Campaign.token == reference if by_token else Campaign.code == reference.upper()
    campaign = db.scalar(select(Campaign).where(Campaign.event_id == event_id, match))
    if campaign is None:
        raise api_error(404, "PROMO_NOT_FOUND", "Промокод не найден для этого события")
    now = utcnow()
    if not campaign.enabled:
        raise api_error(409, "PROMO_DISABLED", "Кампания выключена")
    if campaign.starts_at and now < to_utc(campaign.starts_at):
        raise api_error(409, "PROMO_NOT_STARTED", "Акция ещё не началась")
    if campaign.ends_at and now >= to_utc(campaign.ends_at):
        raise api_error(409, "PROMO_EXPIRED", "Срок действия промокода истёк")
    if kind is not None:
        allowed = type_ids(db, campaign)
        if kind.hidden or kind.price_tiyn == 0 or (allowed and kind.id not in allowed):
            raise api_error(409, "PROMO_NOT_APPLICABLE", "Промокод не подходит для этого типа билета")
    occupied = db.scalar(select(func.count(Order.id)).where(Order.campaign_id == campaign.id, or_(
        Order.status == "paid", and_(Order.status == "pending", Order.expires_at > now))))
    if occupied >= campaign.max_uses:
        raise api_error(409, "PROMO_EXHAUSTED", "Лимит использований промокода исчерпан")
    return campaign


def discount_for(campaign, price):
    if campaign is None:
        return 0
    if campaign.kind == "fixed":
        return min(price, campaign.value)
    return (price * campaign.value + 50) // 100


def campaign_report(db, campaign):
    paid = Order.status == "paid"
    columns = [func.count(Order.id), func.count(Order.id).filter(paid), func.count(Order.ticket_id).filter(paid)]
    for amount in (Order.subtotal_tiyn, Order.discount_tiyn, Order.total_tiyn, Order.processing_fee_tiyn):
        columns.append(func.coalesce(func.sum(amount).filter(paid), 0))
    orders, redemptions, tickets, gross, discounts, net, fees = db.execute(
        select(*columns).where(Order.campaign_id == campaign.id)).one()
    return dict(id=campaign.id, name=campaign.name, code=campaign.code, link=campaign_url(campaign),
                enabled=campaign.enabled, kind=campaign.kind, value=campaign.value, max_uses=campaign.max_uses,
                starts_at=campaign.starts_at, ends_at=campaign.ends_at, ticket_type_ids=type_ids(db, campaign),
                orders=orders, redemptions=redemptions, tickets_sold=tickets, gross_tiyn=gross,
                discount_tiyn=discounts, net_sales_tiyn=net, organizer_net_tiyn=net-fees)
