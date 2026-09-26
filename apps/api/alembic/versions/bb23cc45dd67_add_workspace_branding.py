"""add workspace branding

Revision ID: bb23cc45dd67
Revises: aa12bb34cc56
"""
from alembic import op
import sqlalchemy as sa


revision = "bb23cc45dd67"
down_revision = "aa12bb34cc56"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("workspaces", sa.Column("logo_dark", sa.LargeBinary(), nullable=True))
    op.add_column("workspaces", sa.Column("logo_light", sa.LargeBinary(), nullable=True))
    op.add_column("workspaces", sa.Column("icon", sa.LargeBinary(), nullable=True))
    op.add_column("workspaces", sa.Column("branding_updated_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("workspaces", "branding_updated_at")
    op.drop_column("workspaces", "icon")
    op.drop_column("workspaces", "logo_light")
    op.drop_column("workspaces", "logo_dark")
