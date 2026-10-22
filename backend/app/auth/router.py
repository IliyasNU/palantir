"""Authentication endpoints: register, login, token refresh and 'who am I'."""
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm

from app.auth import service
from app.auth.security import TokenError
from app.dependencies.auth import CurrentUser
from app.dependencies.db import DbSession
from app.schemas.auth import LoginRequest, RefreshRequest, TokenPair, UserCreate
from app.schemas.user import UserRead

router = APIRouter(prefix="/auth", tags=["authentication"])

_BEARER = {"WWW-Authenticate": "Bearer"}


def _login(db: DbSession, email: str, password: str) -> TokenPair:
    try:
        user = service.authenticate_user(db, email, password)
    except service.InvalidCredentialsError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Incorrect email or password", headers=_BEARER)
    except service.InactiveUserError:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This account is disabled")
    return service.issue_token_pair(user)


@router.post("/register", response_model=UserRead, status_code=status.HTTP_201_CREATED)
def register(payload: UserCreate, db: DbSession):
    """Create an account as an `attendee` (default) or an `organizer`."""
    try:
        return service.register_user(db, payload)
    except service.EmailAlreadyRegisteredError:
        raise HTTPException(status.HTTP_409_CONFLICT, "A user with this email already exists")


@router.post("/login", response_model=TokenPair)
def login(payload: LoginRequest, db: DbSession):
    """Log in with a JSON body `{"email": ..., "password": ...}` (used by the web and mobile apps)."""
    return _login(db, payload.email, payload.password)


@router.post("/token", response_model=TokenPair)
def login_form(form: Annotated[OAuth2PasswordRequestForm, Depends()], db: DbSession):
    """Same login as `/auth/login`, but as an OAuth2 form (`username` = email). Powers /docs "Authorize"."""
    return _login(db, form.username, form.password)


@router.post("/refresh", response_model=TokenPair)
def refresh(payload: RefreshRequest, db: DbSession):
    """Exchange a valid refresh token for a fresh access + refresh token pair."""
    try:
        return service.refresh_tokens(db, payload.refresh_token)
    except TokenError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc), headers=_BEARER)
    except service.InactiveUserError:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This account is disabled")


@router.get("/me", response_model=UserRead)
def me(current_user: CurrentUser):
    """Return the user that owns the supplied access token."""
    return current_user
