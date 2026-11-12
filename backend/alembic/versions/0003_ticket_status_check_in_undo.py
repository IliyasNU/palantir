"""ticket status (active/cancelled/refunded) and check-in undo history

Existing tickets become ``active`` and existing check-ins stay current admissions, so nothing changes for
data created before this revision. The one-check-in-per-ticket rule moves from a unique constraint to a
partial unique index over the rows that are not undone.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-10
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

NOT_UNDONE = sa.text("undone_at IS NULL")


def upgrade() -> None:
    with op.batch_alter_table("tickets") as batch:
        batch.add_column(sa.Column("status", sa.String(length=20), server_default="active", nullable=False))
        batch.add_column(sa.Column("status_changed_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("status_changed_by_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(
            op.f("fk_tickets_status_changed_by_id_users"), "users", ["status_changed_by_id"], ["id"],
            ondelete="RESTRICT",
        )
        batch.create_check_constraint(
            op.f("ck_tickets_status_valid"), "status IN ('active', 'cancelled', 'refunded')"
        )
        batch.create_check_constraint(
            op.f("ck_tickets_status_change_recorded"),
            "(status = 'active') = (status_changed_at IS NULL) "
            "AND (status_changed_at IS NULL) = (status_changed_by_id IS NULL)",
        )

    with op.batch_alter_table("check_ins") as batch:
        batch.add_column(sa.Column("undone_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("undone_by_id", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("undo_request_id", sa.Uuid(), nullable=True))
        batch.create_foreign_key(
            op.f("fk_check_ins_undone_by_id_users"), "users", ["undone_by_id"], ["id"], ondelete="RESTRICT"
        )
        batch.create_unique_constraint(op.f("uq_check_ins_undo_request_id"), ["undo_request_id"])
        batch.create_check_constraint(
            op.f("ck_check_ins_undo_recorded"),
            "(undone_at IS NULL) = (undone_by_id IS NULL) AND (undone_at IS NULL) = (undo_request_id IS NULL)",
        )
        batch.drop_constraint(op.f("uq_check_ins_ticket_id"), type_="unique")
        batch.create_index(op.f("ix_check_ins_ticket_id"), ["ticket_id"], unique=False)
    # Every existing row is a current admission and the old constraint kept them unique, so this cannot fail.
    op.create_index(
        "uq_check_ins_active_ticket_id", "check_ins", ["ticket_id"], unique=True,
        postgresql_where=NOT_UNDONE, sqlite_where=NOT_UNDONE,
    )


def downgrade() -> None:
    # Revision 0002 cannot express either state: a cancelled or refunded ticket would be admitted again and
    # an undone check-in would read as a current admission. Refuse instead of changing what the data means.
    connection = op.get_bind()
    closed = connection.execute(sa.text("SELECT count(*) FROM tickets WHERE status <> 'active'")).scalar_one()
    undone = connection.execute(sa.text("SELECT count(*) FROM check_ins WHERE undone_at IS NOT NULL")).scalar_one()
    if closed or undone:
        raise RuntimeError(
            f"Cannot downgrade below 0003: {closed} cancelled or refunded ticket(s) and {undone} undone "
            "check-in(s) have no representation in the older schema."
        )

    op.drop_index("uq_check_ins_active_ticket_id", table_name="check_ins")
    with op.batch_alter_table("check_ins") as batch:
        batch.drop_index(op.f("ix_check_ins_ticket_id"))
        batch.create_unique_constraint(op.f("uq_check_ins_ticket_id"), ["ticket_id"])
        batch.drop_constraint(op.f("ck_check_ins_undo_recorded"), type_="check")
        batch.drop_constraint(op.f("uq_check_ins_undo_request_id"), type_="unique")
        batch.drop_constraint(op.f("fk_check_ins_undone_by_id_users"), type_="foreignkey")
        batch.drop_column("undo_request_id")
        batch.drop_column("undone_by_id")
        batch.drop_column("undone_at")

    with op.batch_alter_table("tickets") as batch:
        batch.drop_constraint(op.f("ck_tickets_status_change_recorded"), type_="check")
        batch.drop_constraint(op.f("ck_tickets_status_valid"), type_="check")
        batch.drop_constraint(op.f("fk_tickets_status_changed_by_id_users"), type_="foreignkey")
        batch.drop_column("status_changed_by_id")
        batch.drop_column("status_changed_at")
        batch.drop_column("status")
