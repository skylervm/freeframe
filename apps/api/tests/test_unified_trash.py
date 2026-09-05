"""Real-Postgres regression tests for operation-scoped Trash recovery."""
import uuid

from apps.api.models.asset import Asset, AssetType
from apps.api.models.folder import Folder
from apps.api.models.project import Project, ProjectMember, ProjectRole, ProjectType
from apps.api.models.project_folder import ProjectFolder, ProjectFolderScope, ProjectFolderShare
from apps.api.models.trash import TrashEntityType, TrashOperation
from apps.api.models.user import User
from apps.api.models.workspace import Workspace
from apps.api.routers.folders import delete_folder, restore_asset
from apps.api.routers.project_folders import (
    delete_project_folder,
    list_unified_trash,
    restore_unified_trash_item,
)


def _user(db) -> User:
    user = User(email=f"trash-{uuid.uuid4()}@test.local", name="trash test")
    db.add(user)
    db.flush()
    return user


def _project(db, owner: User) -> Project:
    project = Project(name=str(uuid.uuid4()), project_type=ProjectType.personal, created_by=owner.id)
    db.add(project)
    db.flush()
    db.add(ProjectMember(project_id=project.id, user_id=owner.id, role=ProjectRole.owner, invited_by=owner.id))
    db.flush()
    return project


def test_folder_restore_only_revives_its_own_deletion_operation(real_db):
    owner = _user(real_db)
    project = _project(real_db, owner)
    root = Folder(project_id=project.id, name="root", created_by=owner.id)
    real_db.add(root)
    real_db.flush()
    child = Folder(project_id=project.id, parent_id=root.id, name="child", created_by=owner.id)
    real_db.add(child)
    real_db.flush()
    independently_deleted = Asset(project_id=project.id, folder_id=child.id, name="old", asset_type=AssetType.video, created_by=owner.id)
    active_asset = Asset(project_id=project.id, folder_id=child.id, name="live", asset_type=AssetType.video, created_by=owner.id)
    real_db.add_all([independently_deleted, active_asset])
    real_db.flush()
    prior_operation = TrashOperation(entity_type=TrashEntityType.asset, entity_id=independently_deleted.id, deleted_by_id=owner.id, project_id=project.id)
    real_db.add(prior_operation)
    real_db.flush()
    independently_deleted.deleted_at = prior_operation.deleted_at
    independently_deleted.trash_operation_id = prior_operation.id
    real_db.flush()

    delete_folder(root.id, db=real_db, current_user=owner)
    operation = real_db.query(TrashOperation).filter(TrashOperation.entity_id == root.id).one()
    assert active_asset.trash_operation_id == operation.id
    assert independently_deleted.trash_operation_id == prior_operation.id

    restore_asset(active_asset.id, db=real_db, current_user=owner)
    real_db.refresh(active_asset)
    real_db.refresh(independently_deleted)
    real_db.refresh(root)
    real_db.refresh(operation)
    assert active_asset.deleted_at is None
    assert independently_deleted.deleted_at is not None
    assert independently_deleted.trash_operation_id == prior_operation.id
    assert root.deleted_at is not None
    assert operation.restored_at is None


def test_project_folder_restore_preserves_project_placement_and_share(real_db):
    owner = _user(real_db)
    viewer = _user(real_db)
    workspace = Workspace(name=f"trash-{uuid.uuid4()}")
    real_db.add(workspace)
    real_db.flush()
    folder = ProjectFolder(
        workspace_id=workspace.id,
        owner_id=owner.id,
        created_by=owner.id,
        name="shared",
        scope=ProjectFolderScope.shared,
    )
    real_db.add(folder)
    real_db.flush()
    project = _project(real_db, owner)
    project.project_folder_id = folder.id
    share = ProjectFolderShare(folder_id=folder.id, user_id=viewer.id, role=ProjectRole.viewer, shared_by=owner.id)
    real_db.add(share)
    real_db.flush()

    delete_project_folder(folder.id, db=real_db, current_user=owner)
    operation = real_db.query(TrashOperation).filter(TrashOperation.entity_id == folder.id).one()
    assert project.project_folder_id == folder.id
    assert share.deleted_at is not None

    restore_unified_trash_item(operation.id, db=real_db, current_user=owner)
    real_db.refresh(folder)
    real_db.refresh(share)
    assert folder.deleted_at is None
    assert share.deleted_at is None
    assert project.project_folder_id == folder.id


def test_trash_listing_paginates_only_operations_owned_by_current_user(real_db):
    owner = _user(real_db)
    other_owner = _user(real_db)
    owner_project = _project(real_db, owner)
    other_project = _project(real_db, other_owner)

    owner_assets = [
        Asset(project_id=owner_project.id, name=f"owner-{index}", asset_type=AssetType.video, created_by=owner.id)
        for index in range(2)
    ]
    other_assets = [
        Asset(project_id=other_project.id, name=f"other-{index}", asset_type=AssetType.video, created_by=other_owner.id)
        for index in range(3)
    ]
    real_db.add_all(owner_assets + other_assets)
    real_db.flush()
    operations = [
        TrashOperation(
            entity_type=TrashEntityType.asset,
            entity_id=asset.id,
            deleted_by_id=asset.created_by,
            project_id=asset.project_id,
        )
        for asset in owner_assets + other_assets
    ]
    real_db.add_all(operations)
    real_db.flush()
    for asset, operation in zip(owner_assets + other_assets, operations):
        asset.deleted_at = operation.deleted_at
        asset.trash_operation_id = operation.id
    real_db.flush()

    first_page = list_unified_trash(skip=0, limit=1, db=real_db, current_user=owner)
    second_page = list_unified_trash(skip=1, limit=1, db=real_db, current_user=owner)
    third_page = list_unified_trash(skip=2, limit=1, db=real_db, current_user=owner)

    assert {item["name"] for item in first_page["items"] + second_page["items"]} == {"owner-0", "owner-1"}
    assert third_page["items"] == []
