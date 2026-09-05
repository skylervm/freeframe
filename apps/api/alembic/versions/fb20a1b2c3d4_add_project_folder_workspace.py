"""add project folder workspace

Revision ID: fb20a1b2c3d4
Revises: fa10b2c3d4e5
"""
from alembic import op
import sqlalchemy as sa
import uuid
from sqlalchemy.dialects import postgresql

revision = "fb20a1b2c3d4"
down_revision = "fa10b2c3d4e5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    workspace_role = postgresql.ENUM("owner", "member", name="workspacerole", create_type=False)
    folder_scope = postgresql.ENUM("personal", "shared", "workspace", name="projectfolderscope", create_type=False)
    project_role = postgresql.ENUM("owner", "editor", "reviewer", "viewer", name="projectrole", create_type=False)
    workspace_role.create(op.get_bind(), checkfirst=True)
    folder_scope.create(op.get_bind(), checkfirst=True)

    op.create_table("workspaces",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
    )
    op.create_table("workspace_members",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("workspaces.id"), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("role", workspace_role, nullable=False, server_default="member"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_workspace_members_workspace_id", "workspace_members", ["workspace_id"])
    op.create_index("ix_workspace_members_user_id", "workspace_members", ["user_id"])
    op.create_index("uq_workspace_member_active", "workspace_members", ["workspace_id", "user_id"], unique=True, postgresql_where=sa.text("deleted_at IS NULL"))
    op.create_table("project_folders",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("workspaces.id"), nullable=False),
        sa.Column("parent_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("project_folders.id")),
        sa.Column("owner_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("scope", folder_scope, nullable=False),
        sa.Column("is_private", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_project_folders_workspace_id", "project_folders", ["workspace_id"])
    op.create_index("ix_project_folders_parent_id", "project_folders", ["parent_id"])
    op.create_index("ix_project_folders_owner_id", "project_folders", ["owner_id"])
    op.create_index("ix_project_folders_workspace_parent", "project_folders", ["workspace_id", "parent_id", "deleted_at"])
    op.create_index("uq_project_folder_name_per_parent", "project_folders", ["workspace_id", "parent_id", "owner_id", "name"], unique=True, postgresql_where=sa.text("deleted_at IS NULL"))
    op.create_table("project_folder_shares",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("folder_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("project_folders.id"), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("role", project_role, nullable=False, server_default="viewer"),
        sa.Column("shared_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
    )
    op.create_index("uq_project_folder_share_active", "project_folder_shares", ["folder_id", "user_id"], unique=True, postgresql_where=sa.text("deleted_at IS NULL"))
    op.create_index("ix_project_folder_shares_folder_id", "project_folder_shares", ["folder_id"])
    op.create_index("ix_project_folder_shares_user_id", "project_folder_shares", ["user_id"])
    op.create_table("personal_project_placements",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("folder_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("project_folders.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
    )
    op.create_index("uq_personal_project_placement_active", "personal_project_placements", ["user_id", "project_id"], unique=True, postgresql_where=sa.text("deleted_at IS NULL"))
    op.create_index("ix_personal_project_placements_user_id", "personal_project_placements", ["user_id"])
    op.create_index("ix_personal_project_placements_project_id", "personal_project_placements", ["project_id"])
    op.create_index("ix_personal_project_placements_folder_id", "personal_project_placements", ["folder_id"])
    op.add_column("projects", sa.Column("project_folder_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("project_folders.id")))
    op.create_index("ix_projects_project_folder_id", "projects", ["project_folder_id"])

    bind = op.get_bind()
    workspace_id = uuid.uuid4()
    bind.execute(sa.text("INSERT INTO workspaces (id, name) VALUES (:id, :name)"), {"id": workspace_id, "name": "FreeFrame"})
    owner_ids = bind.execute(sa.text("SELECT id FROM users WHERE is_superadmin = true AND deleted_at IS NULL")).scalars().all()
    for owner_id in owner_ids:
        bind.execute(sa.text("INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES (:id, :workspace_id, :user_id, 'owner')"), {"id": uuid.uuid4(), "workspace_id": workspace_id, "user_id": owner_id})


def downgrade() -> None:
    op.drop_index("ix_projects_project_folder_id", table_name="projects")
    op.drop_column("projects", "project_folder_id")
    op.drop_table("personal_project_placements")
    op.drop_table("project_folder_shares")
    op.drop_table("project_folders")
    op.drop_table("workspace_members")
    op.drop_table("workspaces")
    sa.Enum(name="projectfolderscope").drop(op.get_bind(), checkfirst=True)
    sa.Enum(name="workspacerole").drop(op.get_bind(), checkfirst=True)
