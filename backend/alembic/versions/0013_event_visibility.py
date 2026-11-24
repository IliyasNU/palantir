"""Define event visibility. Existing events retain public visibility."""
import sqlalchemy as sa
from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = depends_on = None


def upgrade():
    with op.batch_alter_table("events") as batch:
        batch.add_column(sa.Column("visibility", sa.String(12), nullable=False, server_default="public"))
        batch.create_check_constraint(op.f("ck_events_visibility_valid"), "visibility IN ('public', 'unlisted', 'private')")


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT EXISTS (SELECT 1 FROM events WHERE visibility <> 'public')")):
        raise RuntimeError("Cannot downgrade below 0013: restricted event visibility would be lost")
    with op.batch_alter_table("events") as batch:
        batch.drop_constraint(op.f("ck_events_visibility_valid"), type_="check")
        batch.drop_column("visibility")
