"""Authentication business logic (kept free of FastAPI so it is easy to test)."""
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.security import (
    REFRESH_TOKEN_TYPE,
    TokenError,
    create_access_token,
    create_refresh_token,
    decode_token,
    get_user_id,
    hash_password,
    verify_password,
)
from app.models import Role, User
from app.schemas.auth import TokenPair, UserCreate


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
    user = get_user_by_email(db, email.strip().lower())
    if user is None or not verify_password(password, user.hashed_password):
        raise InvalidCredentialsError()
    if not user.is_active:
        raise InactiveUserError()
    return user


def issue_token_pair(user: User) -> TokenPair:
    return TokenPair(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id),
    )


def refresh_tokens(db: Session, refresh_token: str) -> TokenPair:
    payload = decode_token(refresh_token, REFRESH_TOKEN_TYPE)  # raises TokenError
    user = db.get(User, get_user_id(payload))
    if user is None:
        raise TokenError("Invalid token")
    if not user.is_active:
        raise InactiveUserError()
    return issue_token_pair(user)
