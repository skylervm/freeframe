"""add hardened terminal bootstrap automation

Revision ID: fa10b2c3d4e5
Revises: e4f6a8c0d2b4
Create Date: 2026-09-04
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "fa10b2c3d4e5"
down_revision: Union[str, Sequence[str], None] = "e4f6a8c0d2b4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("project_automation_tokens", sa.Column("max_file_bytes", sa.BigInteger(), nullable=True))
    op.add_column("project_automation_tokens", sa.Column("max_total_upload_bytes", sa.BigInteger(), nullable=True))
    op.add_column("project_automation_tokens", sa.Column("reserved_upload_bytes", sa.BigInteger(), nullable=False, server_default="0"))
    op.create_table(
        "automation_bootstrap_requests",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("idempotency_key", sa.String(length=64), nullable=False),
        sa.Column("request_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("token_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("project_automation_tokens.id"), nullable=False),
        sa.Column("owner_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("idempotency_key", name="uq_automation_bootstrap_request_key"),
    )
    op.create_table(
        "automation_bootstrap_renewals",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("idempotency_key", sa.String(length=64), nullable=False),
        sa.Column("request_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("token_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("project_automation_tokens.id"), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("idempotency_key", name="uq_automation_bootstrap_renewal_key"),
    )


def downgrade() -> None:
    op.drop_table("automation_bootstrap_renewals")
    op.drop_table("automation_bootstrap_requests")
    op.drop_column("project_automation_tokens", "reserved_upload_bytes")
    op.drop_column("project_automation_tokens", "max_total_upload_bytes")
    op.drop_column("project_automation_tokens", "max_file_bytes")
