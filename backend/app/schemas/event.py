from typing import Annotated, Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from app.models.event import EventPhase
from app.schemas.common import UTCDateTime, blank_to_none
from app.schemas.ticket_type import TicketTypeRead

Visibility = Literal["public", "unlisted", "private"]
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=200)]
Description = Annotated[str, StringConstraints(strip_whitespace=True, max_length=5000)]
RefundPolicy = Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)]
Location = Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=255)]
Capacity = Annotated[int, Field(gt=0, le=1_000_000)]


class EventCreate(BaseModel):
    visibility: Visibility = "public"
    title: Title
    description: Optional[Description] = None
    refund_policy: Optional[RefundPolicy] = None
    date: UTCDateTime  # start date & time; naive values are treated as UTC
    location: Location
    capacity: Capacity

    @field_validator("description", "refund_policy", mode="before")
    @classmethod
    def _blank_description_to_none(cls, value: Any) -> Any:
        return blank_to_none(value)


class EventUpdate(BaseModel):
    """Partial update: only the fields that are sent are changed."""

    visibility: Optional[Visibility] = None
    title: Optional[Title] = None
    description: Optional[Description] = None  # send null to clear it
    refund_policy: Optional[RefundPolicy] = None
    date: Optional[UTCDateTime] = None
    location: Optional[Location] = None
    capacity: Optional[Capacity] = None

    @field_validator("description", "refund_policy", mode="before")
    @classmethod
    def _blank_description_to_none(cls, value: Any) -> Any:
        return blank_to_none(value)

    @field_validator("title", "date", "location", "capacity", "visibility")
    @classmethod
    def _required_fields_not_null(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("this field cannot be null")
        return value


class EventRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    organizer_id: int
    visibility: Visibility
    title: str
    description: Optional[str]
    refund_policy: Optional[str]
    date: UTCDateTime
    location: str
    capacity: int
    status: str
    phase: EventPhase
    tickets_issued: int
    created_at: UTCDateTime
    updated_at: UTCDateTime
    # True only in answers to the event's organizer or an admin: a suspended event is hidden from everyone else.
    suspended: bool
    paid_sales_available: bool
    ticket_types: list[TicketTypeRead] = Field(validation_alias="public_ticket_types")


class EventDuplicate(BaseModel):
    date: UTCDateTime


class HistoryTicket(BaseModel):
    id: int
    ticket_type_id: int
    status: str
    created_at: UTCDateTime


class HistoryOrder(BaseModel):
    id: int
    status: str
    total_tiyn: int
    created_at: UTCDateTime


class HistoryCheckIn(BaseModel):
    id: int
    ticket_id: int
    checked_in_at: UTCDateTime
    undone_at: Optional[UTCDateTime]


class EventHistoryRead(BaseModel):
    event: EventRead
    tickets: list[HistoryTicket]
    orders: list[HistoryOrder]
    check_ins: list[HistoryCheckIn]
    has_more: bool


class EventSummary(BaseModel):
    """The event fields a ticket or a scanner needs."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    date: UTCDateTime
    location: str
    status: str


class StaffEventRead(EventSummary):
    """An event the caller may scan at, and whether they manage it (and so may undo a check-in)."""

    can_manage: bool
