from datetime import datetime

from sqlalchemy import DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class EmailThrottle(Base):
    """When an account email was last requested, keyed by purpose and address or user id."""

    __tablename__ = "email_throttles"

    key: Mapped[str] = mapped_column(String(320), primary_key=True)
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
