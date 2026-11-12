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


def test_ticket_type_backfill_keeps_legacy_tickets_and_admissions(scratch_database):
    config = alembic_config(scratch_database)
    engine = create_engine(scratch_database)
    try:
        command.upgrade(config, "0003")
        with engine.begin() as connection:
            owner = connection.execute(text(
                "INSERT INTO users (email, full_name, hashed_password, role_id) "
                "SELECT 'p1-owner@example.com', 'Owner', 'unused-test-hash', id FROM roles "
                "WHERE name = 'organizer' RETURNING id"
            )).scalar_one()
            visitor = connection.execute(text(
                "INSERT INTO users (email, full_name, hashed_password, role_id) "
                "SELECT 'p1-visitor@example.com', 'Visitor', 'unused-test-hash', id FROM roles "
                "WHERE name = 'attendee' RETURNING id"
            )).scalar_one()
            event = connection.execute(text(
                "INSERT INTO events (organizer_id, title, date, location, capacity, tickets_issued, status) "
                "VALUES (:owner, 'Legacy event', now(), 'Hall', 4, 1, 'published') RETURNING id"
            ), {"owner": owner}).scalar_one()
            active = connection.execute(text(
                "INSERT INTO tickets (event_id, attendee_id, qr_payload) "
                "VALUES (:event, :owner, 'old:active') RETURNING id"
            ), {"event": event, "owner": owner}).scalar_one()
            closed = connection.execute(text(
                "INSERT INTO tickets (event_id, attendee_id, qr_payload, status, status_changed_at, status_changed_by_id) "
                "VALUES (:event, :visitor, 'old:closed', 'cancelled', now(), :visitor) RETURNING id"
            ), {"event": event, "visitor": visitor}).scalar_one()
            receipt = connection.execute(text(
                "INSERT INTO check_ins (ticket_id, event_id, staff_id, request_id) "
                "VALUES (:ticket, :event, :owner, :request) RETURNING id"
            ), {"event": event, "owner": owner, "ticket": active, "request": uuid.uuid4()}).scalar_one()
        command.upgrade(config, "head")
        with engine.connect() as connection:
            kind = connection.execute(text(
                "SELECT id, event_id, quantity, tickets_issued, price_tiyn, is_default FROM ticket_types"
            )).one()
            assert tuple(kind[1:]) == (event, 4, 1, 0, True)
            assert connection.execute(text(
                "SELECT id, qr_payload, status, ticket_type_id FROM tickets ORDER BY id"
            )).all() == [(active, "old:active", "active", kind.id), (closed, "old:closed", "cancelled", kind.id)]
            assert connection.execute(text("SELECT id, ticket_id FROM check_ins")).one() == (receipt, active)
        command.downgrade(config, "0003")
        assert "ticket_types" not in inspect(engine).get_table_names()
        with engine.connect() as connection:
            assert connection.execute(text("SELECT id, status FROM tickets ORDER BY id")).all() == [
                (active, "active"), (closed, "cancelled"),
            ]
            assert connection.execute(text("SELECT id, ticket_id FROM check_ins")).one() == (receipt, active)
        command.upgrade(config, "head")
        with engine.begin() as connection:
            connection.execute(text("UPDATE ticket_types SET quantity = 3"))
        with pytest.raises(RuntimeError, match="Cannot downgrade below"):
            command.downgrade(config, "0003")
        with engine.connect() as connection:
            assert connection.execute(text("SELECT quantity FROM ticket_types")).scalar_one() == 3
    finally:
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
            type_id = connection.execute(text(
                "INSERT INTO ticket_types (event_id, name, quantity, tickets_issued, is_default) "
                "VALUES (:event, 'Бесплатный', 10, 2, true) RETURNING id"
            ), {"event": event_id}).scalar_one()
            ticket_ids = []
            for label in ("first", "second"):
                ticket_ids.append(connection.execute(text(
                    "INSERT INTO tickets (event_id, attendee_id, ticket_type_id, qr_payload) "
                    "VALUES (:event, :attendee, :type, :qr) RETURNING id"
                ), {"event": event_id, "attendee": users[label], "type": type_id, "qr": f"integrity:{label}"}).scalar_one())
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
            ("INSERT INTO tickets (event_id, attendee_id, ticket_type_id, qr_payload) VALUES (-1, :user, :type, 'orphan-event')", {"user": users["first"], "type": type_id}),
            ("INSERT INTO tickets (event_id, attendee_id, ticket_type_id, qr_payload) VALUES (:event, -1, :type, 'orphan-user')", {"event": event_id, "type": type_id}),
            ("INSERT INTO event_staff (event_id, user_id) VALUES (:event, -1)", {"event": event_id}),
            ("DELETE FROM events WHERE id = :event", {"event": event_id}),
            ("DELETE FROM users WHERE id = :user", {"user": users["first"]}),
            ("DELETE FROM users WHERE id = :user", {"user": users["scanner"]}),
            ("INSERT INTO tickets (event_id, attendee_id, ticket_type_id, qr_payload) VALUES (:event, :user, :type, 'integrity:first')",
             {"event": event_id, "user": users["scanner"], "type": type_id}),
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
