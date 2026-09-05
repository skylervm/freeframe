from fastapi import HTTPException, status
from sqlalchemy.orm import Session
import uuid
from ..models.user import User, UserStatus
from ..models.project import Project, ProjectMember, ProjectRole
from ..models.project_folder import ProjectFolder, ProjectFolderScope, ProjectFolderShare
from ..models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from ..models.asset import Asset
from ..models.folder import Folder
from ..models.share import AssetShare, ShareLink, ShareLinkItem, SharePermission
from ..services.redis_service import verify_share_session


# ── Project-level ──────────────────────────────────────────────────────────────

def get_project_member(db: Session, project_id: uuid.UUID, user_id: uuid.UUID) -> ProjectMember | None:
    return db.query(ProjectMember).filter(
        ProjectMember.project_id == project_id,
        ProjectMember.user_id == user_id,
        ProjectMember.deleted_at.is_(None),
    ).first()


ROLE_RANK = {ProjectRole.owner: 4, ProjectRole.editor: 3, ProjectRole.reviewer: 2, ProjectRole.viewer: 1}


def require_workspace_owner_retained(db: Session, user_id: uuid.UUID) -> None:
    """Reject removing an account that is the last active owner of any workspace."""
    memberships = db.query(WorkspaceMember).filter(
        WorkspaceMember.user_id == user_id,
        WorkspaceMember.role == WorkspaceRole.owner,
        WorkspaceMember.deleted_at.is_(None),
    ).all()
    for membership in memberships:
        db.query(Workspace).filter(Workspace.id == membership.workspace_id).with_for_update().first()
        active_owners = db.query(WorkspaceMember).join(User, User.id == WorkspaceMember.user_id).filter(
            WorkspaceMember.workspace_id == membership.workspace_id,
            WorkspaceMember.role == WorkspaceRole.owner,
            WorkspaceMember.deleted_at.is_(None),
            User.deleted_at.is_(None),
            User.status == UserStatus.active,
        ).count()
        target_is_active = db.query(User.id).filter(
            User.id == user_id,
            User.deleted_at.is_(None),
            User.status == UserStatus.active,
        ).first() is not None
        if target_is_active and active_owners <= 1:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Workspace must retain an active owner")


def get_effective_project_role(db: Session, project_id: uuid.UUID, user: User) -> ProjectRole | None:
    """Resolve direct, public, and inherited project-folder access.

    Direct membership remains separate because owner-only mutations and
    automation credentials must never be authorized by a folder share.
    """
    direct = get_project_member(db, project_id, user.id)
    best = direct.role if direct else None
    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).first()
    if not project:
        return None
    if project.is_public and (best is None or ROLE_RANK[ProjectRole.viewer] > ROLE_RANK[best]):
        best = ProjectRole.viewer
    chain: list[ProjectFolder] = []
    current_id = project.project_folder_id
    visited: set[uuid.UUID] = set()
    while current_id and current_id not in visited:
        visited.add(current_id)
        folder = db.query(ProjectFolder).filter(ProjectFolder.id == current_id, ProjectFolder.deleted_at.is_(None)).first()
        if not folder:
            break
        chain.append(folder)
        current_id = folder.parent_id

    inherited: ProjectRole | None = None
    blocked = False
    for folder in reversed(chain):
        if folder.is_private:
            inherited = None
            blocked = True
        role: ProjectRole | None = None
        if folder.owner_id == user.id:
            role = ProjectRole.editor
        else:
            share = db.query(ProjectFolderShare).filter(ProjectFolderShare.folder_id == folder.id, ProjectFolderShare.user_id == user.id, ProjectFolderShare.deleted_at.is_(None)).first()
            if share:
                role = share.role
        if role is None and not blocked and folder.scope == ProjectFolderScope.workspace:
            workspace_member = db.query(WorkspaceMember).filter(WorkspaceMember.workspace_id == folder.workspace_id, WorkspaceMember.user_id == user.id, WorkspaceMember.deleted_at.is_(None)).first()
            if workspace_member:
                role = ProjectRole.viewer
        if role and (inherited is None or ROLE_RANK[role] > ROLE_RANK[inherited]):
            inherited = role
    if inherited and (best is None or ROLE_RANK[inherited] > ROLE_RANK[best]):
        best = inherited
    return best


def get_accessible_project_roles(db: Session, user: User) -> dict[uuid.UUID, ProjectRole]:
    """Return effective roles for every accessible project without per-project queries."""
    roles: dict[uuid.UUID, ProjectRole] = {}
    for project_id, role in db.query(ProjectMember.project_id, ProjectMember.role).join(
        Project, Project.id == ProjectMember.project_id,
    ).filter(
        ProjectMember.user_id == user.id,
        ProjectMember.deleted_at.is_(None),
        Project.deleted_at.is_(None),
    ):
        roles[project_id] = role

    projects = db.query(Project.id, Project.project_folder_id, Project.is_public).filter(Project.deleted_at.is_(None)).all()
    for project_id, _folder_id, is_public in projects:
        if is_public and (project_id not in roles or ROLE_RANK[roles[project_id]] < ROLE_RANK[ProjectRole.viewer]):
            roles[project_id] = ProjectRole.viewer

    folders = db.query(ProjectFolder).filter(ProjectFolder.deleted_at.is_(None)).all()
    folder_map = {folder.id: folder for folder in folders}
    shared_roles = {
        folder_id: role
        for folder_id, role in db.query(ProjectFolderShare.folder_id, ProjectFolderShare.role).filter(
            ProjectFolderShare.user_id == user.id,
            ProjectFolderShare.deleted_at.is_(None),
        )
    }
    workspace_ids = {
        workspace_id
        for (workspace_id,) in db.query(WorkspaceMember.workspace_id).filter(
            WorkspaceMember.user_id == user.id,
            WorkspaceMember.deleted_at.is_(None),
        )
    }
    for project_id, folder_id, _is_public in projects:
        chain: list[ProjectFolder] = []
        current_id = folder_id
        visited: set[uuid.UUID] = set()
        while current_id and current_id not in visited:
            visited.add(current_id)
            folder = folder_map.get(current_id)
            if not folder:
                break
            chain.append(folder)
            current_id = folder.parent_id
        inherited: ProjectRole | None = None
        blocked = False
        for folder in reversed(chain):
            if folder.is_private:
                inherited = None
                blocked = True
            role: ProjectRole | None = None
            if folder.owner_id == user.id:
                role = ProjectRole.editor
            elif folder.id in shared_roles:
                role = shared_roles[folder.id]
            elif not blocked and folder.scope == ProjectFolderScope.workspace and folder.workspace_id in workspace_ids:
                role = ProjectRole.viewer
            if role and (inherited is None or ROLE_RANK[role] > ROLE_RANK[inherited]):
                inherited = role
        if inherited and (project_id not in roles or ROLE_RANK[inherited] > ROLE_RANK[roles[project_id]]):
            roles[project_id] = inherited
    return roles


def require_effective_project_role(db: Session, project_id: uuid.UUID, user: User, minimum_role: ProjectRole) -> ProjectRole:
    role = get_effective_project_role(db, project_id, user)
    if not role or ROLE_RANK[role] < ROLE_RANK[minimum_role]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Requires project access")
    return role


def require_project_role(
    db: Session,
    project_id: uuid.UUID,
    user: User,
    minimum_role: ProjectRole,
) -> ProjectMember:
    """Require the user to have at least `minimum_role` on the project.

    Role hierarchy (descending): owner > editor > reviewer > viewer
    """
    member = get_project_member(db, project_id, user.id)
    if not member:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a project member")
    if ROLE_RANK[member.role] < ROLE_RANK[minimum_role]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Requires {minimum_role.value} role or higher",
        )
    return member


# ── Asset-level ────────────────────────────────────────────────────────────────

def is_public_project(db: Session, project_id: uuid.UUID) -> bool:
    """Check if a project is public."""
    project = db.query(Project).filter(
        Project.id == project_id,
        Project.deleted_at.is_(None),
    ).first()
    return project is not None and project.is_public


def can_access_asset(db: Session, asset: Asset, user: User) -> bool:
    """Check if user can access the asset via any path."""
    if user.deleted_at is not None or user.status != UserStatus.active:
        return False
    if asset.deleted_at is not None:
        return False
    project = db.query(Project).filter(
        Project.id == asset.project_id,
        Project.deleted_at.is_(None),
    ).first()
    if not project:
        return False

    # Project-derived access is always current, including for the uploader.
    if get_effective_project_role(db, asset.project_id, user):
        return True

    # Direct asset shares remain independent of project-folder access.
    direct = db.query(AssetShare).filter(
        AssetShare.asset_id == asset.id,
        AssetShare.shared_with_user_id == user.id,
        AssetShare.deleted_at.is_(None),
    ).first()
    if direct:
        return True

    return False


def require_asset_access(db: Session, asset: Asset, user: User) -> None:
    if not can_access_asset(db, asset, user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")


def get_asset_share_permission(db: Session, asset: Asset, user: User) -> SharePermission:
    """Get the effective share permission for a user on an asset (highest wins)."""
    PERM_RANK = {
        SharePermission.approve: 3,
        SharePermission.comment: 2,
        SharePermission.view: 1,
    }

    best = SharePermission.view

    # Direct share
    direct = db.query(AssetShare).filter(
        AssetShare.asset_id == asset.id,
        AssetShare.shared_with_user_id == user.id,
        AssetShare.deleted_at.is_(None),
    ).first()
    if direct and PERM_RANK[direct.permission] > PERM_RANK[best]:
        best = direct.permission

    return best


# ── Share link validation ──────────────────────────────────────────────────────

def validate_share_link(db: Session, token: str) -> ShareLink:
    """Validate a share link token and return the link. Raises 404/410 on failure."""
    from datetime import datetime, timezone
    link = db.query(ShareLink).filter(
        ShareLink.token == token,
        ShareLink.deleted_at.is_(None),
    ).first()
    if not link:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share link not found")
    if not link.is_enabled:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Share link is disabled")
    if link.expires_at and link.expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Share link has expired")
    if link.project_id:
        project_id = link.project_id
    elif link.asset_id:
        asset = db.query(Asset).filter(Asset.id == link.asset_id, Asset.deleted_at.is_(None)).first()
        project_id = asset.project_id if asset else None
    elif link.folder_id:
        folder = db.query(Folder).filter(Folder.id == link.folder_id, Folder.deleted_at.is_(None)).first()
        project_id = folder.project_id if folder else None
    else:
        project_id = None
    if not project_id or not db.query(Project.id).filter(
        Project.id == project_id,
        Project.deleted_at.is_(None),
    ).first():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share link not found")
    return link


def enforce_share_link_visibility(link: ShareLink, current_user: "User | None") -> None:
    """Enforce a share link's visibility setting. Raises 403 for a `secure` link
    with no authenticated caller.

    Every endpoint that serves share-link content must run this — gating it only
    where the link is first validated leaves the content endpoints (stream,
    thumbnail, versions, listings, comments) reachable with the token alone,
    which defeats the login requirement `secure` exists to impose.
    """
    if link.visibility == "secure" and not current_user:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Authentication required for this link's visibility setting",
        )


def validate_share_link_with_session(
    db: Session,
    token: str,
    share_session: "str | None" = None,
    current_user: "User | None" = None,
) -> ShareLink:
    """Validate a share link, enforce its visibility setting, and verify the
    password session if the link is password-protected.
    Skips password check if the caller is the authenticated link creator."""
    link = validate_share_link(db, token)
    enforce_share_link_visibility(link, current_user)
    if link.password_hash:
        # Skip password for authenticated link creator (e.g. admin settings preview)
        if current_user and link.created_by == current_user.id:
            return link
        if not share_session or not verify_share_session(token, share_session):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Password required",
            )
    return link


def _is_descendant_of(db: Session, folder_id: uuid.UUID, ancestor_id: uuid.UUID) -> bool:
    """Check if folder_id is a descendant of ancestor_id via parent chain traversal."""
    current_id = folder_id
    visited = set()
    while current_id and current_id not in visited:
        if current_id == ancestor_id:
            return True
        visited.add(current_id)
        folder = db.query(Folder.parent_id).filter(Folder.id == current_id).first()
        current_id = folder.parent_id if folder else None
    return False


def validate_asset_in_share(db: Session, link: ShareLink, asset: Asset) -> None:
    """Validate that an asset belongs to a share link (folder, asset, project, or multi-share).

    Every endpoint that accepts a client-supplied asset_id alongside a share token must call
    this — the token alone only proves the caller holds *some* valid link, not that this
    particular asset is within its shared scope.
    """
    if link.folder_id:
        if asset.folder_id != link.folder_id:
            if not asset.folder_id or not _is_descendant_of(db, asset.folder_id, link.folder_id):
                raise HTTPException(status_code=403, detail="Asset is not within the shared folder")
    elif link.asset_id:
        if asset.id != link.asset_id:
            raise HTTPException(status_code=403, detail="Asset does not match share link")
    elif link.project_id:
        if asset.project_id != link.project_id:
            raise HTTPException(status_code=403, detail="Asset is not within the shared project")
        # For multi-share links, also check ShareLinkItem entries
        multi_items = db.query(ShareLinkItem).filter(ShareLinkItem.share_link_id == link.id).all()
        if multi_items:
            multi_asset_ids = {item.asset_id for item in multi_items if item.asset_id}
            multi_folder_ids = {item.folder_id for item in multi_items if item.folder_id}
            if asset.id not in multi_asset_ids:
                # Check if asset is in one of the shared folders
                if not any(asset.folder_id == fid or (asset.folder_id and _is_descendant_of(db, asset.folder_id, fid)) for fid in multi_folder_ids):
                    raise HTTPException(status_code=403, detail="Asset is not in the shared items")
    else:
        raise HTTPException(status_code=400, detail="Invalid share link")
