"""The Alembic migrations must apply, match the models, and roll back cleanly on an empty database."""
import uuid
from pathlib import Path

import pytest

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


def _database_with_a_checked_in_ticket(tmp_path, name):
    """Revision 0002 holding one organizer, one event, two tickets and one check-in."""
    url = f"sqlite:///{tmp_path / name}"
    config = alembic_config(url)
    engine = create_engine(url)
    command.upgrade(config, "0002")
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO users (email, full_name, hashed_password, role_id) "
                "SELECT 'org@example.com', 'Org', 'x', id FROM roles WHERE name = 'organizer'"
            )
        )
        connection.execute(
            text(
                "INSERT INTO events (organizer_id, title, date, location, capacity, status, tickets_issued) "
                "SELECT id, 'Old event', '2030-01-01 10:00:00', 'Hall', 10, 'published', 2 FROM users"
            )
        )
        connection.execute(
            text(
                "INSERT INTO users (email, full_name, hashed_password, role_id) "
                "SELECT 'second@example.com', 'Second', 'x', id FROM roles WHERE name = 'attendee'"
            )
        )
        connection.execute(
            text(
                "INSERT INTO tickets (event_id, attendee_id, qr_payload) "
                "VALUES (1, 1, 'old:first'), (1, 2, 'old:second')"
            )
        )
        connection.execute(
            text("INSERT INTO check_ins (ticket_id, event_id, staff_id, request_id) VALUES (1, 1, 1, :request)"),
            {"request": uuid.uuid4().hex},
        )
    return config, engine


def test_existing_tickets_stay_active_and_existing_check_ins_stay_current(tmp_path):
    config, engine = _database_with_a_checked_in_ticket(tmp_path, "migration_0003.db")
    with engine.connect() as connection:
        before = connection.execute(text("SELECT id, qr_payload FROM tickets ORDER BY id")).all()
        request_before = connection.execute(text("SELECT request_id FROM check_ins")).scalar_one()

    command.upgrade(config, "head")
    with engine.connect() as connection:
        tickets = connection.execute(
            text("SELECT id, qr_payload, status, status_changed_at, status_changed_by_id FROM tickets ORDER BY id")
        ).all()
        check_in = connection.execute(
            text("SELECT ticket_id, request_id, undone_at, undone_by_id, undo_request_id FROM check_ins")
        ).one()
    assert [tuple(row[:2]) for row in tickets] == [tuple(row) for row in before]
    assert [tuple(row[2:]) for row in tickets] == [("active", None, None)] * 2
    assert tuple(check_in) == (1, request_before, None, None, None)
    assert schema_drift(engine) == []

    # The old one-check-in-per-ticket rule still holds for current admissions.
    with pytest.raises(Exception, match="UNIQUE"), engine.begin() as connection:
        connection.execute(
            text("INSERT INTO check_ins (ticket_id, event_id, staff_id, request_id) VALUES (1, 1, 1, :request)"),
            {"request": uuid.uuid4().hex},
        )

    command.downgrade(config, "0002")  # nothing cancelled, refunded or undone yet: the data fits 0002 again
    with engine.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM check_ins")).scalar_one() == 1
    engine.dispose()


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE tickets SET status = 'cancelled', status_changed_at = '2030-01-01', status_changed_by_id = 1 WHERE id = 2",
        "UPDATE check_ins SET undone_at = '2030-01-01', undone_by_id = 1, undo_request_id = 'ab'",
    ],
)
def test_downgrade_refuses_to_reinterpret_closed_tickets_or_undone_check_ins(tmp_path, statement):
    config, engine = _database_with_a_checked_in_ticket(tmp_path, "migration_0003_refuse.db")
    command.upgrade(config, "head")
    with engine.begin() as connection:
        connection.execute(text(statement))
    with pytest.raises(RuntimeError, match="Cannot downgrade below 0003"):
        command.downgrade(config, "0002")
    with engine.connect() as connection:
        assert "status" in {column["name"] for column in inspect(connection).get_columns("tickets")}
    engine.dispose()
