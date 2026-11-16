"""email verification, token revocation and logout

``users.email_verified_at`` is set by the verification link. ``users.token_version`` is copied into every token;
a password reset increments it so all earlier tokens stop working. ``revoked_tokens`` holds refresh tokens ended
by logout. ``email_throttles`` limits verification and reset emails to one a minute. Existing accounts start
unverified at version 0, which matches tokens issued before this revision.

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-12
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("email_verified_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("users", sa.Column("token_version", sa.Integer(), server_default="0", nullable=False))
    op.create_table(
        "revoked_tokens",
        sa.Column("jti", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("jti", name=op.f("pk_revoked_tokens")),
    )
    op.create_index(op.f("ix_revoked_tokens_expires_at"), "revoked_tokens", ["expires_at"])
    op.create_table(
        "email_throttles",
        sa.Column("key", sa.String(length=320), nullable=False),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("key", name=op.f("pk_email_throttles")),
    )
    op.create_index(op.f("ix_email_throttles_requested_at"), "email_throttles", ["requested_at"])


def downgrade() -> None:
    op.drop_index(op.f("ix_email_throttles_requested_at"), table_name="email_throttles")
    op.drop_table("email_throttles")
    op.drop_index(op.f("ix_revoked_tokens_expires_at"), table_name="revoked_tokens")
    op.drop_table("revoked_tokens")
    with op.batch_alter_table("users") as batch:
        batch.drop_column("token_version")
        batch.drop_column("email_verified_at")
