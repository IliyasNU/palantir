"""End-to-end tests against a RUNNING API backed by PostgreSQL, over real HTTP.

Unlike ``tests/`` (in-process, SQLite), these exercise uvicorn, the Alembic-built PostgreSQL schema and
real concurrency. Every test registers fresh users with random e-mails, so the suite can rerun on the
same database. See backend/README.md for the command.
"""
import os
import threading
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from sqlalchemy import create_engine, text

BASE_URL = os.environ.get("E2E_BASE_URL", "http://localhost:8000").rstrip("/")
DATABASE_URL = os.environ.get(
    "E2E_DATABASE_URL", "postgresql+psycopg://palantir:palantir@localhost:5432/palantir"
)
PASSWORD = "E2e-Test-Passw0rd"


@pytest.fixture(scope="session", autouse=True)
def api_is_up():
    response = httpx.get(f"{BASE_URL}/health", timeout=10)
    assert response.json() == {"status": "ok", "database": "up"}, f"API at {BASE_URL} is not healthy"


@pytest.fixture(scope="session")
def db_engine():
    engine = create_engine(DATABASE_URL)
    assert engine.dialect.name == "postgresql"
    yield engine
    engine.dispose()


@pytest.fixture()
def sql(db_engine) -> Callable[..., Any]:
    """Run a scalar query against the API's database: ``sql("SELECT count(*) ...", id=1)``."""

    def _scalar(query: str, **params):
        with db_engine.connect() as connection:
            return connection.execute(text(query), params).scalar_one()

    return _scalar


@pytest.fixture()
def api():
    with httpx.Client(base_url=BASE_URL, timeout=30) as client:
        yield client


@pytest.fixture()
def register(api):
    """Register a throw-away user through the API and log them in."""

    def _register(role: str = "attendee") -> SimpleNamespace:
        email = f"e2e-{role}-{uuid.uuid4().hex[:12]}@example.com"
        response = api.post(
            "/auth/register", json={"email": email, "full_name": f"E2E {role}", "password": PASSWORD, "role": role}
        )
        assert response.status_code == 201, response.text
        tokens = api.post("/auth/login", json={"email": email, "password": PASSWORD}).json()
        return SimpleNamespace(
            id=response.json()["id"], email=email, headers={"Authorization": f"Bearer {tokens['access_token']}"}
        )

    return _register


@pytest.fixture()
def published_event(api):
    def _create(owner: SimpleNamespace, capacity: int = 100) -> dict:
        response = api.post(
            "/events",
            json={
                "title": f"E2E event {uuid.uuid4().hex[:6]}",
                "date": "2030-06-01T12:00:00Z",
                "location": "Orange Hall",
                "capacity": capacity,
            },
            headers=owner.headers,
        )
        assert response.status_code == 201, response.text
        response = api.post(f"/events/{response.json()['id']}/publish", headers=owner.headers)
        assert response.status_code == 200, response.text
        return response.json()

    return _create


def run_concurrently(calls: list[Callable[[httpx.Client], httpx.Response]]) -> list[httpx.Response]:
    """Fire the calls at the same moment, each on its own connection."""
    barrier = threading.Barrier(len(calls))

    def runner(call):
        with httpx.Client(base_url=BASE_URL, timeout=60) as client:
            barrier.wait()
            return call(client)

    with ThreadPoolExecutor(max_workers=len(calls)) as pool:
        return list(pool.map(runner, calls))
