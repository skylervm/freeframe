"""add trash operations

Revision ID: c1d2e3f4a5b6
Revises: fb20a1b2c3d4
"""
from alembic import op
import sqlalchemy as sa
import uuid
from sqlalchemy.dialects import postgresql


revision = "c1d2e3f4a5b6"
down_revision = "fb20a1b2c3d4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "trash_operations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("entity_type", sa.String(32), nullable=False),
        sa.Column("entity_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("deleted_by_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id", ondelete="SET NULL")),
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("workspaces.id")),
        sa.Column("deleted_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("restored_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_trash_operations_deleted_by_deleted", "trash_operations", ["deleted_by_id", "deleted_at"])
    op.create_index("ix_trash_operations_entity", "trash_operations", ["entity_type", "entity_id"])
    op.create_table(
        "trash_storage_deletions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("s3_key", sa.String(1024), nullable=False),
        sa.Column("is_prefix", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_trash_storage_deletions_pending", "trash_storage_deletions", ["completed_at", "next_attempt_at"])
    for table in ("assets", "folders", "projects", "project_folders", "project_folder_shares", "personal_project_placements"):
        op.add_column(table, sa.Column("trash_operation_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("trash_operations.id"), nullable=True))
        op.create_index(f"ix_{table}_trash_operation_id", table, ["trash_operation_id"])
    op.add_column("personal_project_placements", sa.Column("restore_eligible", sa.Boolean(), server_default=sa.true(), nullable=False))

    bind = op.get_bind()
    # Existing tombstones predate provenance. Give each deleted root its own
    # operation instead of guessing a historical cascade; that permits safe,
    # item-by-item recovery after upgrade.
    legacy_sources = (
        ("projects", "project", "created_by", "id", "NULL"),
        ("project_folders", "project_folder", "owner_id", "NULL", "workspace_id"),
        ("folders", "folder", "created_by", "project_id", "NULL"),
        ("assets", "asset", "created_by", "project_id", "NULL"),
    )
    for table, entity_type, deleted_by_column, project_column, workspace_column in legacy_sources:
        rows = bind.execute(sa.text(
            f"SELECT id, {deleted_by_column} AS deleted_by_id, {project_column} AS project_id, "
            f"{workspace_column} AS workspace_id, deleted_at FROM {table} WHERE deleted_at IS NOT NULL"
        )).mappings().all()
        for row in rows:
            operation_id = uuid.uuid4()
            bind.execute(sa.text(
                "INSERT INTO trash_operations (id, entity_type, entity_id, deleted_by_id, project_id, workspace_id, deleted_at) "
                "VALUES (:id, :entity_type, :entity_id, :deleted_by_id, :project_id, :workspace_id, :deleted_at)"
            ), {
                "id": operation_id,
                "entity_type": entity_type,
                "entity_id": row["id"],
                "deleted_by_id": row["deleted_by_id"],
                "project_id": row["project_id"],
                "workspace_id": row["workspace_id"],
                "deleted_at": row["deleted_at"],
            })
            bind.execute(sa.text(f"UPDATE {table} SET trash_operation_id = :operation_id WHERE id = :id"), {
                "operation_id": operation_id,
                "id": row["id"],
            })


def downgrade() -> None:
    for table in ("personal_project_placements", "project_folder_shares", "project_folders", "projects", "folders", "assets"):
        op.drop_index(f"ix_{table}_trash_operation_id", table_name=table)
        op.drop_column(table, "trash_operation_id")
    op.drop_column("personal_project_placements", "restore_eligible")
    op.drop_index("ix_trash_operations_entity", table_name="trash_operations")
    op.drop_index("ix_trash_operations_deleted_by_deleted", table_name="trash_operations")
    op.drop_index("ix_trash_storage_deletions_pending", table_name="trash_storage_deletions")
    op.drop_table("trash_storage_deletions")
    op.drop_table("trash_operations")
