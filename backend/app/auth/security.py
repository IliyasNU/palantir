"""Password hashing (bcrypt) and JWT creation / validation."""
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional, Union

import bcrypt
import jwt

from app.core.config import get_settings
from app.schemas.auth import MAX_PASSWORD_BYTES

ACCESS_TOKEN_TYPE = "access"
REFRESH_TOKEN_TYPE = "refresh"


class TokenError(Exception):
    """Raised when a token is missing, malformed, expired, forged or of the wrong type."""


# ----------------------------------------------------------------- passwords
def hash_password(password: str) -> str:
    salt = bcrypt.gensalt(rounds=get_settings().bcrypt_rounds)
    return bcrypt.hashpw(password.encode("utf-8"), salt).decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    try:
        password_bytes = plain_password.encode("utf-8")
        # bcrypt 4 truncates longer input, while bcrypt 5 raises. Reject it consistently.
        if len(password_bytes) > MAX_PASSWORD_BYTES:
            return False
        return bcrypt.checkpw(password_bytes, hashed_password.encode("utf-8"))
    except ValueError:  # malformed hash, or password longer than bcrypt's 72-byte limit
        return False


# ----------------------------------------------------------------- tokens
def _create_token(subject: Union[int, str], token_type: str, expires_delta: timedelta) -> str:
    settings = get_settings()
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(subject),
        "type": token_type,
        "iat": now,
        "exp": now + expires_delta,
        "jti": uuid.uuid4().hex,
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def create_access_token(subject: Union[int, str], expires_delta: Optional[timedelta] = None) -> str:
    delta = expires_delta or timedelta(minutes=get_settings().access_token_expire_minutes)
    return _create_token(subject, ACCESS_TOKEN_TYPE, delta)


def create_refresh_token(subject: Union[int, str], expires_delta: Optional[timedelta] = None) -> str:
    delta = expires_delta or timedelta(days=get_settings().refresh_token_expire_days)
    return _create_token(subject, REFRESH_TOKEN_TYPE, delta)


def decode_token(token: str, expected_type: str) -> dict[str, Any]:
    """Validate signature, expiry and token type; return the payload or raise TokenError."""
    settings = get_settings()
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret_key,
            algorithms=[settings.jwt_algorithm],
            options={
                "require": ["exp", "iat", "sub", "type"],
                "verify_signature": True,
                "verify_exp": True,
                "verify_iat": True,
                "verify_nbf": True,
            },
        )
    except jwt.ExpiredSignatureError as exc:
        raise TokenError("Token has expired") from exc
    except jwt.InvalidTokenError as exc:
        raise TokenError("Invalid token") from exc
    if payload.get("type") != expected_type:
        raise TokenError("Invalid token type")
    return payload


def get_user_id(payload: dict[str, Any]) -> int:
    try:
        return int(payload["sub"])
    except (KeyError, TypeError, ValueError) as exc:
        raise TokenError("Invalid token subject") from exc
