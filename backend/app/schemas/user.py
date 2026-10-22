from typing import Any

from pydantic import BaseModel, ConfigDict, field_validator

from app.schemas.common import UTCDateTime


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    full_name: str
    role: str
    is_active: bool
    created_at: UTCDateTime

    @field_validator("role", mode="before")
    @classmethod
    def role_to_name(cls, value: Any) -> Any:
        # The ORM attribute is a Role object; the API exposes just its name.
        return getattr(value, "name", value)
