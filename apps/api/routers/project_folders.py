import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.project import Project, ProjectMember, ProjectRole
from ..models.project_folder import (
    PersonalProjectPlacement,
    ProjectFolder,
    ProjectFolderScope,
    ProjectFolderShare,
)
from ..models.user import User
from ..models.workspace import Workspace, WorkspaceMember, WorkspaceRole
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
    return [folder for folder in folders if _folder_role(db, folder, current_user)]


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
    db.query(Project).filter(Project.project_folder_id.in_(folder_ids), Project.deleted_at.is_(None)).update({Project.project_folder_id: None}, synchronize_session=False)
    db.query(PersonalProjectPlacement).filter(PersonalProjectPlacement.folder_id.in_(folder_ids), PersonalProjectPlacement.deleted_at.is_(None)).update({PersonalProjectPlacement.deleted_at: now}, synchronize_session=False)
    db.query(ProjectFolderShare).filter(ProjectFolderShare.folder_id.in_(folder_ids), ProjectFolderShare.deleted_at.is_(None)).update({ProjectFolderShare.deleted_at: now}, synchronize_session=False)
    db.query(ProjectFolder).filter(ProjectFolder.id.in_(folder_ids), ProjectFolder.deleted_at.is_(None)).update({ProjectFolder.deleted_at: now}, synchronize_session=False)
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
