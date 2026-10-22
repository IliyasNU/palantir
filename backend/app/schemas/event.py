from typing import Annotated, Any, Optional

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from app.schemas.common import UTCDateTime, blank_to_none

Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=200)]
Description = Annotated[str, StringConstraints(strip_whitespace=True, max_length=5000)]
Location = Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=255)]
Capacity = Annotated[int, Field(gt=0, le=1_000_000)]


class EventCreate(BaseModel):
    title: Title
    description: Optional[Description] = None
    date: UTCDateTime  # start date & time; naive values are treated as UTC
    location: Location
    capacity: Capacity

    @field_validator("description", mode="before")
    @classmethod
    def _blank_description_to_none(cls, value: Any) -> Any:
        return blank_to_none(value)


class EventUpdate(BaseModel):
    """Partial update: only the fields that are sent are changed."""

    title: Optional[Title] = None
    description: Optional[Description] = None  # send null to clear it
    date: Optional[UTCDateTime] = None
    location: Optional[Location] = None
    capacity: Optional[Capacity] = None

    @field_validator("description", mode="before")
    @classmethod
    def _blank_description_to_none(cls, value: Any) -> Any:
        return blank_to_none(value)

    @field_validator("title", "date", "location", "capacity")
    @classmethod
    def _required_fields_not_null(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("this field cannot be null")
        return value


class EventRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    organizer_id: int
    title: str
    description: Optional[str]
    date: UTCDateTime
    location: str
    capacity: int
    created_at: UTCDateTime
    updated_at: UTCDateTime
