"""Shared fixtures.

The tests run against an in-memory SQLite database, so they need neither Docker nor
PostgreSQL. The environment is forced BEFORE the app is imported so a real DATABASE_URL
(e.g. when running inside the Docker container) can never be touched by the tests.
"""
import os

os.environ["ENVIRONMENT"] = "test"
os.environ["DATABASE_URL"] = "sqlite://"
os.environ["JWT_SECRET_KEY"] = "test-secret-key-for-pytest-only-0123456789"
os.environ["BCRYPT_ROUNDS"] = "4"  # fast hashing in tests

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine, select  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from app.auth.security import hash_password  # noqa: E402
from app.db.base import Base  # noqa: E402
from app.db.seed import seed_roles  # noqa: E402
from app.db.session import get_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Role, User  # noqa: E402
from tests.helpers import DEFAULT_PASSWORD  # noqa: E402


@pytest.fixture()
def engine():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    yield engine
    Base.metadata.drop_all(engine)
    engine.dispose()


@pytest.fixture()
def session_factory(engine):
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


@pytest.fixture()
def db(session_factory):
    """A session for arranging / inspecting data. Roles are already seeded."""
    session = session_factory()
    seed_roles(session)
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def client(session_factory, db):
    def override_get_db():
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture()
def create_user(db):
    """Insert a user directly in the database (the only way to get an admin)."""

    def _create(
        email="user@example.com",
        role="attendee",
        password=DEFAULT_PASSWORD,
        full_name="Test User",
        is_active=True,
    ):
        role_obj = db.scalar(select(Role).where(Role.name == role))
        user = User(
            email=email,
            full_name=full_name,
            hashed_password=hash_password(password),
            role=role_obj,
            is_active=is_active,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return user

    return _create


@pytest.fixture()
def auth_header(client):
    """Log in through the API and return an Authorization header."""

    def _header(email, password=DEFAULT_PASSWORD):
        response = client.post("/auth/login", json={"email": email, "password": password})
        assert response.status_code == 200, response.text
        return {"Authorization": f"Bearer {response.json()['access_token']}"}

    return _header
