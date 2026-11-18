"""Revision 0005 -> 0006 preserves populated data; downgrades never discard orders."""
import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, text

from app.db.base import Base
from e2e.test_postgres_schema import alembic_config, scratch_database  # noqa: F401


def test_0006_populated_upgrade_and_guard(scratch_database):
    config = alembic_config(scratch_database)
    engine = create_engine(scratch_database)
    try:
        command.upgrade(config, "0005")
        with engine.begin() as db:
            db.execute(text("INSERT INTO users (email, full_name, hashed_password, role_id) "
                            "SELECT 'migration@example.com', 'Existing owner', 'test', id FROM roles WHERE name='organizer'"))
            owner = db.execute(text("SELECT id FROM users")).scalar_one()
            db.execute(text("INSERT INTO organizer_profiles (user_id, organization_name) VALUES (:id, 'Existing profile')"), {"id": owner})
            eid = db.execute(text("INSERT INTO events (organizer_id,title,date,location,capacity,tickets_issued,status) "
                                  "VALUES (:id,'Existing event',now(),'Hall',3,1,'published') RETURNING id"), {"id": owner}).scalar_one()
            kind = db.execute(text("INSERT INTO ticket_types (event_id,name,quantity,tickets_issued) VALUES (:id,'Existing type',3,1) RETURNING id"), {"id": eid}).scalar_one()
            db.execute(text("INSERT INTO tickets (event_id,attendee_id,ticket_type_id,qr_payload) VALUES (:e,:u,:t,'legacy:qr')"), {"e": eid, "u": owner, "t": kind})
            before = db.execute(text("SELECT id,event_id,attendee_id,ticket_type_id,qr_payload,status FROM tickets")).all()
        command.upgrade(config, "0006")
        with engine.connect() as db:
            assert compare_metadata(MigrationContext.configure(db), Base.metadata) == []
            assert db.execute(text("SELECT id,event_id,attendee_id,ticket_type_id,qr_payload,status FROM tickets")).all() == before
            assert db.execute(text("SELECT demo_identity_confirmed_at,demo_payout_last4 FROM organizer_profiles")).one() == (None, None)
            assert db.execute(text("SELECT tickets_issued FROM events")).scalar_one() == 1
            assert db.execute(text("SELECT count(*) FROM orders")).scalar_one() == 0
        command.downgrade(config, "0005")
        command.upgrade(config, "0006")
        with engine.begin() as db:
            db.execute(text("INSERT INTO orders (event_id,ticket_type_id,buyer_id,request_id,attendee_name,attendee_email,"
                            "status,subtotal_tiyn,processing_fee_tiyn,processing_fee_bps,total_tiyn,created_at,expires_at) "
                            "VALUES (:e,:t,:u,'migration-key','Demo','demo@example.com','expired',100,3,300,100,now(),now())"),
                       {"e": eid, "t": kind, "u": owner})
        with pytest.raises(RuntimeError, match="Cannot downgrade below 0006"):
            command.downgrade(config, "0005")
        with engine.connect() as db:
            assert db.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == "0006"
            assert db.execute(text("SELECT count(*) FROM orders")).scalar_one() == 1
    finally:
        engine.dispose()
