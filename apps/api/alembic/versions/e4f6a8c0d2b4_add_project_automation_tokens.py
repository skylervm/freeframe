"""add project-scoped automation tokens

Revision ID: e4f6a8c0d2b4
Revises: b2c4d6e8f0a1
Create Date: 2026-09-03
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "e4f6a8c0d2b4"
down_revision: Union[str, Sequence[str], None] = "b2c4d6e8f0a1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "project_automation_tokens",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("secret_hash", sa.String(length=64), nullable=False),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_project_automation_tokens_project_id", "project_automation_tokens", ["project_id"])
    op.create_index("ix_project_automation_tokens_active", "project_automation_tokens", ["project_id", "revoked_at", "deleted_at"])
    op.add_column("asset_versions", sa.Column("automation_token_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.create_foreign_key(
        "fk_asset_versions_automation_token_id",
        "asset_versions",
        "project_automation_tokens",
        ["automation_token_id"],
        ["id"],
    )
    op.create_index("ix_asset_versions_automation_token_id", "asset_versions", ["automation_token_id"])
    op.add_column("asset_versions", sa.Column("client_request_id", sa.String(length=64), nullable=True))
    op.add_column("asset_versions", sa.Column("automation_request_fingerprint", sa.String(length=64), nullable=True))
    op.create_unique_constraint(
        "uq_asset_versions_automation_request",
        "asset_versions",
        ["automation_token_id", "client_request_id"],
    )
    op.execute("ALTER TYPE processingstatus ADD VALUE IF NOT EXISTS 'queued'")
    op.create_table(
        "processing_outbox",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("version_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("asset_versions.id", ondelete="CASCADE"), nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("dispatched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_processing_outbox_version_id", "processing_outbox", ["version_id"])
    # Workers already processing during rollout were created before the outbox
    # existed. Seed them so a crash can be recovered by the dispatcher. Marking
    # them dispatched gives an in-flight pre-deploy worker the stale-window grace
    # period before a new worker is published.
    op.execute("""
        INSERT INTO processing_outbox (id, version_id, created_at, dispatched_at, lease_expires_at)
        SELECT (md5(random()::text || clock_timestamp()::text || id::text))::uuid, id, now(), now(), now() + interval '15 minutes'
        FROM asset_versions
        WHERE processing_status = 'processing'
        ON CONFLICT (version_id) DO NOTHING
    """)


def downgrade() -> None:
    # Operators must stop upload producers and drain workers before downgrade;
    # old workers cannot consume the new one-argument task messages.
    op.execute("LOCK TABLE processing_outbox IN ACCESS EXCLUSIVE MODE")
    op.execute("""
        UPDATE processing_outbox AS outbox
        SET completed_at = now()
        FROM asset_versions AS version
        WHERE outbox.version_id = version.id
          AND outbox.completed_at IS NULL
          AND version.processing_status IN ('ready', 'failed')
    """)
    op.execute("""
        DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM processing_outbox WHERE completed_at IS NULL) THEN
                RAISE EXCEPTION 'cannot downgrade while processing work remains; drain workers first';
            END IF;
        END $$;
    """)
    op.drop_index("ix_processing_outbox_version_id", table_name="processing_outbox")
    op.drop_table("processing_outbox")
    # PostgreSQL cannot remove a single enum value. Convert queued work back to
    # processing, then recreate the original enum before dropping the feature.
    op.execute("UPDATE asset_versions SET processing_status = 'processing' WHERE processing_status = 'queued'")
    op.execute("ALTER TYPE processingstatus RENAME TO processingstatus_old")
    op.execute("CREATE TYPE processingstatus AS ENUM ('uploading', 'processing', 'ready', 'failed')")
    op.execute("""
        ALTER TABLE asset_versions
        ALTER COLUMN processing_status TYPE processingstatus
        USING processing_status::text::processingstatus
    """)
    op.execute("DROP TYPE processingstatus_old")
    op.drop_constraint("uq_asset_versions_automation_request", "asset_versions", type_="unique")
    op.drop_column("asset_versions", "client_request_id")
    op.drop_column("asset_versions", "automation_request_fingerprint")
    op.drop_index("ix_asset_versions_automation_token_id", table_name="asset_versions")
    op.drop_constraint("fk_asset_versions_automation_token_id", "asset_versions", type_="foreignkey")
    op.drop_column("asset_versions", "automation_token_id")
    op.drop_index("ix_project_automation_tokens_active", table_name="project_automation_tokens")
    op.drop_index("ix_project_automation_tokens_project_id", table_name="project_automation_tokens")
    op.drop_table("project_automation_tokens")
