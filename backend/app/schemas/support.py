from typing import Annotated, Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from app.schemas.common import UTCDateTime

Kind = Literal["attendee", "organizer"]
Status = Literal["open", "in_progress", "waiting_for_customer", "resolved"]
Category = Literal[
    "ticket_delivery", "payment", "refund", "seating", "event_information", "check_in", "account", "technical",
    "activation",
]
Side = Literal["requester", "staff"]
Subject = Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=200)]
Body = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)]
ResourceId = Annotated[int, Field(strict=True, gt=0, le=2_147_483_647)]


class CaseCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Kind = "attendee"
    category: Category
    subject: Subject
    message: Body
    # The page the request was opened from. The server checks each id and fills in the rest of the context.
    event_id: Optional[ResourceId] = None
    order_id: Optional[ResourceId] = None
    ticket_id: Optional[ResourceId] = None


class MessageCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    body: Body


class CaseUpdate(BaseModel):
    """Only the fields that are sent change. ``assignee_id: null`` removes the assignment."""

    model_config = ConfigDict(extra="forbid")

    status: Optional[Status] = None
    assignee_id: Optional[ResourceId] = None

    @field_validator("status")
    @classmethod
    def _status_not_null(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("this field cannot be null")
        return value


class PersonRead(BaseModel):
    id: int
    full_name: str


class RequesterRead(PersonRead):
    masked_email: str


class MessageRead(BaseModel):
    id: int
    case_id: int
    author_id: int
    author_name: str
    author_side: Side
    body: str
    created_at: UTCDateTime


class CaseSummary(BaseModel):
    id: int
    kind: Kind
    category: Category
    subject: str
    status: Status
    requester: RequesterRead
    assignee: Optional[PersonRead]
    event_id: Optional[int]
    event_title: Optional[str]
    order_id: Optional[int]
    ticket_id: Optional[int]
    created_at: UTCDateTime
    updated_at: UTCDateTime
    # Who wrote last, so a list can show "new reply" without loading the thread.
    last_message_at: UTCDateTime
    last_message_by: Side


class EventContext(BaseModel):
    id: int
    title: str
    status: str


class OrderContext(BaseModel):
    id: int
    status: str
    total_tiyn: int


class TicketContext(BaseModel):
    id: int
    status: str


class CaseContext(BaseModel):
    event: Optional[EventContext]
    order: Optional[OrderContext]
    ticket: Optional[TicketContext]


class CaseRead(CaseSummary):
    # Which side the viewer writes as, and whether they may assign the case and set any status,
    # so the client shows the right controls without guessing from roles.
    viewer_side: Side
    can_manage: bool
    context: CaseContext
    messages: list[MessageRead]
