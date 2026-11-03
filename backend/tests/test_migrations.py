"""The Alembic migrations must apply, match the models, and roll back cleanly on an empty database."""
from pathlib import Path

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, inspect, text

from app.db.base import Base

BACKEND_DIR = Path(__file__).resolve().parents[1]
INITIAL_TABLES = {"roles", "users", "organizer_profiles", "events"}
TICKETING_TABLES = {"tickets", "event_staff", "check_ins"}


def alembic_config(url: str) -> Config:
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    config.set_main_option("sqlalchemy.url", url)
    return config


def schema_drift(engine) -> list:
    with engine.connect() as connection:
        return compare_metadata(MigrationContext.configure(connection), Base.metadata)


def test_upgrade_creates_tables_and_seeds_roles_then_downgrade_removes_them(tmp_path):
    url = f"sqlite:///{tmp_path / 'migration_test.db'}"
    config = alembic_config(url)
    engine = create_engine(url)

    command.upgrade(config, "head")
    assert INITIAL_TABLES | TICKETING_TABLES <= set(inspect(engine).get_table_names())
    with engine.connect() as connection:
        roles = {row[0] for row in connection.execute(text("SELECT name FROM roles"))}
    assert roles == {"admin", "organizer", "attendee"}
    assert schema_drift(engine) == []

    command.downgrade(config, "0001")
    tables = set(inspect(engine).get_table_names())
    assert INITIAL_TABLES <= tables and not (TICKETING_TABLES & tables)
    assert {column["name"] for column in inspect(engine).get_columns("events")}.isdisjoint({"status", "tickets_issued"})

    command.downgrade(config, "base")
    assert not ((INITIAL_TABLES | TICKETING_TABLES) & set(inspect(engine).get_table_names()))
    engine.dispose()


def test_existing_events_become_drafts_with_no_tickets(tmp_path):
    url = f"sqlite:///{tmp_path / 'migration_data.db'}"
    config = alembic_config(url)
    engine = create_engine(url)

    command.upgrade(config, "0001")
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
                "SELECT id, 'Old event', '2030-01-01 10:00:00', 'Hall', 10 FROM users"
            )
        )
    command.upgrade(config, "head")
    with engine.connect() as connection:
        row = connection.execute(text("SELECT status, tickets_issued FROM events")).one()
    assert tuple(row) == ("draft", 0)
    engine.dispose()
