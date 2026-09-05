"""Real-Postgres regression tests for project-folder access boundaries."""
import uuid
from datetime import datetime, timezone

import pytest  # noqa: F401  (real_db fixture lives in conftest.py)
from fastapi import HTTPException

from apps.api.models.project import Project, ProjectMember, ProjectRole, ProjectType
from apps.api.models.project_folder import ProjectFolder, ProjectFolderScope, ProjectFolderShare
from apps.api.models.asset import Asset, AssetType
from apps.api.models.share import AssetShare, SharePermission
from apps.api.models.user import User
from apps.api.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from apps.api.routers.share import _may_view_share_secret
from apps.api.services.permissions import (
    can_access_asset,
    get_accessible_project_roles,
    get_effective_project_role,
    require_workspace_owner_retained,
)


def _user(db) -> User:
    user = User(email=f"folder-{uuid.uuid4()}@test.local", name="folder test")
    db.add(user)
    db.flush()
    return user


def _folder(db, workspace: Workspace, owner: User, *, parent_id=None, is_private=False) -> ProjectFolder:
    folder = ProjectFolder(
        workspace_id=workspace.id,
        parent_id=parent_id,
        owner_id=owner.id,
        created_by=owner.id,
        name=str(uuid.uuid4()),
        scope=ProjectFolderScope.shared,
        is_private=is_private,
    )
    db.add(folder)
    db.flush()
    return folder


def test_private_folder_blocks_parent_share_but_keeps_direct_project_exception(real_db):
    owner = _user(real_db)
    parent_viewer = _user(real_db)
    direct_viewer = _user(real_db)
    workspace = Workspace(name=f"folder-test-{uuid.uuid4()}")
    real_db.add(workspace)
    real_db.flush()

    parent = _folder(real_db, workspace, owner)
    private_child = _folder(real_db, workspace, owner, parent_id=parent.id, is_private=True)
    project = Project(
        name="private child project",
        project_type=ProjectType.personal,
        created_by=owner.id,
        project_folder_id=private_child.id,
    )
    real_db.add(project)
    real_db.flush()
    real_db.add(ProjectFolderShare(
        folder_id=parent.id,
        user_id=parent_viewer.id,
        role=ProjectRole.viewer,
        shared_by=owner.id,
    ))
    real_db.add(ProjectMember(
        project_id=project.id,
        user_id=direct_viewer.id,
        role=ProjectRole.viewer,
        invited_by=owner.id,
    ))
    real_db.flush()

    assert get_effective_project_role(real_db, project.id, parent_viewer) is None
    assert get_effective_project_role(real_db, project.id, direct_viewer) == ProjectRole.viewer


def test_revoking_private_folder_share_removes_effective_access(real_db):
    owner = _user(real_db)
    viewer = _user(real_db)
    workspace = Workspace(name=f"folder-test-{uuid.uuid4()}")
    real_db.add(workspace)
    real_db.flush()

    private_folder = _folder(real_db, workspace, owner, is_private=True)
    project = Project(
        name="private project",
        project_type=ProjectType.personal,
        created_by=owner.id,
        project_folder_id=private_folder.id,
    )
    share = ProjectFolderShare(
        folder_id=private_folder.id,
        user_id=viewer.id,
        role=ProjectRole.viewer,
        shared_by=owner.id,
    )
    real_db.add_all([project, share])
    real_db.flush()

    assert get_effective_project_role(real_db, project.id, viewer) == ProjectRole.viewer
    share.deleted_at = datetime.now(timezone.utc)
    real_db.flush()
    assert get_effective_project_role(real_db, project.id, viewer) is None


def test_bulk_roles_exclude_deleted_project_membership(real_db):
    owner = _user(real_db)
    viewer = _user(real_db)
    project = Project(
        name="deleted project",
        project_type=ProjectType.personal,
        created_by=owner.id,
        deleted_at=datetime.now(timezone.utc),
    )
    real_db.add(project)
    real_db.flush()
    real_db.add(ProjectMember(
        project_id=project.id,
        user_id=viewer.id,
        role=ProjectRole.viewer,
        invited_by=owner.id,
    ))
    real_db.flush()

    assert get_effective_project_role(real_db, project.id, viewer) is None
    assert project.id not in get_accessible_project_roles(real_db, viewer)


def test_direct_asset_share_does_not_survive_project_deletion(real_db):
    owner = _user(real_db)
    viewer = _user(real_db)
    project = Project(
        name="deleted project",
        project_type=ProjectType.personal,
        created_by=owner.id,
        deleted_at=datetime.now(timezone.utc),
    )
    real_db.add(project)
    real_db.flush()
    asset = Asset(
        project_id=project.id,
        name="deleted asset",
        asset_type=AssetType.video,
        created_by=owner.id,
    )
    real_db.add(asset)
    real_db.flush()
    real_db.add(AssetShare(
        asset_id=asset.id,
        shared_with_user_id=viewer.id,
        permission=SharePermission.view,
        shared_by=owner.id,
    ))
    real_db.flush()

    assert not can_access_asset(real_db, asset, viewer)


def test_workspace_access_stops_at_private_child_until_explicitly_shared(real_db):
    owner = _user(real_db)
    workspace_member = _user(real_db)
    workspace = Workspace(name=f"folder-test-{uuid.uuid4()}")
    real_db.add(workspace)
    real_db.flush()
    real_db.add(WorkspaceMember(
        workspace_id=workspace.id,
        user_id=workspace_member.id,
        role=WorkspaceRole.member,
    ))
    workspace_root = _folder(real_db, workspace, owner)
    workspace_root.scope = ProjectFolderScope.workspace
    private_child = _folder(real_db, workspace, owner, parent_id=workspace_root.id, is_private=True)
    private_child.scope = ProjectFolderScope.workspace
    grandchild = _folder(real_db, workspace, owner, parent_id=private_child.id)
    grandchild.scope = ProjectFolderScope.workspace
    project = Project(
        name="private workspace project",
        project_type=ProjectType.personal,
        created_by=owner.id,
        project_folder_id=grandchild.id,
    )
    real_db.add(project)
    real_db.flush()

    assert get_effective_project_role(real_db, project.id, workspace_member) is None
    real_db.add(ProjectFolderShare(
        folder_id=private_child.id,
        user_id=workspace_member.id,
        role=ProjectRole.viewer,
        shared_by=owner.id,
    ))
    real_db.flush()
    assert get_effective_project_role(real_db, project.id, workspace_member) == ProjectRole.viewer


def test_last_active_workspace_owner_cannot_be_removed(real_db):
    owner = _user(real_db)
    workspace = Workspace(name=f"folder-test-{uuid.uuid4()}")
    real_db.add(workspace)
    real_db.flush()
    real_db.add(WorkspaceMember(
        workspace_id=workspace.id,
        user_id=owner.id,
        role=WorkspaceRole.owner,
    ))
    real_db.flush()

    with pytest.raises(HTTPException, match="retain an active owner"):
        require_workspace_owner_retained(real_db, owner.id)


def test_only_direct_project_editor_can_view_share_credentials(real_db):
    owner = _user(real_db)
    folder_viewer = _user(real_db)
    direct_editor = _user(real_db)
    workspace = Workspace(name=f"folder-test-{uuid.uuid4()}")
    real_db.add(workspace)
    real_db.flush()
    folder = _folder(real_db, workspace, owner)
    project = Project(
        name="credential project",
        project_type=ProjectType.personal,
        created_by=owner.id,
        project_folder_id=folder.id,
    )
    real_db.add(project)
    real_db.flush()
    real_db.add_all([
        ProjectFolderShare(
            folder_id=folder.id,
            user_id=folder_viewer.id,
            role=ProjectRole.editor,
            shared_by=owner.id,
        ),
        ProjectMember(
            project_id=project.id,
            user_id=direct_editor.id,
            role=ProjectRole.editor,
            invited_by=owner.id,
        ),
    ])
    real_db.flush()

    assert not _may_view_share_secret(real_db, project.id, folder_viewer)
    assert _may_view_share_secret(real_db, project.id, direct_editor)
