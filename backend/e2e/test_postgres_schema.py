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
    # ConfigParser treats percent signs in URL-encoded credentials as interpolation.
    config.set_main_option("sqlalchemy.url", url.render_as_string(hide_password=False).replace("%", "%%"))
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


def test_postgres_foreign_keys_cascades_and_unique_qr_and_receipts(scratch_database):
    """Exercise real migrated constraints, independently of ORM relationship behavior."""
    command.upgrade(alembic_config(scratch_database), "head")
    engine = create_engine(scratch_database)
    try:
        with engine.begin() as connection:
            users = {}
            for label, role in (
                ("owner", "organizer"), ("first", "attendee"), ("second", "attendee"),
                ("scanner", "attendee"), ("cascade", "organizer"),
            ):
                users[label] = connection.execute(text(
                    "INSERT INTO users (email, full_name, hashed_password, role_id) "
                    "SELECT :email, :label, 'unused-test-hash', id FROM roles WHERE name = :role RETURNING id"
                ), {"email": f"{label}@example.com", "label": label, "role": role}).scalar_one()
            event_id = connection.execute(text(
                "INSERT INTO events (organizer_id, title, date, location, capacity) "
                "VALUES (:owner, 'Integrity event', now(), 'Hall', 10) RETURNING id"
            ), {"owner": users["owner"]}).scalar_one()
            ticket_ids = []
            for label in ("first", "second"):
                ticket_ids.append(connection.execute(text(
                    "INSERT INTO tickets (event_id, attendee_id, qr_payload) "
                    "VALUES (:event, :attendee, :qr) RETURNING id"
                ), {"event": event_id, "attendee": users[label], "qr": f"integrity:{label}"}).scalar_one())
            request_id = str(uuid.uuid4())
            connection.execute(text(
                "INSERT INTO check_ins (ticket_id, event_id, staff_id, request_id) "
                "VALUES (:ticket, :event, :scanner, CAST(:request AS uuid))"
            ), {"ticket": ticket_ids[0], "event": event_id, "scanner": users["scanner"], "request": request_id})
            connection.execute(text(
                "INSERT INTO organizer_profiles (user_id, organization_name) VALUES (:user, 'Cascade test')"
            ), {"user": users["cascade"]})
            connection.execute(text(
                "INSERT INTO event_staff (event_id, user_id) VALUES (:event, :user)"
            ), {"event": event_id, "user": users["cascade"]})

        invalid_writes = [
            ("INSERT INTO tickets (event_id, attendee_id, qr_payload) VALUES (-1, :user, 'orphan-event')", {"user": users["first"]}),
            ("INSERT INTO tickets (event_id, attendee_id, qr_payload) VALUES (:event, -1, 'orphan-user')", {"event": event_id}),
            ("INSERT INTO event_staff (event_id, user_id) VALUES (:event, -1)", {"event": event_id}),
            ("DELETE FROM events WHERE id = :event", {"event": event_id}),
            ("DELETE FROM users WHERE id = :user", {"user": users["first"]}),
            ("DELETE FROM users WHERE id = :user", {"user": users["scanner"]}),
            ("INSERT INTO tickets (event_id, attendee_id, qr_payload) VALUES (:event, :user, 'integrity:first')",
             {"event": event_id, "user": users["scanner"]}),
            ("INSERT INTO check_ins (ticket_id, event_id, staff_id, request_id) VALUES (:ticket, :event, :scanner, CAST(:request AS uuid))",
             {"ticket": ticket_ids[1], "event": event_id, "scanner": users["scanner"], "request": request_id}),
            ("INSERT INTO check_ins (ticket_id, event_id, staff_id, request_id) VALUES (:ticket, :event, :scanner, CAST(:request AS uuid))",
             {"ticket": ticket_ids[0], "event": event_id, "scanner": users["scanner"], "request": str(uuid.uuid4())}),
        ]
        for statement, parameters in invalid_writes:
            with pytest.raises(IntegrityError), engine.begin() as connection:
                connection.execute(text(statement), parameters)

        with engine.begin() as connection:
            connection.execute(text("DELETE FROM users WHERE id = :user"), {"user": users["cascade"]})
            assert connection.execute(text("SELECT count(*) FROM event_staff WHERE user_id = :user"), {"user": users["cascade"]}).scalar_one() == 0
            assert connection.execute(text("SELECT count(*) FROM organizer_profiles WHERE user_id = :user"), {"user": users["cascade"]}).scalar_one() == 0
            assert connection.execute(text("SELECT count(*) FROM events WHERE id = :event"), {"event": event_id}).scalar_one() == 1
    finally:
        engine.dispose()
