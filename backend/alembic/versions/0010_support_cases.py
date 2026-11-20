"""support cases and their message threads (SRS 4.13)

Revision 0010 follows the promo campaign migration.

Revision ID: 0010
Revises: 0009
Create Date: 2026-11-15
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0010"
down_revision: Union[str, None] = "0009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

KINDS = "kind IN ('attendee', 'organizer')"
STATUSES = "status IN ('open', 'in_progress', 'waiting_for_customer', 'resolved')"
CATEGORIES = (
    "category IN ('ticket_delivery', 'payment', 'refund', 'seating', 'event_information', 'check_in', "
    "'account', 'technical', 'activation')"
)
SIDES = "IN ('requester', 'staff')"


def upgrade() -> None:
    op.create_table(
        "support_cases",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("requester_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("event_id", sa.Integer(), sa.ForeignKey("events.id", ondelete="RESTRICT"), nullable=True),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("orders.id", ondelete="RESTRICT"), nullable=True),
        sa.Column("ticket_id", sa.Integer(), sa.ForeignKey("tickets.id", ondelete="RESTRICT"), nullable=True),
        sa.Column("category", sa.String(30), nullable=False),
        sa.Column("subject", sa.String(200), nullable=False),
        sa.Column("status", sa.String(30), server_default="open", nullable=False),
        sa.Column("assignee_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_message_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_message_by", sa.String(20), nullable=False),
        sa.CheckConstraint(KINDS, name=op.f("ck_support_cases_kind_valid")),
        sa.CheckConstraint(STATUSES, name=op.f("ck_support_cases_status_valid")),
        sa.CheckConstraint(CATEGORIES, name=op.f("ck_support_cases_category_valid")),
        sa.CheckConstraint(f"last_message_by {SIDES}", name=op.f("ck_support_cases_last_message_by_valid")),
        sa.CheckConstraint("kind = 'organizer' OR event_id IS NOT NULL",
                           name=op.f("ck_support_cases_attendee_case_has_event")),
    )
    op.create_index(op.f("ix_support_cases_requester_id"), "support_cases", ["requester_id"])
    op.create_index(op.f("ix_support_cases_event_id"), "support_cases", ["event_id"])
    op.create_index(op.f("ix_support_cases_status"), "support_cases", ["status"])
    op.create_table(
        "support_messages",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("case_id", sa.Integer(), sa.ForeignKey("support_cases.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("author_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("author_side", sa.String(20), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(f"author_side {SIDES}", name=op.f("ck_support_messages_author_side_valid")),
    )
    op.create_index(op.f("ix_support_messages_case_id"), "support_messages", ["case_id"])


def downgrade() -> None:
    # The older schema has nowhere to keep a case or its thread. Refuse instead of deleting people's requests.
    cases = op.get_bind().execute(sa.text("SELECT count(*) FROM support_cases")).scalar_one()
    if cases:
        raise RuntimeError(f"Cannot downgrade below 0010: {cases} support case(s) and their messages would be lost.")
    op.drop_index(op.f("ix_support_messages_case_id"), table_name="support_messages")
    op.drop_table("support_messages")
    op.drop_index(op.f("ix_support_cases_status"), table_name="support_cases")
    op.drop_index(op.f("ix_support_cases_event_id"), table_name="support_cases")
    op.drop_index(op.f("ix_support_cases_requester_id"), table_name="support_cases")
    op.drop_table("support_cases")
