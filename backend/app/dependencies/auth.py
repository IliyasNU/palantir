"""Resolve the logged-in user from the ``Authorization: Bearer <access token>`` header."""
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer

from app.auth.security import ACCESS_TOKEN_TYPE, TokenError, decode_token, get_user_id
from app.dependencies.db import DbSession
from app.models import User

# `tokenUrl` makes the "Authorize" button in /docs log in through POST /auth/token.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="auth/token")


def get_current_user(token: Annotated[str, Depends(oauth2_scheme)], db: DbSession) -> User:
    unauthorized = {"WWW-Authenticate": "Bearer"}
    try:
        user_id = get_user_id(decode_token(token, ACCESS_TOKEN_TYPE))
    except TokenError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc), headers=unauthorized) from exc

    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token", headers=unauthorized)
    if not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This account is disabled")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]
