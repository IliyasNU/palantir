from typing import Annotated, Literal

from pydantic import BaseModel, StringConstraints

from app.schemas.common import UTCDateTime

# Canonical lower-case UUID only: the scanner compares the echoed request_id as a plain string.
RequestId = Annotated[
    str, StringConstraints(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
]


class CheckInRequest(BaseModel):
    qr_payload: Annotated[str, StringConstraints(min_length=1, max_length=512)]
    request_id: RequestId


class CheckInReceipt(BaseModel):
    status: Literal["CHECKED_IN"] = "CHECKED_IN"
    event_id: int
    ticket_id: int
    request_id: str
    checked_in_at: UTCDateTime
