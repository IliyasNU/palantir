from datetime import datetime
from typing import Optional

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Campaign(Base):
    __tablename__ = "campaigns"
    __table_args__ = (
        CheckConstraint("value > 0 AND ((kind = 'percent' AND value <= 100) OR kind = 'fixed')", name="campaign_value"),
        CheckConstraint("max_uses > 0", name="campaign_limit"),
        CheckConstraint("starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at", name="campaign_window"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    code: Mapped[str] = mapped_column(String(20), unique=True)
    token: Mapped[str] = mapped_column(String(40), unique=True)
    kind: Mapped[str] = mapped_column(String(8))
    value: Mapped[int]
    max_uses: Mapped[int]
    enabled: Mapped[bool]
    starts_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class CampaignType(Base):
    __tablename__ = "campaign_types"
    campaign_id: Mapped[int] = mapped_column(ForeignKey("campaigns.id"), primary_key=True)
    ticket_type_id: Mapped[int] = mapped_column(ForeignKey("ticket_types.id"), primary_key=True)
