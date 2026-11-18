from typing import Annotated, Any, Optional

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator

from app.schemas.common import UTCDateTime, blank_to_none
from app.ticket_type_name import TICKET_TYPE_NAME_MAX_LENGTH

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=TICKET_TYPE_NAME_MAX_LENGTH)]
Description = Annotated[str, StringConstraints(strip_whitespace=True, max_length=5000)]
Money = Annotated[int, Field(strict=True, ge=0, le=2_147_483_647)]
Quantity = Annotated[int, Field(strict=True, ge=0, le=1_000_000)]
OrderLimit = Annotated[int, Field(strict=True, ge=1, le=1_000_000)]
ResourceId = Annotated[int, Field(strict=True, gt=0, le=2_147_483_647)]


class TicketTypeCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_id: Optional[ResourceId] = None
    name: Name
    description: Optional[Description] = None
    price_tiyn: Money = 0
    quantity: Quantity
    sales_start: Optional[UTCDateTime] = None
    sales_end: Optional[UTCDateTime] = None
    order_limit: OrderLimit = 1
    hidden: bool = False

    @field_validator("description", mode="before")
    @classmethod
    def _blank_description(cls, value: Any) -> Any:
        return blank_to_none(value)

    @model_validator(mode="after")
    def _sales_window(self):
        if self.sales_start is not None and self.sales_end is not None and self.sales_start >= self.sales_end:
            raise ValueError("sales_start must be before sales_end")
        return self


class TicketTypeUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Optional[Name] = None
    description: Optional[Description] = None
    price_tiyn: Optional[Money] = None
    quantity: Optional[Quantity] = None
    sales_start: Optional[UTCDateTime] = None
    sales_end: Optional[UTCDateTime] = None
    order_limit: Optional[OrderLimit] = None
    hidden: Optional[bool] = None

    @field_validator("description", mode="before")
    @classmethod
    def _blank_description(cls, value: Any) -> Any:
        return blank_to_none(value)

    @field_validator("name", "price_tiyn", "quantity", "order_limit", "hidden")
    @classmethod
    def _not_null(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("this field cannot be null")
        return value


class TicketTypeSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    price_tiyn: int


class TicketTypeRead(TicketTypeSummary):
    event_id: int
    description: Optional[str]
    quantity: int
    tickets_issued: int
    remaining: int
    sales_start: Optional[UTCDateTime]
    sales_end: Optional[UTCDateTime]
    order_limit: int
    hidden: bool
    is_default: bool


class TicketClaimRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ticket_type_id: Optional[ResourceId] = None


class ActionLogRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    event_id: Optional[int]  # null for platform actions that belong to no event
    occurred_at: UTCDateTime
    actor_id: int
    actor_name: str
    action: str
    entity_type: str
    entity_id: int
    description: str
