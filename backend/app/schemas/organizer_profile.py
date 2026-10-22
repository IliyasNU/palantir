import re
from typing import Annotated, Any, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, StringConstraints, field_validator

from app.schemas.common import UTCDateTime, blank_to_none

PHONE_PATTERN = re.compile(r"^\+?[0-9 ()\-]{7,20}$")
URL_PATTERN = re.compile(r"^https?://\S+$", re.IGNORECASE)

OrganizationName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=200)]
LongText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)]
Phone = Annotated[str, StringConstraints(strip_whitespace=True, max_length=50)]
Website = Annotated[str, StringConstraints(strip_whitespace=True, max_length=255)]


class OrganizerProfileFields(BaseModel):
    """Optional fields shared by the create and update payloads."""

    description: Optional[LongText] = None
    contact_email: Optional[EmailStr] = None
    contact_phone: Optional[Phone] = None
    website: Optional[Website] = None

    @field_validator("description", "contact_email", "contact_phone", "website", mode="before")
    @classmethod
    def _blank_to_none(cls, value: Any) -> Any:
        return blank_to_none(value)

    @field_validator("contact_phone")
    @classmethod
    def _check_phone(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and not PHONE_PATTERN.match(value):
            raise ValueError("contact_phone must look like +7 701 123 45 67")
        return value

    @field_validator("website")
    @classmethod
    def _check_website(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and not URL_PATTERN.match(value):
            raise ValueError("website must start with http:// or https://")
        return value


class OrganizerProfileCreate(OrganizerProfileFields):
    organization_name: OrganizationName


class OrganizerProfileUpdate(OrganizerProfileFields):
    """Partial update: only the fields that are sent are changed."""

    organization_name: Optional[OrganizationName] = None

    @field_validator("organization_name")
    @classmethod
    def _organization_name_not_null(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            raise ValueError("organization_name cannot be null")
        return value


class OrganizerProfileRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: int
    organization_name: str
    description: Optional[str]
    contact_email: Optional[str]
    contact_phone: Optional[str]
    website: Optional[str]
    created_at: UTCDateTime
    updated_at: UTCDateTime
