import time
from datetime import timedelta

import jwt
import pytest
from sqlalchemy import select

from app.auth.security import (
    ACCESS_TOKEN_TYPE,
    REFRESH_TOKEN_TYPE,
    TokenError,
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)
from app.models import User
from tests.helpers import DEFAULT_PASSWORD


def register_payload(**overrides):
    payload = {"email": "Student@Example.com", "full_name": "Test Student", "password": DEFAULT_PASSWORD}
    payload.update(overrides)
    return payload


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


# ------------------------------------------------------------------ registration
def test_register_creates_attendee_by_default(client):
    response = client.post("/auth/register", json=register_payload(full_name="  Test Student "))
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["email"] == "student@example.com"
    assert body["full_name"] == "Test Student"
    assert body["role"] == "attendee"
    assert body["is_active"] is True
    assert "password" not in body and "hashed_password" not in body


def test_register_as_organizer(client):
    response = client.post("/auth/register", json=register_payload(role="organizer"))
    assert response.status_code == 201, response.text
    assert response.json()["role"] == "organizer"


def test_register_cannot_self_assign_admin(client):
    response = client.post("/auth/register", json=register_payload(role="admin"))
    assert response.status_code == 422


def test_register_duplicate_email_is_rejected_case_insensitively(client):
    assert client.post("/auth/register", json=register_payload(email="dup@example.com")).status_code == 201
    second = client.post("/auth/register", json=register_payload(email="DUP@example.com"))
    assert second.status_code == 409


@pytest.mark.parametrize("password", ["short", "x" * 73, "я" * 40])  # too short / too long / >72 bytes
def test_register_rejects_bad_passwords(client, password):
    response = client.post("/auth/register", json=register_payload(password=password))
    assert response.status_code == 422


def test_register_rejects_invalid_email(client):
    response = client.post("/auth/register", json=register_payload(email="not-an-email"))
    assert response.status_code == 422


def test_password_is_stored_as_bcrypt_hash(client, db):
    client.post("/auth/register", json=register_payload())
    user = db.scalar(select(User).where(User.email == "student@example.com"))
    assert user.hashed_password != DEFAULT_PASSWORD
    assert user.hashed_password.startswith("$2")
    assert verify_password(DEFAULT_PASSWORD, user.hashed_password)


# ------------------------------------------------------------------ login
def test_login_returns_token_pair(client, create_user):
    create_user("login@example.com")
    response = client.post("/auth/login", json={"email": "login@example.com", "password": DEFAULT_PASSWORD})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["token_type"] == "bearer"
    assert body["access_token"] and body["refresh_token"]
    assert body["access_token"] != body["refresh_token"]


def test_login_email_is_case_insensitive(client, create_user):
    create_user("login@example.com")
    response = client.post("/auth/login", json={"email": "LOGIN@Example.com", "password": DEFAULT_PASSWORD})
    assert response.status_code == 200


@pytest.mark.parametrize(
    ("email", "password"),
    [("login@example.com", "wrong-password"), ("nobody@example.com", DEFAULT_PASSWORD)],
)
def test_login_with_bad_credentials_is_unauthorized(client, create_user, email, password):
    create_user("login@example.com")
    response = client.post("/auth/login", json={"email": email, "password": password})
    assert response.status_code == 401


def test_login_of_disabled_account_is_forbidden(client, create_user):
    create_user("off@example.com", is_active=False)
    response = client.post("/auth/login", json={"email": "off@example.com", "password": DEFAULT_PASSWORD})
    assert response.status_code == 403


def test_oauth2_form_login_used_by_swagger_authorize(client, create_user):
    create_user("form@example.com")
    response = client.post("/auth/token", data={"username": "form@example.com", "password": DEFAULT_PASSWORD})
    assert response.status_code == 200, response.text
    assert response.json()["access_token"]


# ------------------------------------------------------------------ /auth/me and token validation
def test_me_returns_current_user(client, create_user, auth_header):
    create_user("me@example.com", role="organizer", full_name="Me Myself")
    response = client.get("/auth/me", headers=auth_header("me@example.com"))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["email"] == "me@example.com"
    assert body["role"] == "organizer"
    assert body["full_name"] == "Me Myself"


def test_me_requires_a_token(client):
    assert client.get("/auth/me").status_code == 401


def test_me_rejects_garbage_token(client):
    assert client.get("/auth/me", headers=bearer("not-a-jwt")).status_code == 401


def test_me_rejects_expired_token(client, create_user):
    user = create_user("old@example.com")
    token = create_access_token(user.id, expires_delta=timedelta(seconds=-10))
    assert client.get("/auth/me", headers=bearer(token)).status_code == 401


def test_refresh_token_cannot_be_used_as_access_token(client, create_user):
    user = create_user("t@example.com")
    assert client.get("/auth/me", headers=bearer(create_refresh_token(user.id))).status_code == 401


def test_me_rejects_token_signed_with_another_key(client, create_user):
    user = create_user("forged@example.com")
    now = int(time.time())
    forged = jwt.encode(
        {"sub": str(user.id), "type": "access", "iat": now, "exp": now + 3600},
        "another-secret-key-0123456789-0123456789",
        algorithm="HS256",
    )
    assert client.get("/auth/me", headers=bearer(forged)).status_code == 401


def test_me_rejects_unsigned_token(client, create_user):
    user = create_user("none@example.com")
    now = int(time.time())
    unsigned = jwt.encode(
        {"sub": str(user.id), "type": "access", "iat": now, "exp": now + 3600}, None, algorithm="none"
    )
    assert client.get("/auth/me", headers=bearer(unsigned)).status_code == 401


def test_token_for_unknown_user_is_rejected(client):
    assert client.get("/auth/me", headers=bearer(create_access_token(99999))).status_code == 401


def test_valid_token_of_a_later_disabled_user_is_forbidden(client, create_user, auth_header, db):
    user = create_user("soon-off@example.com")
    headers = auth_header("soon-off@example.com")
    user.is_active = False
    db.commit()
    assert client.get("/auth/me", headers=headers).status_code == 403


# ------------------------------------------------------------------ refresh
def test_refresh_returns_working_tokens(client, create_user):
    create_user("r@example.com")
    tokens = client.post("/auth/login", json={"email": "r@example.com", "password": DEFAULT_PASSWORD}).json()
    response = client.post("/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert response.status_code == 200, response.text
    new_tokens = response.json()
    me = client.get("/auth/me", headers=bearer(new_tokens["access_token"]))
    assert me.status_code == 200
    assert me.json()["email"] == "r@example.com"


def test_refresh_rejects_access_token(client, create_user):
    user = create_user("r2@example.com")
    response = client.post("/auth/refresh", json={"refresh_token": create_access_token(user.id)})
    assert response.status_code == 401


def test_refresh_rejects_garbage(client):
    assert client.post("/auth/refresh", json={"refresh_token": "garbage"}).status_code == 401


def test_refresh_of_disabled_user_is_forbidden(client, create_user, db):
    user = create_user("r3@example.com")
    refresh_token = create_refresh_token(user.id)
    user.is_active = False
    db.commit()
    assert client.post("/auth/refresh", json={"refresh_token": refresh_token}).status_code == 403


# ------------------------------------------------------------------ security helpers (unit)
def test_hash_password_is_salted_and_verifiable():
    first, second = hash_password("pw-12345678"), hash_password("pw-12345678")
    assert first != second
    assert verify_password("pw-12345678", first)
    assert not verify_password("another-password", first)


def test_verify_password_with_malformed_hash_is_false():
    assert verify_password("pw-12345678", "not-a-bcrypt-hash") is False


def test_decode_token_enforces_token_type():
    token = create_access_token(1)
    assert decode_token(token, ACCESS_TOKEN_TYPE)["sub"] == "1"
    with pytest.raises(TokenError):
        decode_token(token, REFRESH_TOKEN_TYPE)
