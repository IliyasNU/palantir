"""P3 campaign links and order discount snapshots. Revision 0009 follows 0008."""
import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = depends_on = None

original_money = ("subtotal_tiyn > 0 AND total_tiyn = subtotal_tiyn AND processing_fee_tiyn >= 0 "
                  "AND processing_fee_tiyn <= subtotal_tiyn")
campaign_money = ("subtotal_tiyn > 0 AND discount_tiyn >= 0 AND total_tiyn >= 0 AND total_tiyn = subtotal_tiyn - discount_tiyn "
                  "AND ((campaign_id IS NULL AND promo_code IS NULL AND discount_tiyn = 0) OR "
                  "(campaign_id IS NOT NULL AND promo_code IS NOT NULL)) AND processing_fee_tiyn >= 0 "
                  "AND processing_fee_tiyn <= total_tiyn")


def upgrade():
    op.create_table("campaigns",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("event_id", sa.Integer, sa.ForeignKey("events.id"), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("code", sa.String(20), unique=True, nullable=False),
        sa.Column("token", sa.String(40), unique=True, nullable=False),
        sa.Column("kind", sa.String(8), nullable=False),
        sa.Column("value", sa.Integer, nullable=False),
        sa.Column("max_uses", sa.Integer, nullable=False),
        sa.Column("enabled", sa.Boolean, nullable=False),
        sa.Column("starts_at", sa.DateTime(timezone=True)),
        sa.Column("ends_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint("value > 0 AND ((kind = 'percent' AND value <= 100) OR kind = 'fixed')", name="campaign_value"),
        sa.CheckConstraint("max_uses > 0", name="campaign_limit"),
        sa.CheckConstraint("starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at", name="campaign_window"))
    op.create_index("ix_campaigns_event_id", "campaigns", ["event_id"])
    op.create_table("campaign_types",
        sa.Column("campaign_id", sa.Integer, sa.ForeignKey("campaigns.id"), primary_key=True),
        sa.Column("ticket_type_id", sa.Integer, sa.ForeignKey("ticket_types.id"), primary_key=True))
    with op.batch_alter_table("orders") as batch:
        batch.add_column(sa.Column("discount_tiyn", sa.Integer, server_default="0", nullable=False))
        batch.add_column(sa.Column("promo_code", sa.String(20)))
        batch.add_column(sa.Column("campaign_id", sa.Integer))
        batch.create_foreign_key("fk_orders_campaign_id_campaigns", "campaigns", ["campaign_id"], ["id"])
        batch.create_index("ix_orders_campaign_id", ["campaign_id"])
        batch.drop_constraint(op.f("ck_orders_order_money_valid"), type_="check")
        batch.create_check_constraint(op.f("ck_orders_order_money_valid"), campaign_money)


def downgrade():
    if op.get_bind().execute(sa.text("SELECT count(*) FROM campaigns")).scalar_one():
        raise RuntimeError("Cannot downgrade below 0009: campaign data would be lost")
    with op.batch_alter_table("orders") as batch:
        batch.drop_constraint(op.f("ck_orders_order_money_valid"), type_="check")
        batch.drop_constraint("fk_orders_campaign_id_campaigns", type_="foreignkey")
        batch.drop_index("ix_orders_campaign_id")
        batch.drop_column("campaign_id")
        batch.drop_column("promo_code")
        batch.drop_column("discount_tiyn")
        batch.create_check_constraint(op.f("ck_orders_order_money_valid"), original_money)
    op.drop_table("campaign_types")
    op.drop_table("campaigns")
