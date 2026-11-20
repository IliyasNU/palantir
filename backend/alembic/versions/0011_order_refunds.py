"""Event refund policies and full order refunds.

Revision ID: 0011
Revises: 0010
"""
import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None

ORIGINAL_STATUS = "status IN ('pending', 'paid', 'failed', 'cancelled', 'expired')"
REFUND_STATUS = "status IN ('pending', 'paid', 'failed', 'cancelled', 'expired', 'refunded')"
ORIGINAL_TICKET = "(status = 'paid') = (ticket_id IS NOT NULL)"
REFUND_TICKET = "(status IN ('paid', 'refunded')) = (ticket_id IS NOT NULL)"
REFUND_RECORDED = "(status = 'refunded') = (refunded_at IS NOT NULL)"


def upgrade():
    op.add_column("events", sa.Column("refund_policy", sa.String(2000), nullable=True))
    with op.batch_alter_table("orders") as batch:
        batch.add_column(sa.Column("refunded_at", sa.DateTime(timezone=True), nullable=True))
        batch.drop_constraint(op.f("ck_orders_order_status_valid"), type_="check")
        batch.drop_constraint(op.f("ck_orders_order_ticket_paid"), type_="check")
        batch.create_check_constraint(op.f("ck_orders_order_status_valid"), REFUND_STATUS)
        batch.create_check_constraint(op.f("ck_orders_order_ticket_paid"), REFUND_TICKET)
        batch.create_check_constraint(op.f("ck_orders_order_refund_recorded"), REFUND_RECORDED)


def downgrade():
    connection = op.get_bind()
    if connection.execute(sa.text("SELECT EXISTS(SELECT 1 FROM orders WHERE refunded_at IS NOT NULL)")).scalar_one():
        raise RuntimeError("Cannot downgrade below 0011: order refunds would be lost")
    if connection.execute(sa.text("SELECT EXISTS(SELECT 1 FROM events WHERE refund_policy IS NOT NULL)")).scalar_one():
        raise RuntimeError("Cannot downgrade below 0011: event refund policies would be lost")
    with op.batch_alter_table("orders") as batch:
        batch.drop_constraint(op.f("ck_orders_order_refund_recorded"), type_="check")
        batch.drop_constraint(op.f("ck_orders_order_status_valid"), type_="check")
        batch.drop_constraint(op.f("ck_orders_order_ticket_paid"), type_="check")
        batch.drop_column("refunded_at")
        batch.create_check_constraint(op.f("ck_orders_order_status_valid"), ORIGINAL_STATUS)
        batch.create_check_constraint(op.f("ck_orders_order_ticket_paid"), ORIGINAL_TICKET)
    with op.batch_alter_table("events") as batch:
        batch.drop_column("refund_policy")
