from fastapi import HTTPException, status
from sqlalchemy.orm import Session
import uuid
from ..models.user import User
from ..models.project import Project, ProjectMember, ProjectRole
from ..models.project_folder import ProjectFolder, ProjectFolderScope, ProjectFolderShare
from ..models.workspace import WorkspaceMember
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
    current_id = project.project_folder_id
    visited: set[uuid.UUID] = set()
    while current_id and current_id not in visited:
        visited.add(current_id)
        folder = db.query(ProjectFolder).filter(ProjectFolder.id == current_id, ProjectFolder.deleted_at.is_(None)).first()
        if not folder:
            break
        role = None
        if folder.owner_id == user.id:
            role = ProjectRole.editor
        elif folder.scope == ProjectFolderScope.workspace:
            workspace_member = db.query(WorkspaceMember).filter(WorkspaceMember.workspace_id == folder.workspace_id, WorkspaceMember.user_id == user.id, WorkspaceMember.deleted_at.is_(None)).first()
            if workspace_member:
                role = ProjectRole.viewer
        elif folder.scope == ProjectFolderScope.shared:
            share = db.query(ProjectFolderShare).filter(ProjectFolderShare.folder_id == folder.id, ProjectFolderShare.user_id == user.id, ProjectFolderShare.deleted_at.is_(None)).first()
            if share:
                role = share.role
        if role and (best is None or ROLE_RANK[role] > ROLE_RANK[best]):
            best = role
        if folder.is_private:
            break
        current_id = folder.parent_id
    return best


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
