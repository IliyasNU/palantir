"""Validate opt-in targets without connecting to a server or changing the environment."""
import re
from dataclasses import dataclass, field
from typing import Mapping
from urllib.parse import urlsplit

from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError


@dataclass(frozen=True)
class E2ESettings:
    base_url: str
    database_url: str = field(repr=False)


def read_e2e_settings(environment: Mapping[str, str]) -> E2ESettings:
    if environment.get("RUN_POSTGRES_E2E") != "1":
        raise ValueError("Set RUN_POSTGRES_E2E=1 only for an isolated test API and PostgreSQL database.")
    if environment.get("ENVIRONMENT") != "test":
        raise ValueError("PostgreSQL e2e requires ENVIRONMENT=test.")
    base_url = environment.get("E2E_BASE_URL", "").strip().rstrip("/")
    database_url = environment.get("E2E_DATABASE_URL", "").strip()
    if not base_url or not database_url:
        raise ValueError("Set both E2E_BASE_URL and E2E_DATABASE_URL explicitly; there are no live-test defaults.")
    try:
        api = urlsplit(base_url)
        # Accessing port also validates malformed/non-numeric ports.
        api.port
        if (
            api.scheme not in {"http", "https"}
            or api.hostname not in {"localhost", "127.0.0.1", "::1", "backend"}
            or api.username or api.password or api.query or api.fragment or api.path
        ):
            raise ValueError
    except ValueError:
        raise ValueError("E2E_BASE_URL must be a local test HTTP(S) origin without credentials or a path.") from None
    try:
        database = make_url(database_url)
        if (
            database.drivername != "postgresql+psycopg"
            or database.host not in {"localhost", "127.0.0.1", "::1", "db", "postgres"}
            or database.query
            or not re.fullmatch(r"(?:biletflow_test(?:_[a-z0-9_]+)?|test_[a-z0-9_]+|e2e_[a-z0-9_]+)", database.database or "")
        ):
            raise ValueError
    except (ArgumentError, ValueError, TypeError):
        raise ValueError(
            "E2E_DATABASE_URL must use local PostgreSQL+psycopg and an explicitly named test database "
            "(biletflow_test, biletflow_test_*, test_*, or e2e_*)."
        ) from None
    if not environment.get("JWT_SECRET_KEY", "").strip():
        raise ValueError("Set JWT_SECRET_KEY to the same test-only key used by the running API.")
    return E2ESettings(base_url, database_url)
