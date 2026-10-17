"""add clip runner tokens

Revision ID: ee56ff78aa90
Revises: dd45ee67ff89
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "ee56ff78aa90"
down_revision = "dd45ee67ff89"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "clip_runner_tokens",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("secret_hash", sa.String(64), nullable=False),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_clip_runner_tokens_created_by", "clip_runner_tokens", ["created_by"])


def downgrade() -> None:
    op.drop_index("ix_clip_runner_tokens_created_by", table_name="clip_runner_tokens")
    op.drop_table("clip_runner_tokens")
