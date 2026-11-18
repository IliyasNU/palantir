"""ticket type inventory and append-only event action log

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-11
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "ticket_types",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("event_id", sa.Integer(), sa.ForeignKey("events.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("price_tiyn", sa.Integer(), server_default="0", nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("tickets_issued", sa.Integer(), server_default="0", nullable=False),
        sa.Column("sales_start", sa.DateTime(timezone=True), nullable=True),
        sa.Column("sales_end", sa.DateTime(timezone=True), nullable=True),
        sa.Column("order_limit", sa.Integer(), server_default="1", nullable=False),
        sa.Column("hidden", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("is_default", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("price_tiyn >= 0", name=op.f("ck_ticket_types_price_nonnegative")),
        sa.CheckConstraint("quantity >= 0 AND tickets_issued >= 0 AND tickets_issued <= quantity",
                           name=op.f("ck_ticket_types_tickets_within_quantity")),
        sa.CheckConstraint("order_limit >= 1", name=op.f("ck_ticket_types_order_limit_positive")),
        sa.CheckConstraint("sales_start IS NULL OR sales_end IS NULL OR sales_start < sales_end",
                           name=op.f("ck_ticket_types_sales_window_valid")),
    )
    op.create_index(op.f("ix_ticket_types_event_id"), "ticket_types", ["event_id"])
    op.create_index("uq_ticket_types_default_event", "ticket_types", ["event_id"], unique=True,
                    postgresql_where=sa.text("is_default"), sqlite_where=sa.text("is_default = 1"))
    op.create_table(
        "action_logs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("event_id", sa.Integer(), sa.ForeignKey("events.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("actor_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("action", sa.String(80), nullable=False),
        sa.Column("entity_type", sa.String(80), nullable=False),
        sa.Column("entity_id", sa.Integer(), nullable=False),
        sa.Column("description", sa.String(500), nullable=False),
    )
    op.create_index(op.f("ix_action_logs_event_id"), "action_logs", ["event_id"])

    # No historical actor is invented. Every old ticket keeps its ID, QR, state and admission history.
    connection = op.get_bind()
    connection.execute(sa.text(
        "INSERT INTO ticket_types (event_id, name, price_tiyn, quantity, tickets_issued, is_default) "
        "SELECT e.id, :name, 0, e.capacity, "
        "(SELECT count(*) FROM tickets t WHERE t.event_id = e.id AND t.status = 'active'), true FROM events e"
    ), {"name": "Бесплатный"})
    with op.batch_alter_table("tickets") as batch:
        batch.add_column(sa.Column("ticket_type_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(op.f("fk_tickets_ticket_type_id_ticket_types"), "ticket_types",
                                 ["ticket_type_id"], ["id"], ondelete="RESTRICT")
        batch.create_index(op.f("ix_tickets_ticket_type_id"), ["ticket_type_id"])
    connection.execute(sa.text(
        "UPDATE tickets SET ticket_type_id = "
        "(SELECT id FROM ticket_types WHERE ticket_types.event_id = tickets.event_id AND is_default)"
    ))
    with op.batch_alter_table("tickets") as batch:
        batch.alter_column("ticket_type_id", existing_type=sa.Integer(), nullable=False)


def downgrade() -> None:
    # Only the unmodified generated free types have a lossless representation in revision 0003.
    # Check everything before touching the schema, including append-only history.
    connection = op.get_bind()
    audit_count = connection.execute(sa.text("SELECT count(*) FROM action_logs")).scalar_one()
    configured = connection.execute(sa.text(
        "SELECT count(*) FROM ticket_types tt JOIN events e ON e.id = tt.event_id "
        "WHERE NOT tt.is_default OR tt.name <> :name OR tt.description IS NOT NULL "
        "OR tt.price_tiyn <> 0 OR tt.quantity <> e.capacity OR tt.sales_start IS NOT NULL "
        "OR tt.sales_end IS NOT NULL OR tt.order_limit <> 1 OR tt.hidden"
    ), {"name": "Бесплатный"}).scalar_one()
    mismatched = connection.execute(sa.text(
        "SELECT count(*) FROM tickets t JOIN ticket_types tt ON tt.id = t.ticket_type_id "
        "WHERE tt.event_id <> t.event_id OR NOT tt.is_default"
    )).scalar_one()
    if audit_count or configured or mismatched:
        raise RuntimeError(
            "Cannot downgrade below 0004: configured ticket types or action history would lose data."
        )
    with op.batch_alter_table("tickets") as batch:
        batch.drop_index(op.f("ix_tickets_ticket_type_id"))
        batch.drop_constraint(op.f("fk_tickets_ticket_type_id_ticket_types"), type_="foreignkey")
        batch.drop_column("ticket_type_id")
    op.drop_index(op.f("ix_action_logs_event_id"), table_name="action_logs")
    op.drop_table("action_logs")
    op.drop_index("uq_ticket_types_default_event", table_name="ticket_types")
    op.drop_index(op.f("ix_ticket_types_event_id"), table_name="ticket_types")
    op.drop_table("ticket_types")
