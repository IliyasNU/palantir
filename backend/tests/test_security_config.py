"""Production configuration and token verification must fail closed."""
import time

import jwt
import pytest
from pydantic import ValidationError

from app.auth import security
from app.core.config import DEFAULT_DEV_SECRET, Settings


def settings(**overrides):
    values = {
        "environment": "production",
        "jwt_algorithm": "HS256",
        "jwt_secret_key": "production-test-secret-with-at-least-64-bytes-for-hmac-only-in-tests",
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


@pytest.mark.parametrize("environment", ["prod", "Production", "production ", ""])
def test_unknown_environment_is_rejected(environment):
    with pytest.raises(ValidationError, match="environment"):
        settings(environment=environment)


@pytest.mark.parametrize("algorithm", ["none", "RS256", "ES256", "", "hs256"])
def test_unsupported_jwt_algorithm_is_rejected(algorithm):
    with pytest.raises(ValidationError, match="jwt_algorithm"):
        settings(jwt_algorithm=algorithm)


@pytest.mark.parametrize(
    "secret",
    [
        DEFAULT_DEV_SECRET,
        "test-secret-key-for-pytest-only-0123456789",
        "change-me-to-a-long-random-string",
        "CHANGE_ME_" + "x" * 64,
        "change me " + "x" * 64,
        "changeme" + "x" * 64,
    ],
)
def test_production_rejects_empty_and_public_placeholder_keys(secret):
    with pytest.raises(ValidationError, match="new random secret"):
        settings(jwt_secret_key=secret)


@pytest.mark.parametrize("environment", ["development", "test", "production"])
@pytest.mark.parametrize("secret", ["", " \t\n"])
def test_empty_key_is_rejected_in_every_environment(environment, secret):
    with pytest.raises(ValidationError, match="must not be empty or whitespace"):
        settings(environment=environment, jwt_secret_key=secret)


@pytest.mark.parametrize(("algorithm", "minimum"), [("HS256", 32), ("HS384", 48), ("HS512", 64)])
def test_production_enforces_algorithm_key_length_in_bytes(algorithm, minimum):
    with pytest.raises(ValidationError, match=f"at least {minimum} bytes"):
        settings(jwt_algorithm=algorithm, jwt_secret_key="a" * (minimum - 1))
    assert settings(jwt_algorithm=algorithm, jwt_secret_key="a" * minimum).jwt_algorithm == algorithm
    # A Unicode secret is measured after UTF-8 encoding, as the HMAC library sees it.
    assert settings(jwt_algorithm=algorithm, jwt_secret_key="я" * (minimum // 2)).jwt_algorithm == algorithm


@pytest.mark.parametrize("environment", ["development", "test"])
def test_dev_key_remains_available_only_outside_production(environment):
    assert settings(environment=environment, jwt_secret_key=DEFAULT_DEV_SECRET).jwt_secret_key == DEFAULT_DEV_SECRET


def test_configuration_failure_does_not_echo_secret():
    secret = "private-short-key"
    with pytest.raises(ValidationError) as error:
        settings(jwt_secret_key=secret)
    assert secret not in str(error.value)


@pytest.fixture(params=["HS256", "HS384", "HS512"])
def production_settings(request, monkeypatch):
    algorithm = request.param
    config = settings(jwt_algorithm=algorithm, jwt_secret_key="s" * 64)
    monkeypatch.setattr(security, "get_settings", lambda: config)
    return config


def claims():
    now = int(time.time())
    return {"sub": "1", "type": "access", "iat": now, "exp": now + 300}


def test_production_signed_token_round_trip(production_settings):
    token = security.create_access_token(1)
    assert security.decode_token(token, security.ACCESS_TOKEN_TYPE)["sub"] == "1"


@pytest.mark.parametrize("claim", ["exp", "iat", "sub", "type"])
def test_production_rejects_missing_required_claim(production_settings, claim):
    payload = claims()
    del payload[claim]
    token = jwt.encode(payload, production_settings.jwt_secret_key, algorithm=production_settings.jwt_algorithm)
    with pytest.raises(security.TokenError):
        security.decode_token(token, security.ACCESS_TOKEN_TYPE)


@pytest.mark.parametrize("invalid_time", ["expired", "future_iat", "future_nbf"])
def test_production_checks_token_times(production_settings, invalid_time):
    payload = claims()
    if invalid_time == "expired":
        payload["exp"] = int(time.time()) - 60
    elif invalid_time == "future_iat":
        payload["iat"] = int(time.time()) + 600
        payload["exp"] = int(time.time()) + 1200
    else:
        payload["nbf"] = int(time.time()) + 600
    token = jwt.encode(payload, production_settings.jwt_secret_key, algorithm=production_settings.jwt_algorithm)
    with pytest.raises(security.TokenError):
        security.decode_token(token, security.ACCESS_TOKEN_TYPE)


def test_production_rejects_forged_signature(production_settings):
    token = jwt.encode(claims(), "different-key-" + "x" * 64, algorithm=production_settings.jwt_algorithm)
    with pytest.raises(security.TokenError):
        security.decode_token(token, security.ACCESS_TOKEN_TYPE)


def test_production_rejects_wrong_algorithm(production_settings):
    algorithm = "HS384" if production_settings.jwt_algorithm == "HS256" else "HS256"
    token = jwt.encode(claims(), production_settings.jwt_secret_key, algorithm=algorithm)
    with pytest.raises(security.TokenError):
        security.decode_token(token, security.ACCESS_TOKEN_TYPE)


def test_production_rejects_unsigned_token(production_settings):
    token = jwt.encode(claims(), None, algorithm="none")
    with pytest.raises(security.TokenError):
        security.decode_token(token, security.ACCESS_TOKEN_TYPE)


def test_production_rejects_refresh_token_as_access(production_settings):
    token = security.create_refresh_token(1)
    with pytest.raises(security.TokenError, match="type"):
        security.decode_token(token, security.ACCESS_TOKEN_TYPE)
