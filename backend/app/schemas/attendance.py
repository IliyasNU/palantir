from typing import Optional

from pydantic import BaseModel

from app.schemas.common import UTCDateTime

EMAIL_MASK = "***"


def mask_email(email: str) -> str:
    """Show at most the first two characters of the local part, then a fixed mask, then the domain.

    At least one character of the local part is always hidden and the mask length is fixed, so short
    local parts are neither revealed in full nor betrayed by their length:
    ``alice@x.kz -> al***@x.kz``, ``ab@x.kz -> a***@x.kz``, ``a@x.kz -> ***@x.kz``.
    """
    local, at, domain = email.rpartition("@")
    if not at:  # not an e-mail address; reveal nothing
        return EMAIL_MASK
    visible = min(2, len(local) - 1) if local else 0
    return f"{local[:visible]}{EMAIL_MASK}@{domain}"


class AttendanceRead(BaseModel):
    event_id: int
    capacity: int
    tickets_issued: int
    checked_in: int


class AttendeeSearchResult(BaseModel):
    ticket_id: int
    full_name: str
    masked_email: str
    checked_in_at: Optional[UTCDateTime]
    # Exact payload of the ticket's QR: the scanner submits it to POST /events/{id}/check-in unchanged.
    qr_payload: str
