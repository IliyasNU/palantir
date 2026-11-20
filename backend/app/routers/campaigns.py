import secrets
from typing import Annotated, Literal

import qrcode
from fastapi import APIRouter, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from sqlalchemy import select

from app.audit import record_action
from app.campaigns import campaign_report, campaign_url, discount_for, validate_campaign
from app.dependencies.auth import CurrentUser, OptionalUser
from app.dependencies.db import DbSession
from app.dependencies.events import ensure_can_manage, ensure_not_suspended, get_event_or_404, is_visible
from app.errors import api_error
from app.models import TicketType
from app.models.campaign import Campaign, CampaignType
from app.schemas.common import UTCDateTime
from app.ticket_types import lock_event

router = APIRouter(prefix="/events/{event_id}/campaigns", tags=["campaigns"])
PositiveInt = Annotated[int, Field(strict=True, ge=1, le=2147483647)]


class CampaignInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
    kind: Literal["percent", "fixed"]
    value: PositiveInt
    max_uses: PositiveInt
    starts_at: UTCDateTime | None = None
    ends_at: UTCDateTime | None = None
    ticket_type_ids: list[PositiveInt] = Field(default_factory=list, max_length=500)

    @model_validator(mode="after")
    def valid(self):
        if self.kind == "percent" and self.value > 100:
            raise ValueError("Percentage cannot exceed 100")
        if self.starts_at and self.ends_at and self.starts_at >= self.ends_at:
            raise ValueError("End must follow start")
        return self


class QuoteInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=20)] | None = None
    token: Annotated[str, StringConstraints(pattern=r"^pc_[0-9a-f]{32}$")] | None = None
    ticket_type_id: PositiveInt | None = None

    @model_validator(mode="after")
    def one_reference(self):
        if bool(self.code) == bool(self.token):
            raise ValueError("Provide either code or token")
        return self


class Switch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool


def managed_campaign(db, event_id, campaign_id):
    item = db.scalar(select(Campaign).where(Campaign.event_id == event_id, Campaign.id == campaign_id))
    if item is None:
        raise api_error(404, "CAMPAIGN_NOT_FOUND", "Campaign not found")
    return item


@router.post("", status_code=201)
def create(event_id: int, payload: CampaignInput, db: DbSession, user: CurrentUser):
    event = lock_event(db, event_id)
    ensure_can_manage(event, user)
    ensure_not_suspended(event)
    ids = set(payload.ticket_type_ids)
    if ids and ids != set(db.scalars(select(TicketType.id).where(TicketType.event_id == event_id, TicketType.id.in_(ids)))):
        raise api_error(404, "TICKET_TYPE_NOT_FOUND", "Ticket type not found at this event")
    item = Campaign(**payload.model_dump(exclude={"ticket_type_ids"}), event_id=event_id, enabled=True,
                    code="BF-" + secrets.token_hex(6).upper(), token="pc_" + secrets.token_hex(16))
    db.add(item)
    db.flush()
    db.add_all(CampaignType(campaign_id=item.id, ticket_type_id=key) for key in ids)
    record_action(db, event_id=event_id, actor_id=user.id, action="campaign.created",
                  entity_type="campaign", entity_id=item.id, description=f"Created campaign: {item.name}")
    db.commit()
    return campaign_report(db, item)


@router.get("")
def list_campaigns(event_id: int, db: DbSession, user: CurrentUser):
    ensure_can_manage(get_event_or_404(db, event_id), user)
    return [campaign_report(db, item) for item in db.scalars(
        select(Campaign).where(Campaign.event_id == event_id).order_by(Campaign.id.desc()))]


@router.patch("/{campaign_id}")
def switch(event_id: int, campaign_id: int, payload: Switch, db: DbSession, user: CurrentUser):
    event = lock_event(db, event_id)
    ensure_can_manage(event, user)
    if payload.enabled:
        ensure_not_suspended(event)
    item = managed_campaign(db, event_id, campaign_id)
    if item.enabled != payload.enabled:
        item.enabled = payload.enabled
        state = "enabled" if item.enabled else "disabled"
        record_action(db, event_id=event_id, actor_id=user.id, action=f"campaign.{state}",
                      entity_type="campaign", entity_id=item.id, description=f"Campaign {state}: {item.name}")
    db.commit()
    return campaign_report(db, item)


@router.post("/quote")
def quote(event_id: int, payload: QuoteInput, db: DbSession, user: OptionalUser):
    event = get_event_or_404(db, event_id)
    if not is_visible(event, user):
        raise api_error(404, "EVENT_NOT_FOUND", "Event not found")
    ensure_not_suspended(event)
    if event.status != "published":
        raise api_error(409, "EVENT_NOT_PUBLISHED", "Event is not on sale")
    kind = None
    if payload.ticket_type_id is not None:
        kind = db.scalar(select(TicketType).where(TicketType.event_id == event_id, TicketType.id == payload.ticket_type_id,
                                                  TicketType.hidden.is_(False)))
        if kind is None:
            raise api_error(404, "TICKET_TYPE_NOT_FOUND", "Ticket type not found")
    item = validate_campaign(db, event_id, payload.code or payload.token, kind, by_token=payload.token is not None)
    discount = discount_for(item, kind.price_tiyn) if kind else None
    return dict(code=item.code, ticket_type_id=payload.ticket_type_id, discount_tiyn=discount,
                subtotal_tiyn=kind.price_tiyn if kind else None, total_tiyn=kind.price_tiyn - discount if kind else None)


@router.get("/{campaign_id}/qr.svg")
def download_qr(event_id: int, campaign_id: int, db: DbSession, user: CurrentUser):
    ensure_can_manage(get_event_or_404(db, event_id), user)
    item = managed_campaign(db, event_id, campaign_id)
    qr = qrcode.QRCode(border=4)
    qr.add_data(campaign_url(item))
    matrix = qr.get_matrix()
    size = len(matrix)
    path = "".join(f"M{x} {y}h1v1h-1z" for y, row in enumerate(matrix) for x, dark in enumerate(row) if dark)
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="460" viewBox="0 0 {size} {size+8}">'
           f'<title>Это не билет</title><rect width="100%" height="100%" fill="white"/>'
           f'<path d="{path}" fill="#16263b" shape-rendering="crispEdges"/>'
           f'<text x="50%" y="{size+4}" text-anchor="middle" font-size="4" fill="#16263b">Это не билет</text></svg>')
    return Response(svg, media_type="image/svg+xml", headers={
        "Content-Disposition": f'attachment; filename="campaign-{item.id}.svg"'})
