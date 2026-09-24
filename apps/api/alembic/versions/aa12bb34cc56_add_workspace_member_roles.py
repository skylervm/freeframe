"""add workspace member roles

Revision ID: aa12bb34cc56
Revises: a1b2c3d4e5f6
"""
from alembic import op


revision = "aa12bb34cc56"
down_revision = "a1b2c3d4e5f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TYPE workspacerole RENAME VALUE 'member' TO 'viewer'")
    op.execute("ALTER TYPE workspacerole ADD VALUE IF NOT EXISTS 'reviewer'")
    op.execute("ALTER TYPE workspacerole ADD VALUE IF NOT EXISTS 'editor'")
    op.execute("ALTER TABLE workspace_members ALTER COLUMN role SET DEFAULT 'viewer'")


def downgrade() -> None:
    op.execute("ALTER TABLE workspace_members ALTER COLUMN role DROP DEFAULT")
    op.execute("ALTER TYPE workspacerole RENAME TO workspacerole_old")
    op.execute("CREATE TYPE workspacerole AS ENUM ('owner', 'member')")
    op.execute("ALTER TABLE workspace_members ALTER COLUMN role TYPE workspacerole USING CASE WHEN role::text = 'owner' THEN 'owner'::workspacerole ELSE 'member'::workspacerole END")
    op.execute("DROP TYPE workspacerole_old")
    op.execute("ALTER TABLE workspace_members ALTER COLUMN role SET DEFAULT 'member'")
