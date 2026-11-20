"""Resolve the logged-in user from the ``Authorization: Bearer <access token>`` header."""
from typing import Annotated, Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer

from app.auth.security import ACCESS_TOKEN_TYPE, TokenError, decode_token, ensure_token_version, get_user_id
from app.dependencies.db import DbSession
from app.models import User

# `tokenUrl` makes the "Authorize" button in /docs log in through POST /auth/token.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="auth/token")
optional_oauth2_scheme = OAuth2PasswordBearer(tokenUrl="auth/token", auto_error=False)


def get_current_user(token: Annotated[str, Depends(oauth2_scheme)], db: DbSession) -> User:
    unauthorized = {"WWW-Authenticate": "Bearer"}
    try:
        payload = decode_token(token, ACCESS_TOKEN_TYPE)
        user = db.get(User, get_user_id(payload))
        if user is None:
            raise TokenError("Invalid token")
        ensure_token_version(payload, user.token_version)
    except TokenError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc), headers=unauthorized) from exc
    if not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This account is disabled")
    return user


def get_optional_user(
    token: Annotated[Optional[str], Depends(optional_oauth2_scheme)], db: DbSession
) -> Optional[User]:
    """For public endpoints: anonymous callers get None, but a bad token is still a 401."""
    return None if token is None else get_current_user(token, db)


CurrentUser = Annotated[User, Depends(get_current_user)]
OptionalUser = Annotated[Optional[User], Depends(get_optional_user)]
