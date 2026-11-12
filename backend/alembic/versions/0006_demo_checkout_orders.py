"""Simulated paid activation and one-ticket orders. Revision 0006 follows 0005."""
import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("organizer_profiles", sa.Column("demo_identity_confirmed_at", sa.DateTime(timezone=True)))
    op.add_column("organizer_profiles", sa.Column("demo_payout_last4", sa.String(4)))
    op.create_table(
        "paid_sales_activations",
        sa.Column("event_id", sa.Integer(), sa.ForeignKey("events.id", ondelete="RESTRICT"), primary_key=True),
        sa.Column("terms_accepted_at", sa.DateTime(timezone=True)),
        sa.Column("fee_paid_at", sa.DateTime(timezone=True)),
        sa.Column("fee_tiyn", sa.Integer()),
        sa.Column("activated_at", sa.DateTime(timezone=True)),
        sa.Column("suspended_at", sa.DateTime(timezone=True)),
        sa.Column("suspension_reason", sa.String(300)),
    )
    op.create_table(
        "orders",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("event_id", sa.Integer(), sa.ForeignKey("events.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("ticket_type_id", sa.Integer(), sa.ForeignKey("ticket_types.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("buyer_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("request_id", sa.String(36), nullable=False),
        sa.Column("attendee_name", sa.String(200), nullable=False),
        sa.Column("attendee_email", sa.String(255), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("subtotal_tiyn", sa.Integer(), nullable=False),
        sa.Column("processing_fee_tiyn", sa.Integer(), nullable=False),
        sa.Column("processing_fee_bps", sa.Integer(), nullable=False),
        sa.Column("total_tiyn", sa.Integer(), nullable=False),
        sa.Column("ticket_id", sa.Integer(), sa.ForeignKey("tickets.id", ondelete="RESTRICT"), unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("buyer_id", "request_id", name="uq_orders_buyer_request"),
        sa.CheckConstraint("status IN ('pending', 'paid', 'failed', 'cancelled', 'expired')", name="order_status_valid"),
        sa.CheckConstraint("subtotal_tiyn > 0 AND total_tiyn = subtotal_tiyn AND processing_fee_tiyn >= 0 "
                           "AND processing_fee_tiyn <= subtotal_tiyn", name="order_money_valid"),
        sa.CheckConstraint("(status = 'paid') = (ticket_id IS NOT NULL)", name="order_ticket_paid"),
    )
    for column in ("event_id", "buyer_id", "expires_at"):
        op.create_index(f"ix_orders_{column}", "orders", [column])
    op.create_index("uq_orders_pending_buyer_event", "orders", ["event_id", "buyer_id"], unique=True,
                    postgresql_where=sa.text("status = 'pending'"), sqlite_where=sa.text("status = 'pending'"))


def downgrade() -> None:
    db = op.get_bind()
    orders = db.execute(sa.text("SELECT count(*) FROM orders")).scalar_one()
    activations = db.execute(sa.text("SELECT count(*) FROM paid_sales_activations")).scalar_one()
    profiles = db.execute(sa.text("SELECT count(*) FROM organizer_profiles WHERE "
                                  "demo_identity_confirmed_at IS NOT NULL OR demo_payout_last4 IS NOT NULL")).scalar_one()
    if orders or activations or profiles:
        raise RuntimeError("Cannot downgrade below 0006: demo orders, activations or profile confirmations would be lost")
    op.drop_table("orders")
    op.drop_table("paid_sales_activations")
    with op.batch_alter_table("organizer_profiles") as batch:
        batch.drop_column("demo_payout_last4")
        batch.drop_column("demo_identity_confirmed_at")
