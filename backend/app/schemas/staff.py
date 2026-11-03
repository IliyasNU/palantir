
from pydantic import BaseModel, ConfigDict, EmailStr, field_validator

from app.models import EventStaff
from app.schemas.common import UTCDateTime


class StaffAssign(BaseModel):
    email: EmailStr

    @field_validator("email")
    @classmethod
    def normalise_email(cls, value: str) -> str:
        return value.strip().lower()


class StaffRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    user_id: int
    email: str
    full_name: str
    created_at: UTCDateTime

    @classmethod
    def from_assignment(cls, assignment: EventStaff) -> "StaffRead":
        return cls(
            user_id=assignment.user_id,
            email=assignment.user.email,
            full_name=assignment.user.full_name,
            created_at=assignment.created_at,
        )
