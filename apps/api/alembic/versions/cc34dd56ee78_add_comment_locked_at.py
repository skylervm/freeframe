"""add comment locked_at

Revision ID: cc34dd56ee78
Revises: bb23cc45dd67
"""
from alembic import op
import sqlalchemy as sa


revision = "cc34dd56ee78"
down_revision = "bb23cc45dd67"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("comments", sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("comments", "locked_at")
