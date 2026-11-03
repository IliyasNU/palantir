"""The Alembic migrations on real PostgreSQL: they match the models, enforce the constraints, and roll back."""
import uuid
from pathlib import Path

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from app.db.base import Base
from e2e.conftest import DATABASE_URL

BACKEND_DIR = Path(__file__).resolve().parents[1]


@pytest.fixture()
def scratch_database():
    """A throw-away PostgreSQL database next to the API's one."""
    name = f"e2e_migrations_{uuid.uuid4().hex[:8]}"
    admin = create_engine(DATABASE_URL, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.execute(text(f'CREATE DATABASE "{name}"'))
    url = make_url(DATABASE_URL).set(database=name)
    try:
        yield url
    finally:
        with admin.connect() as connection:
            connection.execute(text(f'DROP DATABASE "{name}" WITH (FORCE)'))
        admin.dispose()


def alembic_config(url) -> Config:
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    config.set_main_option("sqlalchemy.url", url.render_as_string(hide_password=False))
    return config


def test_migrations_match_models_enforce_constraints_and_roll_back(scratch_database):
    config = alembic_config(scratch_database)
    engine = create_engine(scratch_database)
    command.upgrade(config, "head")

    with engine.connect() as connection:
        assert compare_metadata(MigrationContext.configure(connection), Base.metadata) == []
        constraints = set(
            connection.execute(text("SELECT conname FROM pg_constraint WHERE conrelid = 'events'::regclass")).scalars()
        )
    assert {"ck_events_capacity_positive", "ck_events_status_valid", "ck_events_tickets_within_capacity"} <= constraints

    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO users (email, full_name, hashed_password, role_id) "
                "SELECT 'org@example.com', 'Org', 'x', id FROM roles WHERE name = 'organizer'"
            )
        )
        connection.execute(
            text(
                "INSERT INTO events (organizer_id, title, date, location, capacity) "
                "SELECT id, 'Event', now(), 'Hall', 1 FROM users"
            )
        )
    for statement in (
        "UPDATE events SET tickets_issued = 2",
        "UPDATE events SET status = 'archived'",
    ):
        with pytest.raises(IntegrityError), engine.begin() as connection:
            connection.execute(text(statement))

    command.downgrade(config, "base")
    assert inspect(engine).get_table_names() == ["alembic_version"]
    command.upgrade(config, "head")
    engine.dispose()
