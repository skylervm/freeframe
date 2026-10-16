"""add clip render jobs

Revision ID: dd45ee67ff89
Revises: cc34dd56ee78
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "dd45ee67ff89"
down_revision = "cc34dd56ee78"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "clip_render_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("asset_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("assets.id", ondelete="CASCADE"), nullable=False),
        sa.Column("version_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("asset_versions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("requested_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="queued"),
        sa.Column("ranges", postgresql.JSONB(), nullable=False),
        sa.Column("ranges_hash", sa.String(64), nullable=False),
        sa.Column("clips_rendered", sa.Integer(), nullable=True),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("claim_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("status IN ('queued', 'claimed', 'done', 'failed', 'cancelled')", name="ck_clip_render_jobs_status"),
    )
    op.create_index("ix_clip_render_jobs_project_status", "clip_render_jobs", ["project_id", "status"])


def downgrade() -> None:
    op.drop_index("ix_clip_render_jobs_project_status", table_name="clip_render_jobs")
    op.drop_table("clip_render_jobs")
