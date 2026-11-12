"""Authentication business logic (kept free of FastAPI so it is easy to test)."""
from datetime import datetime, timezone
from typing import Optional

from pydantic import EmailStr, TypeAdapter, ValidationError
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.security import (
    PASSWORD_RESET_TOKEN_TYPE,
    REFRESH_TOKEN_TYPE,
    VERIFY_EMAIL_TOKEN_TYPE,
    TokenError,
    create_access_token,
    create_password_reset_token,
    create_refresh_token,
    decode_token,
    ensure_token_version,
    get_user_id,
    hash_password,
    verify_password,
)
from app.db.base import utcnow
from app.models import RevokedToken, Role, User
from app.schemas.auth import TokenPair, UserCreate

_email_adapter = TypeAdapter(EmailStr)


class EmailAlreadyRegisteredError(Exception):
    pass


class InvalidCredentialsError(Exception):
    pass


class InactiveUserError(Exception):
    pass


def get_user_by_email(db: Session, email: str) -> "User | None":
    return db.scalar(select(User).where(User.email == email))


def register_user(db: Session, data: UserCreate) -> User:
    if get_user_by_email(db, data.email) is not None:
        raise EmailAlreadyRegisteredError(data.email)

    role = db.scalar(select(Role).where(Role.name == data.role))
    if role is None:
        raise RuntimeError("Roles are missing from the database - run `alembic upgrade head` first.")

    user = User(
        email=data.email,
        full_name=data.full_name,
        hashed_password=hash_password(data.password),
        role=role,
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError as exc:  # lost a race against a concurrent registration
        db.rollback()
        raise EmailAlreadyRegisteredError(data.email) from exc
    db.refresh(user)
    return user


def authenticate_user(db: Session, email: str, password: str) -> User:
    # JSON login and the OAuth2 form must query the same canonical email as registration.
    try:
        email = _email_adapter.validate_python(email).strip().lower()
    except ValidationError as exc:
        raise InvalidCredentialsError() from exc
    user = get_user_by_email(db, email)
    if user is None or not verify_password(password, user.hashed_password):
        raise InvalidCredentialsError()
    if not user.is_active:
        raise InactiveUserError()
    return user


def issue_token_pair(user: User) -> TokenPair:
    return TokenPair(
        access_token=create_access_token(user.id, version=user.token_version),
        refresh_token=create_refresh_token(user.id, version=user.token_version),
    )


def _user_from_token(db: Session, token: str, token_type: str, lock: bool = False) -> tuple[User, dict]:
    payload = decode_token(token, token_type)  # raises TokenError
    query = select(User).where(User.id == get_user_id(payload))
    if lock:
        query = query.with_for_update(of=User).execution_options(populate_existing=True)
    user = db.scalar(query)
    if user is None:
        raise TokenError("Invalid token")
    return user, payload


def refresh_tokens(db: Session, refresh_token: str) -> TokenPair:
    user, payload = _user_from_token(db, refresh_token, REFRESH_TOKEN_TYPE)
    ensure_token_version(payload, user.token_version)
    if db.get(RevokedToken, str(payload.get("jti"))) is not None:
        raise TokenError("Token has been revoked")
    if not user.is_active:
        raise InactiveUserError()
    return issue_token_pair(user)


def logout(db: Session, refresh_token: str) -> None:
    """End the session that owns ``refresh_token``. An invalid, expired or already revoked token is a no-op."""
    try:
        payload = decode_token(refresh_token, REFRESH_TOKEN_TYPE)
    except TokenError:
        return
    jti = payload.get("jti")
    if not isinstance(jti, str) or not jti:
        return
    db.execute(delete(RevokedToken).where(RevokedToken.expires_at < utcnow()))
    if db.get(RevokedToken, jti) is None:
        db.add(RevokedToken(jti=jti, expires_at=datetime.fromtimestamp(payload["exp"], timezone.utc)))
    try:
        db.commit()
    except IntegrityError:  # a concurrent logout revoked it first
        db.rollback()


def verify_email(db: Session, token: str) -> User:
    user, _ = _user_from_token(db, token, VERIFY_EMAIL_TOKEN_TYPE)
    if user.email_verified_at is None:
        user.email_verified_at = utcnow()
        db.commit()
        db.refresh(user)
    return user


def password_reset_token_for(db: Session, email: str) -> Optional[tuple[User, str]]:
    """The user and a reset token, or None when no active account has this email."""
    user = get_user_by_email(db, email)
    if user is None or not user.is_active:
        return None
    return user, create_password_reset_token(user.id, user.token_version)


def reset_password(db: Session, token: str, new_password: str) -> None:
    """Set a new password and revoke every token of the user, the reset link included."""
    user, payload = _user_from_token(db, token, PASSWORD_RESET_TOKEN_TYPE, lock=True)
    ensure_token_version(payload, user.token_version)
    user.hashed_password = hash_password(new_password)
    user.token_version += 1
    if user.email_verified_at is None:  # the link proved control of the inbox
        user.email_verified_at = utcnow()
    db.commit()
