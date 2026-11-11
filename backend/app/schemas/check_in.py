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
    # Identifies this admission for POST /events/{id}/check-ins/{check_in_id}/undo.
    check_in_id: int
    request_id: str
    checked_in_at: UTCDateTime


class UndoRequest(BaseModel):
    # A new UUID for the undo itself, not the request_id of the check-in being undone.
    request_id: RequestId


class UndoReceipt(BaseModel):
    status: Literal["UNDONE"] = "UNDONE"
    event_id: int
    ticket_id: int
    check_in_id: int
    request_id: str
    undone_at: UTCDateTime
