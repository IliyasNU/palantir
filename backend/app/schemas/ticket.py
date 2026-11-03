from typing import Optional

from pydantic import BaseModel, ConfigDict

from app.schemas.common import UTCDateTime
from app.schemas.event import EventSummary


class TicketRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    event_id: int
    attendee_id: int
    qr_payload: str  # encode exactly this string into the QR code
    created_at: UTCDateTime
    checked_in_at: Optional[UTCDateTime]
    event: EventSummary
