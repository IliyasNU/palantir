from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, EmailStr, Field, StringConstraints, field_validator

MAX_PASSWORD_BYTES = 72  # bcrypt only uses the first 72 bytes of a password

FullName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)]


def _fits_bcrypt(value: str) -> str:
    if len(value.encode("utf-8")) > MAX_PASSWORD_BYTES:
        raise ValueError("password must be at most 72 bytes long")
    return value


NewPassword = Annotated[str, Field(min_length=8, max_length=MAX_PASSWORD_BYTES), AfterValidator(_fits_bcrypt)]


class UserCreate(BaseModel):
    """Registration payload. Admins cannot self-register (see scripts/create_admin.py)."""

    email: EmailStr
    full_name: FullName
    password: NewPassword
    role: Literal["attendee", "organizer"] = "attendee"

    @field_validator("email")
    @classmethod
    def normalise_email(cls, value: str) -> str:
        return value.strip().lower()


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)

    @field_validator("email")
    @classmethod
    def normalise_email(cls, value: str) -> str:
        return value.strip().lower()


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=1)


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class EmailTokenRequest(BaseModel):
    """The ``token`` from a verification or password-reset link."""

    token: str = Field(min_length=1, max_length=2048)


class ForgotPasswordRequest(BaseModel):
    email: EmailStr

    @field_validator("email")
    @classmethod
    def normalise_email(cls, value: str) -> str:
        return value.strip().lower()


class ResetPasswordRequest(EmailTokenRequest):
    new_password: NewPassword
