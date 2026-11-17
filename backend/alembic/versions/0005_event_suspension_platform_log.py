"""event suspension and platform-level action log entries

``events.suspended_at`` marks an event a platform admin has suspended. ``action_logs.event_id`` becomes
nullable so actions that belong to no event (suspending a user account) can be recorded.

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-11
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("events", sa.Column("suspended_at", sa.DateTime(timezone=True), nullable=True))
    with op.batch_alter_table("action_logs") as batch:
        batch.alter_column("event_id", existing_type=sa.Integer(), nullable=True)


def downgrade() -> None:
    # Revision 0004 cannot express either state: a suspended event would go back on sale and a platform
    # action would lose its record. Refuse instead of changing what the data means.
    connection = op.get_bind()
    suspended = connection.execute(sa.text("SELECT count(*) FROM events WHERE suspended_at IS NOT NULL")).scalar_one()
    platform = connection.execute(sa.text("SELECT count(*) FROM action_logs WHERE event_id IS NULL")).scalar_one()
    if suspended or platform:
        raise RuntimeError(
            f"Cannot downgrade below 0005: {suspended} suspended event(s) and {platform} platform action log "
            "record(s) have no representation in the older schema."
        )
    with op.batch_alter_table("action_logs") as batch:
        batch.alter_column("event_id", existing_type=sa.Integer(), nullable=False)
    with op.batch_alter_table("events") as batch:
        batch.drop_column("suspended_at")
