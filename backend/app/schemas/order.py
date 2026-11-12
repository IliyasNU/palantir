from typing import Annotated, Literal, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, StringConstraints

from app.demo_fees import DEMO_NOTICE
from app.schemas.common import UTCDateTime


class OrderCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ticket_type_id: Annotated[int, Field(strict=True, gt=0, le=2147483647)]
    attendee_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    attendee_email: EmailStr
    request_id: UUID


class PaymentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    outcome: Literal["success", "failure"]


class PayoutRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # Only the suffix is accepted; full references never enter the database or logs.
    reference_last4: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9]{4}$")]


class SuspensionRequest(BaseModel):
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=300)]


class OrderRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    event_id: int
    ticket_type_id: int
    buyer_id: int
    request_id: str
    attendee_name: str
    attendee_email: str
    status: str
    subtotal_tiyn: int
    processing_fee_tiyn: int
    processing_fee_bps: int
    total_tiyn: int
    ticket_id: Optional[int]
    created_at: UTCDateTime
    expires_at: UTCDateTime
    completed_at: Optional[UTCDateTime]
    simulation: bool = True
    demo_notice: str = DEMO_NOTICE
