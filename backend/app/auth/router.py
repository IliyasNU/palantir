"""Authentication endpoints: register, login, refresh, logout, email verification and password reset."""
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response, status
from fastapi.security import OAuth2PasswordRequestForm

from app import email
from app.auth import service
from app.auth.security import TokenError, create_email_verification_token
from app.dependencies.auth import CurrentUser
from app.dependencies.db import DbSession
from app.errors import api_error
from app.models import User
from app.schemas.auth import (
    EmailTokenRequest,
    ForgotPasswordRequest,
    LoginRequest,
    RefreshRequest,
    ResetPasswordRequest,
    TokenPair,
    UserCreate,
)
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
def register(payload: UserCreate, db: DbSession, background: BackgroundTasks):
    """Create an account as an `attendee` (default) or an `organizer` and email a verification link."""
    try:
        user = service.register_user(db, payload)
    except service.EmailAlreadyRegisteredError:
        raise HTTPException(status.HTTP_409_CONFLICT, "A user with this email already exists")
    _send_verification(background, user)
    return user


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


def _send_verification(background: BackgroundTasks, user: User) -> None:
    subject, body = email.verification_email(user.full_name, create_email_verification_token(user.id))
    background.add_task(email.send_email, user.email, subject, body)


def _invalid_link() -> HTTPException:
    return api_error(status.HTTP_400_BAD_REQUEST, "INVALID_TOKEN", "The link is invalid or has expired")


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(payload: RefreshRequest, db: DbSession):
    """End this session: the refresh token stops working. The access token lapses on its own expiry."""
    service.logout(db, payload.refresh_token)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/verify-email", response_model=UserRead)
def verify_email(payload: EmailTokenRequest, db: DbSession):
    """Confirm the address with the token from the verification link. Repeating it is harmless."""
    try:
        return service.verify_email(db, payload.token)
    except TokenError:
        raise _invalid_link()


@router.post("/resend-verification", status_code=status.HTTP_202_ACCEPTED)
def resend_verification(current_user: CurrentUser, background: BackgroundTasks):
    """Email a new verification link unless the address is already verified."""
    if not current_user.email_verified:
        _send_verification(background, current_user)
    return Response(status_code=status.HTTP_202_ACCEPTED)


@router.post("/forgot-password", status_code=status.HTTP_202_ACCEPTED)
def forgot_password(payload: ForgotPasswordRequest, db: DbSession, background: BackgroundTasks):
    """Email a reset link. The answer is the same for unknown addresses so it reveals no accounts."""
    found = service.password_reset_token_for(db, payload.email)
    if found is not None:
        user, token = found
        subject, body = email.password_reset_email(user.full_name, token)
        background.add_task(email.send_email, user.email, subject, body)
    return Response(status_code=status.HTTP_202_ACCEPTED)


@router.post("/reset-password", status_code=status.HTTP_204_NO_CONTENT)
def reset_password(payload: ResetPasswordRequest, db: DbSession):
    """Set a new password with the token from the reset link. Every session of the account ends."""
    try:
        service.reset_password(db, payload.token, payload.new_password)
    except TokenError:
        raise _invalid_link()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
