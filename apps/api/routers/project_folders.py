import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import and_, exists, or_, text
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.project import Project, ProjectMember, ProjectRole
from ..models.asset import Asset
from ..models.folder import Folder
from ..models.project_folder import (
    PersonalProjectPlacement,
    ProjectFolder,
    ProjectFolderScope,
    ProjectFolderShare,
)
from ..models.user import User
from ..models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from ..models.trash import TrashEntityType, TrashOperation
from ..config import settings
from ..schemas.project_folder import (
    PersonalProjectPlacementRequest,
    PersonalProjectPlacementResponse,
    ProjectFolderCreate,
    ProjectFolderProjectMove,
    ProjectFolderResponse,
    ProjectFolderShareRequest,
    ProjectFolderShareResponse,
    ProjectFolderUpdate,
    WorkspaceMemberRequest,
    WorkspaceMemberResponse,
    WorkspaceMemberUpdate,
    WorkspaceResponse,
)
from ..services.permissions import ROLE_RANK, get_effective_project_role, require_workspace_owner_retained


router = APIRouter(tags=["project-folders"])
MAX_PROJECT_FOLDER_DEPTH = 10


def _active_workspace(db: Session) -> Workspace:
    workspace = db.query(Workspace).filter(Workspace.deleted_at.is_(None)).order_by(Workspace.created_at).first()
    if not workspace:
        raise HTTPException(status_code=503, detail="Workspace is not initialized")
    return workspace


def _lock_workspace(db: Session) -> Workspace:
    """Serialize mutations to the workspace tree and member roster."""
    workspace = db.query(Workspace).filter(Workspace.deleted_at.is_(None)).order_by(Workspace.created_at).with_for_update().first()
    if not workspace:
        raise HTTPException(status_code=503, detail="Workspace is not initialized")
    return workspace


def _workspace_member(db: Session, workspace_id: uuid.UUID, user_id: uuid.UUID) -> WorkspaceMember | None:
    return db.query(WorkspaceMember).filter(
        WorkspaceMember.workspace_id == workspace_id,
        WorkspaceMember.user_id == user_id,
        WorkspaceMember.deleted_at.is_(None),
    ).first()


def _require_workspace_owner(db: Session, workspace_id: uuid.UUID, user: User) -> WorkspaceMember:
    member = _workspace_member(db, workspace_id, user.id)
    if not member or member.role != WorkspaceRole.owner:
        raise HTTPException(status_code=403, detail="Workspace owner access required")
    return member


def _get_folder(db: Session, folder_id: uuid.UUID) -> ProjectFolder:
    folder = db.query(ProjectFolder).filter(ProjectFolder.id == folder_id, ProjectFolder.deleted_at.is_(None)).first()
    if not folder:
        raise HTTPException(status_code=404, detail="Project folder not found")
    return folder


def _folder_role(db: Session, folder: ProjectFolder, user: User) -> ProjectRole | None:
    """Resolve inherited folder access; a private folder is an inheritance boundary."""
    chain: list[ProjectFolder] = []
    current: ProjectFolder | None = folder
    visited: set[uuid.UUID] = set()
    while current and current.id not in visited:
        visited.add(current.id)
        chain.append(current)
        current = _get_folder_or_none(db, current.parent_id)
    best: ProjectRole | None = None
    blocked = False
    for current in reversed(chain):
        if current.is_private:
            best = None
            blocked = True
        role: ProjectRole | None = None
        if current.owner_id == user.id:
            role = ProjectRole.editor
        else:
            share = db.query(ProjectFolderShare).filter(
                ProjectFolderShare.folder_id == current.id,
                ProjectFolderShare.user_id == user.id,
                ProjectFolderShare.deleted_at.is_(None),
            ).first()
            if share:
                role = share.role
        if role is None and not blocked and current.scope == ProjectFolderScope.workspace and _workspace_member(db, current.workspace_id, user.id):
            role = ProjectRole.viewer
        if role and (best is None or ROLE_RANK[role] > ROLE_RANK[best]):
            best = role
    return best


def _get_folder_or_none(db: Session, folder_id: uuid.UUID | None) -> ProjectFolder | None:
    if not folder_id:
        return None
    return db.query(ProjectFolder).filter(ProjectFolder.id == folder_id, ProjectFolder.deleted_at.is_(None)).first()


def _require_folder_editor(db: Session, folder: ProjectFolder, user: User) -> ProjectRole:
    role = _folder_role(db, folder, user)
    if not role or ROLE_RANK[role] < ROLE_RANK[ProjectRole.editor]:
        raise HTTPException(status_code=403, detail="Folder editor access required")
    return role


def _folder_depth(db: Session, parent_id: uuid.UUID | None) -> int:
    depth = 0
    current = _get_folder_or_none(db, parent_id)
    visited: set[uuid.UUID] = set()
    while current and current.id not in visited:
        visited.add(current.id)
        depth += 1
        current = _get_folder_or_none(db, current.parent_id)
    return depth


def _is_descendant(db: Session, folder_id: uuid.UUID, possible_ancestor_id: uuid.UUID) -> bool:
    current = _get_folder_or_none(db, folder_id)
    visited: set[uuid.UUID] = set()
    while current and current.id not in visited:
        if current.id == possible_ancestor_id:
            return True
        visited.add(current.id)
        current = _get_folder_or_none(db, current.parent_id)
    return False


def _subtree_height(db: Session, folder_id: uuid.UUID) -> int:
    height = 0
    queue: list[tuple[uuid.UUID, int]] = [(folder_id, 0)]
    while queue:
        current_id, depth = queue.pop(0)
        height = max(height, depth)
        children = db.query(ProjectFolder.id).filter(ProjectFolder.parent_id == current_id, ProjectFolder.deleted_at.is_(None)).all()
        queue.extend((child_id, depth + 1) for (child_id,) in children)
    return height


def _descendant_ids(db: Session, folder_id: uuid.UUID) -> list[uuid.UUID]:
    descendants: list[uuid.UUID] = []
    queue = [folder_id]
    while queue:
        current_id = queue.pop(0)
        descendants.append(current_id)
        queue.extend(child_id for (child_id,) in db.query(ProjectFolder.id).filter(ProjectFolder.parent_id == current_id, ProjectFolder.deleted_at.is_(None)).all())
    return descendants


def _require_project_owner(db: Session, project_id: uuid.UUID, user: User) -> None:
    owner = db.query(ProjectMember).filter(
        ProjectMember.project_id == project_id,
        ProjectMember.user_id == user.id,
        ProjectMember.role == ProjectRole.owner,
        ProjectMember.deleted_at.is_(None),
    ).first()
    if not owner:
        raise HTTPException(status_code=403, detail="Project owner access required")


def _operation_type(operation: TrashOperation) -> TrashEntityType:
    return TrashEntityType(operation.entity_type)


def _require_trash_authority(db: Session, operation: TrashOperation, user: User) -> None:
    """Authorize against current ownership, never the user who deleted the item."""
    if operation.project_id:
        _require_project_owner(db, operation.project_id, user)
        return
    if _operation_type(operation) == TrashEntityType.project_folder:
        folder = db.query(ProjectFolder).filter(ProjectFolder.id == operation.entity_id).first()
        if not folder or folder.owner_id != user.id:
            raise HTTPException(status_code=403, detail="Project folder owner access required")
        return
    raise HTTPException(status_code=404, detail="Deleted item not found")


def _trash_operation(db: Session, operation_id: uuid.UUID, user: User) -> TrashOperation:
    operation = db.query(TrashOperation).filter(
        TrashOperation.id == operation_id,
        TrashOperation.restored_at.is_(None),
    ).with_for_update().first()
    if not operation:
        raise HTTPException(status_code=404, detail="Deleted item not found")
    _require_trash_authority(db, operation, user)
    return operation


def _trash_item_name(db: Session, operation: TrashOperation) -> str | None:
    model = {
        TrashEntityType.asset: Asset,
        TrashEntityType.folder: Folder,
        TrashEntityType.project: Project,
        TrashEntityType.project_folder: ProjectFolder,
    }[_operation_type(operation)]
    item = db.query(model).filter(model.id == operation.entity_id).first()
    return item.name if item else None


def _restore_project_folder_operation(db: Session, operation: TrashOperation) -> None:
    root = db.query(ProjectFolder).filter(
        ProjectFolder.id == operation.entity_id,
        ProjectFolder.trash_operation_id == operation.id,
        ProjectFolder.deleted_at.isnot(None),
    ).with_for_update().first()
    if not root:
        raise HTTPException(status_code=409, detail="Deleted project folder is no longer recoverable")

    active_parent = _get_folder_or_none(db, root.parent_id)
    if root.parent_id and not active_parent:
        root.parent_id = None
        # A workspace folder leaving a private ancestor must not become visible to
        # every workspace member merely because its former parent was purged.
        root.is_private = True
    conflict = db.query(ProjectFolder.id).filter(
        ProjectFolder.workspace_id == root.workspace_id,
        ProjectFolder.parent_id == root.parent_id,
        ProjectFolder.owner_id == root.owner_id,
        ProjectFolder.name == root.name,
        ProjectFolder.id != root.id,
        ProjectFolder.deleted_at.is_(None),
    ).first()
    if conflict:
        raise HTTPException(status_code=409, detail="Cannot restore: a folder with this name already exists at the destination")

    db.query(ProjectFolder).filter(
        ProjectFolder.trash_operation_id == operation.id,
        ProjectFolder.deleted_at.isnot(None),
    ).update({ProjectFolder.deleted_at: None, ProjectFolder.trash_operation_id: None}, synchronize_session=False)

    placements = db.query(PersonalProjectPlacement).filter(
        PersonalProjectPlacement.trash_operation_id == operation.id,
        PersonalProjectPlacement.deleted_at.isnot(None),
    ).all()
    for placement in placements:
        replacement = db.query(PersonalProjectPlacement.id).filter(
            PersonalProjectPlacement.user_id == placement.user_id,
            PersonalProjectPlacement.project_id == placement.project_id,
            PersonalProjectPlacement.deleted_at.is_(None),
        ).first()
        if placement.restore_eligible and not replacement:
            placement.deleted_at = None
            placement.trash_operation_id = None

    shares = db.query(ProjectFolderShare).filter(
        ProjectFolderShare.trash_operation_id == operation.id,
        ProjectFolderShare.deleted_at.isnot(None),
    ).all()
    for share in shares:
        replacement = db.query(ProjectFolderShare.id).filter(
            ProjectFolderShare.folder_id == share.folder_id,
            ProjectFolderShare.user_id == share.user_id,
            ProjectFolderShare.deleted_at.is_(None),
        ).first()
        if not replacement:
            share.deleted_at = None
            share.trash_operation_id = None


def _restore_media_folder_operation(db: Session, operation: TrashOperation) -> None:
    project = db.query(Project).filter(
        Project.id == operation.project_id,
        Project.deleted_at.is_(None),
    ).with_for_update().first()
    if not project:
        raise HTTPException(status_code=409, detail="Cannot restore: the project is still deleted")
    root = db.query(Folder).filter(
        Folder.id == operation.entity_id,
        Folder.trash_operation_id == operation.id,
        Folder.deleted_at.isnot(None),
    ).with_for_update().first()
    if not root:
        raise HTTPException(status_code=409, detail="Deleted folder is no longer recoverable")
    parent = db.query(Folder).filter(Folder.id == root.parent_id, Folder.deleted_at.is_(None)).first() if root.parent_id else None
    if root.parent_id and not parent:
        root.parent_id = None
    conflict = db.query(Folder.id).filter(
        Folder.project_id == root.project_id,
        Folder.parent_id == root.parent_id,
        Folder.name == root.name,
        Folder.id != root.id,
        Folder.deleted_at.is_(None),
    ).first()
    if conflict:
        raise HTTPException(status_code=409, detail="Cannot restore: a folder with this name already exists at the destination")
    db.query(Folder).filter(Folder.trash_operation_id == operation.id, Folder.deleted_at.isnot(None)).update(
        {Folder.deleted_at: None, Folder.trash_operation_id: None}, synchronize_session=False
    )
    db.query(Asset).filter(Asset.trash_operation_id == operation.id, Asset.deleted_at.isnot(None)).update(
        {Asset.deleted_at: None, Asset.trash_operation_id: None}, synchronize_session=False
    )


@router.get("/trash", response_model=dict)
def list_unified_trash(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    project_owner = exists().where(
        ProjectMember.project_id == TrashOperation.project_id,
        ProjectMember.user_id == current_user.id,
        ProjectMember.role == ProjectRole.owner,
        ProjectMember.deleted_at.is_(None),
    )
    folder_owner = exists().where(
        ProjectFolder.id == TrashOperation.entity_id,
        ProjectFolder.owner_id == current_user.id,
    )
    operations = db.query(TrashOperation).filter(
        TrashOperation.restored_at.is_(None),
        or_(
            and_(TrashOperation.project_id.isnot(None), project_owner),
            and_(
                TrashOperation.project_id.is_(None),
                TrashOperation.entity_type == TrashEntityType.project_folder.value,
                folder_owner,
            ),
        ),
    ).order_by(TrashOperation.deleted_at.desc(), TrashOperation.id.desc()).offset(skip).limit(limit).all()
    retention_days = settings.soft_delete_retention_days
    return {
        "items": [
            {
                "operation_id": str(operation.id),
                "id": str(operation.entity_id),
                "type": _operation_type(operation).value,
                "name": _trash_item_name(db, operation),
                "deleted_at": operation.deleted_at.isoformat(),
                "expires_at": (operation.deleted_at + timedelta(days=retention_days)).isoformat() if retention_days > 0 else None,
            }
            for operation in operations
        ],
        "retention_days": retention_days,
    }


@router.post("/trash/{operation_id}/restore", response_model=dict)
def restore_unified_trash_item(
    operation_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from ..tasks.cleanup_tasks import _PURGE_ADVISORY_LOCK_KEY
    if not db.execute(text("SELECT pg_try_advisory_xact_lock(:k)"), {"k": _PURGE_ADVISORY_LOCK_KEY}).scalar():
        raise HTTPException(status_code=409, detail="Trash cleanup is already running; try again shortly")
    workspace = _lock_workspace(db)
    operation = _trash_operation(db, operation_id, current_user)
    if operation.workspace_id and operation.workspace_id != workspace.id:
        raise HTTPException(status_code=404, detail="Deleted item not found")
    if _operation_type(operation) == TrashEntityType.project_folder:
        _restore_project_folder_operation(db, operation)
    elif _operation_type(operation) == TrashEntityType.folder:
        _restore_media_folder_operation(db, operation)
    elif _operation_type(operation) == TrashEntityType.asset:
        project = db.query(Project).filter(Project.id == operation.project_id, Project.deleted_at.is_(None)).with_for_update().first()
        if not project:
            raise HTTPException(status_code=409, detail="Cannot restore: the project is still deleted")
        asset = db.query(Asset).filter(Asset.id == operation.entity_id, Asset.trash_operation_id == operation.id, Asset.deleted_at.isnot(None)).with_for_update().first()
        if not asset:
            raise HTTPException(status_code=409, detail="Deleted asset is no longer recoverable")
        if asset.folder_id and not db.query(Folder.id).filter(Folder.id == asset.folder_id, Folder.deleted_at.is_(None)).first():
            asset.folder_id = None
        asset.deleted_at = None
        asset.trash_operation_id = None
    elif _operation_type(operation) == TrashEntityType.project:
        project = db.query(Project).filter(Project.id == operation.entity_id, Project.trash_operation_id == operation.id, Project.deleted_at.isnot(None)).with_for_update().first()
        if not project:
            raise HTTPException(status_code=409, detail="Deleted project is no longer recoverable")
        if project.project_folder_id and not _get_folder_or_none(db, project.project_folder_id):
            project.project_folder_id = None
        project.deleted_at = None
        project.trash_operation_id = None
    operation.restored_at = datetime.now(timezone.utc)
    db.commit()
    return {"ok": True}


@router.delete("/trash/{operation_id}", response_model=dict)
def empty_unified_trash_item(
    operation_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Permanently remove one owner-owned Trash root and its operation-scoped descendants."""
    from ..tasks.cleanup_tasks import (
        PurgeCounts,
        _PURGE_ADVISORY_LOCK_KEY,
        _purge_asset,
        _purge_folder,
        _purge_project,
        _purge_project_folder,
        _close_trash_operations,
    )

    got_lock = db.execute(text("SELECT pg_try_advisory_xact_lock(:k)"), {"k": _PURGE_ADVISORY_LOCK_KEY}).scalar()
    if not got_lock:
        raise HTTPException(status_code=409, detail="Trash cleanup is already running; try again shortly")
    operation = _trash_operation(db, operation_id, current_user)
    counts = PurgeCounts()
    root = {
        TrashEntityType.asset: Asset,
        TrashEntityType.folder: Folder,
        TrashEntityType.project: Project,
        TrashEntityType.project_folder: ProjectFolder,
    }[_operation_type(operation)]
    item = db.query(root).filter(
        root.id == operation.entity_id,
        root.trash_operation_id == operation.id,
        root.deleted_at.isnot(None),
    ).with_for_update().first()
    if not item:
        raise HTTPException(status_code=409, detail="Deleted item is no longer recoverable")
    {
        TrashEntityType.asset: _purge_asset,
        TrashEntityType.folder: _purge_folder,
        TrashEntityType.project: _purge_project,
        TrashEntityType.project_folder: _purge_project_folder,
    }[_operation_type(operation)](db, item.id, counts)
    _close_trash_operations(db, _operation_type(operation).value, item.id)
    db.delete(operation)
    db.commit()
    from ..tasks.celery_app import send_task_safe
    from ..tasks.cleanup_tasks import purge_trash_storage
    send_task_safe(purge_trash_storage)
    return {"ok": True}


@router.get("/workspace", response_model=WorkspaceResponse)
def get_workspace(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    workspace = _active_workspace(db)
    member = _workspace_member(db, workspace.id, current_user.id)
    if not member:
        raise HTTPException(status_code=403, detail="Not a workspace member")
    return WorkspaceResponse(id=workspace.id, name=workspace.name, role=member.role)


@router.get("/workspace/members", response_model=list[WorkspaceMemberResponse])
def list_workspace_members(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    workspace = _active_workspace(db)
    _require_workspace_owner(db, workspace.id, current_user)
    return db.query(WorkspaceMember).filter(
        WorkspaceMember.workspace_id == workspace.id,
        WorkspaceMember.deleted_at.is_(None),
    ).order_by(WorkspaceMember.created_at).all()


@router.post("/workspace/members", response_model=WorkspaceMemberResponse, status_code=status.HTTP_201_CREATED)
def add_workspace_member(body: WorkspaceMemberRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    workspace = _lock_workspace(db)
    _require_workspace_owner(db, workspace.id, current_user)
    user = db.query(User).filter(User.id == body.user_id, User.deleted_at.is_(None)).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    existing = _workspace_member(db, workspace.id, body.user_id)
    if existing:
        raise HTTPException(status_code=409, detail="User is already a workspace member")
    member = db.query(WorkspaceMember).filter(WorkspaceMember.workspace_id == workspace.id, WorkspaceMember.user_id == body.user_id).first()
    if member:
        member.deleted_at = None
        member.role = body.role
    else:
        member = WorkspaceMember(workspace_id=workspace.id, user_id=body.user_id, role=body.role)
        db.add(member)
    db.commit()
    db.refresh(member)
    return member


@router.patch("/workspace/members/{member_id}", response_model=WorkspaceMemberResponse)
def update_workspace_member(member_id: uuid.UUID, body: WorkspaceMemberUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    workspace = _lock_workspace(db)
    _require_workspace_owner(db, workspace.id, current_user)
    member = db.query(WorkspaceMember).filter(WorkspaceMember.id == member_id, WorkspaceMember.workspace_id == workspace.id, WorkspaceMember.deleted_at.is_(None)).first()
    if not member:
        raise HTTPException(status_code=404, detail="Workspace member not found")
    if member.role == WorkspaceRole.owner and body.role != WorkspaceRole.owner:
        require_workspace_owner_retained(db, member.user_id)
    member.role = body.role
    db.commit()
    db.refresh(member)
    return member


@router.delete("/workspace/members/{member_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_workspace_member(member_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    workspace = _lock_workspace(db)
    _require_workspace_owner(db, workspace.id, current_user)
    member = db.query(WorkspaceMember).filter(WorkspaceMember.id == member_id, WorkspaceMember.workspace_id == workspace.id, WorkspaceMember.deleted_at.is_(None)).first()
    if not member:
        raise HTTPException(status_code=404, detail="Workspace member not found")
    if member.role == WorkspaceRole.owner:
        require_workspace_owner_retained(db, member.user_id)
    member.deleted_at = datetime.now(timezone.utc)
    db.commit()


@router.get("/project-folders", response_model=list[ProjectFolderResponse])
def list_project_folders(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    workspace = _active_workspace(db)
    folders = db.query(ProjectFolder).filter(ProjectFolder.workspace_id == workspace.id, ProjectFolder.deleted_at.is_(None)).order_by(ProjectFolder.created_at).all()
    accessible_folders = []
    for folder in folders:
        role = _folder_role(db, folder, current_user)
        if role:
            folder.role = role
            accessible_folders.append(folder)
    return accessible_folders


@router.get("/project-folders/{folder_id}/shares", response_model=list[ProjectFolderShareResponse])
def list_project_folder_shares(folder_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    folder = _get_folder(db, folder_id)
    if folder.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the folder owner can view shares")
    return db.query(ProjectFolderShare).filter(ProjectFolderShare.folder_id == folder.id, ProjectFolderShare.deleted_at.is_(None)).order_by(ProjectFolderShare.created_at).all()


@router.get("/personal-project-placements", response_model=list[PersonalProjectPlacementResponse])
def list_personal_project_placements(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    placements = db.query(PersonalProjectPlacement).filter(PersonalProjectPlacement.user_id == current_user.id, PersonalProjectPlacement.deleted_at.is_(None)).all()
    return [placement for placement in placements if get_effective_project_role(db, placement.project_id, current_user)]


@router.post("/project-folders", response_model=ProjectFolderResponse, status_code=status.HTTP_201_CREATED)
def create_project_folder(body: ProjectFolderCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    workspace = _lock_workspace(db)
    parent = _get_folder(db, body.parent_id) if body.parent_id else None
    if parent:
        if parent.workspace_id != workspace.id:
            raise HTTPException(status_code=400, detail="Parent folder is in another workspace")
        _require_folder_editor(db, parent, current_user)
        if _folder_depth(db, parent.id) >= MAX_PROJECT_FOLDER_DEPTH:
            raise HTTPException(status_code=400, detail=f"Maximum folder depth of {MAX_PROJECT_FOLDER_DEPTH} exceeded")
        if body.scope is not None and body.scope != parent.scope:
            raise HTTPException(status_code=400, detail="Nested folders inherit their parent scope")
        if body.is_private and parent.owner_id != current_user.id:
            raise HTTPException(status_code=403, detail="Only the folder owner can create a private boundary")
        folder = ProjectFolder(workspace_id=workspace.id, parent_id=parent.id, owner_id=parent.owner_id, created_by=current_user.id, name=body.name, scope=parent.scope, is_private=body.is_private)
    else:
        scope = body.scope or ProjectFolderScope.personal
        if scope == ProjectFolderScope.workspace and not _workspace_member(db, workspace.id, current_user.id):
            raise HTTPException(status_code=403, detail="Workspace membership required")
        folder = ProjectFolder(workspace_id=workspace.id, owner_id=current_user.id, created_by=current_user.id, name=body.name, scope=scope, is_private=body.is_private)
    duplicate = db.query(ProjectFolder.id).filter(
        ProjectFolder.workspace_id == workspace.id,
        ProjectFolder.parent_id == folder.parent_id,
        ProjectFolder.owner_id == folder.owner_id,
        ProjectFolder.name == folder.name,
        ProjectFolder.deleted_at.is_(None),
    ).first()
    if duplicate:
        raise HTTPException(status_code=409, detail="A folder with this name already exists here")
    db.add(folder)
    db.commit()
    db.refresh(folder)
    return folder


@router.patch("/project-folders/{folder_id}", response_model=ProjectFolderResponse)
def update_project_folder(folder_id: uuid.UUID, body: ProjectFolderUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _lock_workspace(db)
    folder = _get_folder(db, folder_id)
    _require_folder_editor(db, folder, current_user)
    if body.is_private is not None and folder.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the folder owner can change a private boundary")
    if "parent_id" in body.model_fields_set and body.parent_id != folder.parent_id:
        if folder.owner_id != current_user.id:
            raise HTTPException(status_code=403, detail="Only the folder owner can move a folder")
        if body.parent_id is None:
            folder.parent_id = None
        else:
            parent = _get_folder(db, body.parent_id)
            if parent.workspace_id != folder.workspace_id or parent.scope != folder.scope:
                raise HTTPException(status_code=400, detail="Folder must remain within its workspace and scope")
            if parent.owner_id != folder.owner_id:
                raise HTTPException(status_code=403, detail="Folder ownership must remain stable")
            _require_folder_editor(db, parent, current_user)
            if parent.id == folder.id or _is_descendant(db, parent.id, folder.id):
                raise HTTPException(status_code=400, detail="Folder cannot be moved into itself or a descendant")
            if _folder_depth(db, parent.id) + _subtree_height(db, folder.id) >= MAX_PROJECT_FOLDER_DEPTH:
                raise HTTPException(status_code=400, detail=f"Maximum folder depth of {MAX_PROJECT_FOLDER_DEPTH} exceeded")
            folder.parent_id = parent.id
    if body.name is not None:
        folder.name = body.name
    if body.is_private is not None:
        folder.is_private = body.is_private
    duplicate = db.query(ProjectFolder.id).filter(
        ProjectFolder.workspace_id == folder.workspace_id,
        ProjectFolder.parent_id == folder.parent_id,
        ProjectFolder.owner_id == folder.owner_id,
        ProjectFolder.name == folder.name,
        ProjectFolder.id != folder.id,
        ProjectFolder.deleted_at.is_(None),
    ).first()
    if duplicate:
        raise HTTPException(status_code=409, detail="A folder with this name already exists here")
    db.commit()
    db.refresh(folder)
    return folder


@router.delete("/project-folders/{folder_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project_folder(folder_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _lock_workspace(db)
    folder = _get_folder(db, folder_id)
    if folder.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the folder owner can delete a folder")
    folder_ids = _descendant_ids(db, folder.id)
    now = datetime.now(timezone.utc)
    operation = TrashOperation(
        entity_type=TrashEntityType.project_folder,
        entity_id=folder.id,
        deleted_by_id=current_user.id,
        workspace_id=folder.workspace_id,
        deleted_at=now,
    )
    db.add(operation)
    db.flush()
    db.query(PersonalProjectPlacement).filter(PersonalProjectPlacement.folder_id.in_(folder_ids), PersonalProjectPlacement.deleted_at.is_(None)).update({PersonalProjectPlacement.deleted_at: now, PersonalProjectPlacement.trash_operation_id: operation.id}, synchronize_session=False)
    db.query(ProjectFolderShare).filter(ProjectFolderShare.folder_id.in_(folder_ids), ProjectFolderShare.deleted_at.is_(None)).update({ProjectFolderShare.deleted_at: now, ProjectFolderShare.trash_operation_id: operation.id}, synchronize_session=False)
    db.query(ProjectFolder).filter(ProjectFolder.id.in_(folder_ids), ProjectFolder.deleted_at.is_(None)).update({ProjectFolder.deleted_at: now, ProjectFolder.trash_operation_id: operation.id}, synchronize_session=False)
    db.commit()


@router.post("/project-folders/{folder_id}/shares", response_model=ProjectFolderShareResponse, status_code=status.HTTP_201_CREATED)
def share_project_folder(folder_id: uuid.UUID, body: ProjectFolderShareRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    if body.role not in (ProjectRole.viewer, ProjectRole.editor):
        raise HTTPException(status_code=400, detail="Folder shares can grant Viewer or Editor only")
    _lock_workspace(db)
    folder = _get_folder(db, folder_id)
    if folder.owner_id != current_user.id or folder.scope == ProjectFolderScope.personal:
        raise HTTPException(status_code=403, detail="Only the owner can share a non-personal folder")
    user = db.query(User).filter(User.id == body.user_id, User.deleted_at.is_(None)).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    share = db.query(ProjectFolderShare).filter(ProjectFolderShare.folder_id == folder.id, ProjectFolderShare.user_id == user.id).first()
    if share:
        share.role = body.role
        share.shared_by = current_user.id
        share.deleted_at = None
    else:
        share = ProjectFolderShare(folder_id=folder.id, user_id=user.id, role=body.role, shared_by=current_user.id)
        db.add(share)
    db.commit()
    db.refresh(share)
    return share


@router.delete("/project-folders/{folder_id}/shares/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_project_folder_share(folder_id: uuid.UUID, user_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _lock_workspace(db)
    folder = _get_folder(db, folder_id)
    if folder.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the folder owner can remove a share")
    share = db.query(ProjectFolderShare).filter(ProjectFolderShare.folder_id == folder.id, ProjectFolderShare.user_id == user_id, ProjectFolderShare.deleted_at.is_(None)).first()
    if not share:
        raise HTTPException(status_code=404, detail="Folder share not found")
    share.deleted_at = datetime.now(timezone.utc)
    db.commit()


@router.put("/projects/{project_id}/project-folder", response_model=ProjectFolderResponse | None)
def move_project_to_folder(project_id: uuid.UUID, body: ProjectFolderProjectMove, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _lock_workspace(db)
    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    _require_project_owner(db, project.id, current_user)
    if body.folder_id is None:
        project.project_folder_id = None
        db.commit()
        return None
    folder = _get_folder(db, body.folder_id)
    if folder.scope == ProjectFolderScope.personal:
        raise HTTPException(status_code=400, detail="Personal folders cannot grant project access")
    _require_folder_editor(db, folder, current_user)
    project.project_folder_id = folder.id
    db.commit()
    return folder


@router.put("/projects/{project_id}/personal-placement", response_model=PersonalProjectPlacementResponse | None)
def set_personal_placement(project_id: uuid.UUID, body: PersonalProjectPlacementRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _lock_workspace(db)
    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if not get_effective_project_role(db, project.id, current_user):
        raise HTTPException(status_code=403, detail="Project access required")
    # Any newer placement decision supersedes a placement that was hidden when
    # its parent folder entered Trash, even if that newer placement is later removed.
    db.query(PersonalProjectPlacement).filter(
        PersonalProjectPlacement.user_id == current_user.id,
        PersonalProjectPlacement.project_id == project.id,
        PersonalProjectPlacement.deleted_at.isnot(None),
        PersonalProjectPlacement.trash_operation_id.isnot(None),
    ).update({PersonalProjectPlacement.restore_eligible: False}, synchronize_session=False)
    existing = db.query(PersonalProjectPlacement).filter(PersonalProjectPlacement.user_id == current_user.id, PersonalProjectPlacement.project_id == project.id, PersonalProjectPlacement.deleted_at.is_(None)).first()
    if body.folder_id is None:
        if existing:
            existing.deleted_at = datetime.now(timezone.utc)
        db.commit()
        return None
    folder = _get_folder(db, body.folder_id)
    if folder.scope != ProjectFolderScope.personal or folder.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Personal placement requires your personal folder")
    if existing:
        existing.folder_id = folder.id
    else:
        existing = PersonalProjectPlacement(user_id=current_user.id, project_id=project.id, folder_id=folder.id)
        db.add(existing)
    db.commit()
    db.refresh(existing)
    return existing
