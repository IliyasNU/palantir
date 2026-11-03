"""event status + ticket counter, tickets, event_staff, check_ins

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-03
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("events") as batch:
        batch.add_column(sa.Column("status", sa.String(length=20), server_default="draft", nullable=False))
        batch.add_column(sa.Column("tickets_issued", sa.Integer(), server_default="0", nullable=False))
        batch.create_check_constraint(op.f("ck_events_status_valid"), "status IN ('draft', 'published', 'cancelled')")
        batch.create_check_constraint(
            op.f("ck_events_tickets_within_capacity"), "tickets_issued >= 0 AND tickets_issued <= capacity"
        )

    op.create_table(
        "tickets",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("event_id", sa.Integer(), nullable=False),
        sa.Column("attendee_id", sa.Integer(), nullable=False),
        sa.Column("qr_payload", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ["event_id"], ["events.id"], name=op.f("fk_tickets_event_id_events"), ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["attendee_id"], ["users.id"], name=op.f("fk_tickets_attendee_id_users"), ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_tickets")),
        sa.UniqueConstraint("qr_payload", name=op.f("uq_tickets_qr_payload")),
        sa.UniqueConstraint("event_id", "attendee_id", name="uq_tickets_event_id_attendee_id"),
    )
    op.create_index(op.f("ix_tickets_event_id"), "tickets", ["event_id"], unique=False)
    op.create_index(op.f("ix_tickets_attendee_id"), "tickets", ["attendee_id"], unique=False)

    op.create_table(
        "event_staff",
        sa.Column("event_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ["event_id"], ["events.id"], name=op.f("fk_event_staff_event_id_events"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_event_staff_user_id_users"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("event_id", "user_id", name=op.f("pk_event_staff")),
    )
    op.create_index(op.f("ix_event_staff_user_id"), "event_staff", ["user_id"], unique=False)

    op.create_table(
        "check_ins",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("ticket_id", sa.Integer(), nullable=False),
        sa.Column("event_id", sa.Integer(), nullable=False),
        sa.Column("staff_id", sa.Integer(), nullable=False),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("checked_in_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ["ticket_id"], ["tickets.id"], name=op.f("fk_check_ins_ticket_id_tickets"), ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["event_id"], ["events.id"], name=op.f("fk_check_ins_event_id_events"), ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["staff_id"], ["users.id"], name=op.f("fk_check_ins_staff_id_users"), ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_check_ins")),
        sa.UniqueConstraint("ticket_id", name=op.f("uq_check_ins_ticket_id")),
        sa.UniqueConstraint("request_id", name=op.f("uq_check_ins_request_id")),
    )
    op.create_index(op.f("ix_check_ins_event_id"), "check_ins", ["event_id"], unique=False)
    op.create_index(op.f("ix_check_ins_staff_id"), "check_ins", ["staff_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_check_ins_staff_id"), table_name="check_ins")
    op.drop_index(op.f("ix_check_ins_event_id"), table_name="check_ins")
    op.drop_table("check_ins")
    op.drop_index(op.f("ix_event_staff_user_id"), table_name="event_staff")
    op.drop_table("event_staff")
    op.drop_index(op.f("ix_tickets_attendee_id"), table_name="tickets")
    op.drop_index(op.f("ix_tickets_event_id"), table_name="tickets")
    op.drop_table("tickets")
    with op.batch_alter_table("events") as batch:
        batch.drop_constraint(op.f("ck_events_tickets_within_capacity"), type_="check")
        batch.drop_constraint(op.f("ck_events_status_valid"), type_="check")
        batch.drop_column("tickets_issued")
        batch.drop_column("status")
