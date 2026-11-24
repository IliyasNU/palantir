"""Allow a settled, zero-value order for free registration without a reservation deadline."""
import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = depends_on = None

AMOUNTS = (
    " AND discount_tiyn >= 0 AND total_tiyn >= 0 AND total_tiyn = subtotal_tiyn - discount_tiyn "
    "AND ((campaign_id IS NULL AND promo_code IS NULL AND discount_tiyn = 0) OR "
    "(campaign_id IS NOT NULL AND promo_code IS NOT NULL)) AND processing_fee_tiyn >= 0 "
    "AND processing_fee_tiyn <= total_tiyn"
)
FREE_OR_CHECKOUT = (
    "((subtotal_tiyn > 0 AND expires_at IS NOT NULL) OR "
    "(subtotal_tiyn = 0 AND status = 'paid' AND expires_at IS NULL AND campaign_id IS NULL "
    "AND processing_fee_bps = 0))"
)
NAME = "ck_orders_order_money_valid"


def upgrade():
    with op.batch_alter_table("orders") as batch:
        batch.drop_constraint(op.f(NAME), type_="check")
        batch.alter_column("attendee_name", existing_type=sa.String(200), type_=sa.String(255))
        batch.alter_column("expires_at", existing_type=sa.DateTime(timezone=True), nullable=True)
        batch.create_check_constraint(op.f(NAME), FREE_OR_CHECKOUT + AMOUNTS)


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT EXISTS (SELECT 1 FROM orders WHERE subtotal_tiyn = 0)")):
        raise RuntimeError("Cannot downgrade below 0012: free registration orders would be lost")
    if op.get_bind().scalar(sa.text("SELECT EXISTS (SELECT 1 FROM orders WHERE length(attendee_name) > 200)")):
        raise RuntimeError("Cannot downgrade below 0012: order names would be truncated")
    with op.batch_alter_table("orders") as batch:
        batch.drop_constraint(op.f(NAME), type_="check")
        batch.alter_column("attendee_name", existing_type=sa.String(255), type_=sa.String(200))
        batch.alter_column("expires_at", existing_type=sa.DateTime(timezone=True), nullable=False)
        batch.create_check_constraint(op.f(NAME), "subtotal_tiyn > 0" + AMOUNTS)
