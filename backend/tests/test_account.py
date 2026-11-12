"""BE-3 emails and BE-4 email verification, password reset and logout."""
import logging
import re
from datetime import timedelta

import pytest

from app import email
from app.auth.security import PASSWORD_RESET_TOKEN_TYPE, _create_token, create_email_verification_token
from app.core.config import get_settings
from tests.helpers import DEFAULT_PASSWORD

NEW_PASSWORD = "N3w-Passw0rd!"


@pytest.fixture()
def outbox(monkeypatch):
    sent = []
    monkeypatch.setattr(email, "send_email", lambda to, subject, body: sent.append((to, subject, body)))
    return sent


def link_token(body, path):
    match = re.search(rf"{re.escape(get_settings().frontend_url)}{path}\?token=(\S+)", body)
    assert match, body
    return match.group(1)


def login(client, address, password=DEFAULT_PASSWORD):
    return client.post("/auth/login", json={"email": address, "password": password})


def bearer(tokens):
    return {"Authorization": f"Bearer {tokens['access_token']}"}


def register(client, address="new@example.com"):
    response = client.post(
        "/auth/register", json={"email": address, "full_name": "New User", "password": DEFAULT_PASSWORD}
    )
    assert response.status_code == 201, response.text
    return response.json()


# ------------------------------------------------------------------ verification
def test_registration_emails_a_link_that_verifies_the_address(client, outbox):
    assert register(client)["email_verified"] is False
    [(to, _, body)] = outbox
    assert to == "new@example.com"
    token = link_token(body, "/verify-email")

    for _ in range(2):  # opening the link twice is harmless
        response = client.post("/auth/verify-email", json={"token": token})
        assert response.status_code == 200, response.text
        assert response.json()["email_verified"] is True
    me = client.get("/auth/me", headers=bearer(login(client, "new@example.com").json()))
    assert me.json()["email_verified"] is True


def test_verify_email_rejects_bad_tokens(client, outbox):
    register(client)
    tokens = login(client, "new@example.com").json()
    for token in ("garbage", tokens["access_token"], tokens["refresh_token"]):
        response = client.post("/auth/verify-email", json={"token": token})
        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "INVALID_TOKEN"


def test_resend_verification_only_while_unverified(client, outbox, create_user):
    assert client.post("/auth/resend-verification").status_code == 401
    user = create_user("someone@example.com")
    headers = bearer(login(client, user.email).json())

    assert client.post("/auth/resend-verification", headers=headers).status_code == 202
    [(to, _, body)] = outbox
    assert to == user.email
    client.post("/auth/verify-email", json={"token": link_token(body, "/verify-email")})

    assert client.post("/auth/resend-verification", headers=headers).status_code == 202
    assert len(outbox) == 1


# ------------------------------------------------------------------ password reset
def test_forgot_password_does_not_reveal_unknown_or_disabled_accounts(client, outbox, create_user):
    create_user("off@example.com", is_active=False)
    for address in ("nobody@example.com", "off@example.com"):
        assert client.post("/auth/forgot-password", json={"email": address}).status_code == 202
    assert outbox == []


def test_reset_password_changes_it_once_and_ends_every_session(client, outbox, create_user):
    user = create_user("forgot@example.com")
    phone = login(client, user.email).json()
    web = login(client, user.email).json()

    assert client.post("/auth/forgot-password", json={"email": " Forgot@Example.com "}).status_code == 202
    [(to, _, body)] = outbox
    assert to == user.email
    token = link_token(body, "/reset-password")

    response = client.post("/auth/reset-password", json={"token": token, "new_password": NEW_PASSWORD})
    assert response.status_code == 204, response.text

    assert login(client, user.email).status_code == 401
    fresh = login(client, user.email, NEW_PASSWORD)
    assert fresh.status_code == 200
    me = client.get("/auth/me", headers=bearer(fresh.json())).json()
    assert me["email_verified"] is True  # the reset link proved the inbox

    for session in (phone, web):
        assert client.get("/auth/me", headers=bearer(session)).status_code == 401
        assert client.post("/auth/refresh", json={"refresh_token": session["refresh_token"]}).status_code == 401

    again = client.post("/auth/reset-password", json={"token": token, "new_password": "An0ther-Passw0rd"})
    assert again.status_code == 400
    assert again.json()["detail"]["code"] == "INVALID_TOKEN"
    assert login(client, user.email, NEW_PASSWORD).status_code == 200


def test_reset_password_rejects_expired_or_foreign_tokens_and_weak_passwords(client, create_user):
    user = create_user("forgot@example.com")
    expired = _create_token(user.id, PASSWORD_RESET_TOKEN_TYPE, timedelta(seconds=-1))
    for token in (expired, create_email_verification_token(user.id), login(client, user.email).json()["access_token"]):
        response = client.post("/auth/reset-password", json={"token": token, "new_password": NEW_PASSWORD})
        assert response.status_code == 400, token

    client.post("/auth/forgot-password", json={"email": user.email})
    response = client.post("/auth/reset-password", json={"token": expired, "new_password": "short"})
    assert response.status_code == 422
    assert login(client, user.email).status_code == 200


# ------------------------------------------------------------------ logout
def test_logout_ends_only_its_own_session(client, create_user):
    user = create_user("out@example.com")
    web = login(client, user.email).json()
    phone = login(client, user.email).json()

    for _ in range(2):  # logging out twice is a no-op
        assert client.post("/auth/logout", json={"refresh_token": web["refresh_token"]}).status_code == 204
    assert client.post("/auth/refresh", json={"refresh_token": web["refresh_token"]}).status_code == 401

    renewed = client.post("/auth/refresh", json={"refresh_token": phone["refresh_token"]})
    assert renewed.status_code == 200
    assert client.get("/auth/me", headers=bearer(renewed.json())).status_code == 200


def test_logout_ignores_tokens_it_cannot_use(client, create_user):
    user = create_user("out@example.com")
    access = login(client, user.email).json()["access_token"]
    for token in ("garbage", access):
        assert client.post("/auth/logout", json={"refresh_token": token}).status_code == 204


# ------------------------------------------------------------------ delivery
def test_without_smtp_the_body_is_logged_outside_production_only(monkeypatch, caplog):
    caplog.set_level(logging.WARNING, logger="app.email")
    email.send_email("a@example.com", "Hi", "secret-link")
    assert "secret-link" in caplog.text

    caplog.clear()
    monkeypatch.setattr(get_settings(), "environment", "production")
    email.send_email("a@example.com", "Hi", "secret-link")
    assert "a@example.com" in caplog.text and "secret-link" not in caplog.text


def test_smtp_delivery(monkeypatch):
    sent = []

    class FakeSMTP:
        def __init__(self, host, port, timeout):
            sent.append(("connect", host, port))

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def starttls(self):
            sent.append(("starttls",))

        def login(self, username, password):
            sent.append(("login", username, password))

        def send_message(self, message):
            sent.append(("send", message["To"], message["Subject"], message.get_content().strip()))

    settings = get_settings()
    for name, value in {"smtp_host": "smtp.example.com", "smtp_username": "bot", "smtp_password": "pw"}.items():
        monkeypatch.setattr(settings, name, value)
    monkeypatch.setattr(email.smtplib, "SMTP", FakeSMTP)

    email.send_email("a@example.com", "Привет", "Текст")
    assert sent == [
        ("connect", "smtp.example.com", 587),
        ("starttls",),
        ("login", "bot", "pw"),
        ("send", "a@example.com", "Привет", "Текст"),
    ]
