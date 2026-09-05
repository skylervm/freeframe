from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File
from sqlalchemy.orm import Session
from sqlalchemy import func
import uuid
import hashlib
import secrets
from datetime import datetime, timezone
from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.user import User
from ..models.project import Project, ProjectMember, ProjectRole
from ..models.automation_token import ProjectAutomationToken
from ..models.asset import Asset, AssetType, AssetVersion, MediaFile, ProcessingStatus
from ..schemas.project import ProjectCreate, ProjectUpdate, ProjectResponse, ProjectMemberResponse, AddProjectMemberRequest, UpdateProjectMemberRequest
from ..tasks.email_tasks import send_project_added_email
from ..tasks.celery_app import send_task_safe
from ..services.s3_service import put_object, generate_presigned_get_url, delete_object
from ..services.storage import project_storage_used_bytes
from ..config import settings
from ..schemas.automation_token import AutomationTokenCreate, AutomationTokenCreated, AutomationTokenResponse

router = APIRouter(prefix="/projects", tags=["projects"])

def _get_project(db: Session, project_id: uuid.UUID) -> Project:
    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project

def _automatic_poster_keys(db: Session, project_ids: list[uuid.UUID]) -> dict[uuid.UUID, str]:
    """Return each project's oldest video's newest ready thumbnail."""
    if not project_ids:
        return {}
    rows = (
        db.query(
            Asset.project_id,
            Asset.id,
            AssetVersion.version_number,
            MediaFile.s3_key_thumbnail,
        )
        .join(AssetVersion, AssetVersion.asset_id == Asset.id)
        .join(MediaFile, MediaFile.version_id == AssetVersion.id)
        .filter(
            Asset.project_id.in_(project_ids),
            Asset.asset_type == AssetType.video,
            Asset.deleted_at.is_(None),
            AssetVersion.deleted_at.is_(None),
            AssetVersion.processing_status == ProcessingStatus.ready,
            MediaFile.s3_key_thumbnail.isnot(None),
        )
        .order_by(
            Asset.project_id.asc(),
            Asset.created_at.asc(),
            Asset.id.asc(),
            AssetVersion.version_number.desc(),
            MediaFile.sequence_order.asc().nullsfirst(),
            MediaFile.id.asc(),
        )
        .all()
    )
    covers: dict[uuid.UUID, str] = {}
    for project_id, _asset_id, _version_number, thumbnail_key in rows:
        covers.setdefault(project_id, thumbnail_key)
    return covers


def _resolve_poster_url(project: Project, automatic_poster_key: str | None = None) -> str | None:
    if project.poster_s3_key:
        return generate_presigned_get_url(project.poster_s3_key)
    if automatic_poster_key:
        return generate_presigned_get_url(automatic_poster_key)
    return None

def _require_project_owner(db: Session, project_id: uuid.UUID, user: User) -> ProjectMember:
    member = db.query(ProjectMember).filter(
        ProjectMember.project_id == project_id,
        ProjectMember.user_id == user.id,
        ProjectMember.deleted_at.is_(None),
    ).first()
    if not member or member.role != ProjectRole.owner:
        raise HTTPException(status_code=403, detail="Project owner access required")
    return member


@router.post("/{project_id}/automation-tokens", response_model=AutomationTokenCreated, status_code=status.HTTP_201_CREATED)
def create_automation_token(
    project_id: uuid.UUID,
    body: AutomationTokenCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _get_project(db, project_id)
    _require_project_owner(db, project_id, current_user)
    if body.expires_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="Token expiry must be in the future")
    token_id = uuid.uuid4()
    secret = secrets.token_urlsafe(32)
    token = ProjectAutomationToken(
        id=token_id,
        project_id=project_id,
        name=body.name,
        secret_hash=hashlib.sha256(secret.encode()).hexdigest(),
        created_by=current_user.id,
        expires_at=body.expires_at,
    )
    db.add(token)
    db.commit()
    db.refresh(token)
    return AutomationTokenCreated(
        **AutomationTokenResponse.model_validate(token).model_dump(),
        token=f"ffat_{token_id}_{secret}",
    )


@router.get("/{project_id}/automation-tokens", response_model=list[AutomationTokenResponse])
def list_automation_tokens(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _get_project(db, project_id)
    _require_project_owner(db, project_id, current_user)
    return db.query(ProjectAutomationToken).filter(
        ProjectAutomationToken.project_id == project_id,
        ProjectAutomationToken.deleted_at.is_(None),
    ).order_by(ProjectAutomationToken.created_at.desc()).all()


@router.delete("/{project_id}/automation-tokens/{token_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_automation_token(
    project_id: uuid.UUID,
    token_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _get_project(db, project_id)
    _require_project_owner(db, project_id, current_user)
    token = db.query(ProjectAutomationToken).filter(
        ProjectAutomationToken.id == token_id,
        ProjectAutomationToken.project_id == project_id,
        ProjectAutomationToken.deleted_at.is_(None),
    ).first()
    if not token:
        raise HTTPException(status_code=404, detail="Automation token not found")
    token.revoked_at = datetime.now(timezone.utc)
    db.commit()

@router.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
def create_project(body: ProjectCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = Project(
        name=body.name,
        description=body.description,
        project_type=body.project_type,
        created_by=current_user.id,
    )
    db.add(project)
    db.flush()
    member = ProjectMember(project_id=project.id, user_id=current_user.id, role=ProjectRole.owner)
    db.add(member)
    db.commit()
    db.refresh(project)
    return project

@router.get("", response_model=list[ProjectResponse])
def list_projects(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    from sqlalchemy import or_

    # Get memberships for current user
    memberships = db.query(ProjectMember).filter(
        ProjectMember.user_id == current_user.id,
        ProjectMember.deleted_at.is_(None),
    ).all()
    membership_map = {m.project_id: m.role for m in memberships}
    member_project_ids = list(membership_map.keys())

    # Get projects: user's memberships + all public projects
    projects = db.query(Project).filter(
        Project.deleted_at.is_(None),
        or_(
            Project.id.in_(member_project_ids) if member_project_ids else False,
            Project.is_public == True,
        ),
    ).all()

    all_project_ids = [p.id for p in projects]
    if not all_project_ids:
        return []

    # Batch: asset counts per project
    asset_counts = dict(
        db.query(Asset.project_id, func.count(Asset.id))
        .filter(Asset.project_id.in_(all_project_ids), Asset.deleted_at.is_(None))
        .group_by(Asset.project_id)
        .all()
    )

    # Batch: storage bytes per project (sum of file sizes)
    storage_query = (
        db.query(Asset.project_id, func.coalesce(func.sum(MediaFile.file_size_bytes), 0))
        .join(AssetVersion, AssetVersion.asset_id == Asset.id)
        .join(MediaFile, MediaFile.version_id == AssetVersion.id)
        # Committed-only usage — matches services.storage.instance_storage_used_bytes
        .filter(
            Asset.project_id.in_(all_project_ids), Asset.deleted_at.is_(None),
            AssetVersion.deleted_at.is_(None),
            AssetVersion.processing_status.in_([
                ProcessingStatus.queued,
                ProcessingStatus.processing,
                ProcessingStatus.ready,
            ]),
        )
        .group_by(Asset.project_id)
        .all()
    )
    storage_map = {pid: int(size) for pid, size in storage_query}

    # Batch: member counts per project
    member_counts = dict(
        db.query(ProjectMember.project_id, func.count(ProjectMember.id))
        .filter(ProjectMember.project_id.in_(all_project_ids), ProjectMember.deleted_at.is_(None))
        .group_by(ProjectMember.project_id)
        .all()
    )

    automatic_poster_keys = _automatic_poster_keys(db, all_project_ids)
    result = []
    for p in projects:
        resp = ProjectResponse.model_validate(p)
        resp.poster_url = _resolve_poster_url(p, automatic_poster_keys.get(p.id))
        resp.asset_count = asset_counts.get(p.id, 0)
        resp.storage_bytes = storage_map.get(p.id, 0)
        resp.member_count = member_counts.get(p.id, 0)
        resp.role = membership_map.get(p.id)
        result.append(resp)

    return result

@router.get("/{project_id}", response_model=ProjectResponse)
def get_project(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = _get_project(db, project_id)
    member = db.query(ProjectMember).filter(
        ProjectMember.project_id == project_id,
        ProjectMember.user_id == current_user.id,
        ProjectMember.deleted_at.is_(None),
    ).first()
    if not member and not project.is_public:
        raise HTTPException(status_code=403, detail="Not a project member")
    resp = ProjectResponse.model_validate(project)
    resp.poster_url = _resolve_poster_url(project, _automatic_poster_keys(db, [project.id]).get(project.id))
    if member:
        resp.role = member.role
    # Calculate storage, asset count, member count
    resp.asset_count = db.query(func.count(Asset.id)).filter(
        Asset.project_id == project_id, Asset.deleted_at.is_(None),
    ).scalar() or 0
    resp.storage_bytes = project_storage_used_bytes(db, project_id)
    resp.member_count = db.query(func.count(ProjectMember.id)).filter(
        ProjectMember.project_id == project_id, ProjectMember.deleted_at.is_(None),
    ).scalar() or 0
    return resp

@router.patch("/{project_id}", response_model=ProjectResponse)
def update_project(project_id: uuid.UUID, body: ProjectUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = _get_project(db, project_id)
    _require_project_owner(db, project_id, current_user)
    if body.name is not None:
        project.name = body.name
    if body.description is not None:
        project.description = body.description
    if body.is_public is not None:
        project.is_public = body.is_public
    db.commit()
    db.refresh(project)
    resp = ProjectResponse.model_validate(project)
    resp.poster_url = _resolve_poster_url(project, _automatic_poster_keys(db, [project.id]).get(project.id))
    return resp

@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = _get_project(db, project_id)
    _require_project_owner(db, project_id, current_user)
    project.deleted_at = datetime.now(timezone.utc)
    db.commit()

@router.get("/{project_id}/members", response_model=list[ProjectMemberResponse])
def list_project_members(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _get_project(db, project_id)
    # Verify user is a member
    member = db.query(ProjectMember).filter(
        ProjectMember.project_id == project_id,
        ProjectMember.user_id == current_user.id,
        ProjectMember.deleted_at.is_(None),
    ).first()
    if not member:
        raise HTTPException(status_code=403, detail="Not a project member")
    
    members = db.query(ProjectMember).filter(
        ProjectMember.project_id == project_id,
        ProjectMember.deleted_at.is_(None),
    ).all()
    return members

@router.post("/{project_id}/members", response_model=ProjectMemberResponse, status_code=status.HTTP_201_CREATED)
def add_project_member(project_id: uuid.UUID, body: AddProjectMemberRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _get_project(db, project_id)
    _require_project_owner(db, project_id, current_user)
    existing = db.query(ProjectMember).filter(ProjectMember.project_id == project_id, ProjectMember.user_id == body.user_id).first()
    if existing:
        if existing.deleted_at is None:
            raise HTTPException(status_code=400, detail="User already a project member")
        # Reactivate soft-deleted membership
        existing.deleted_at = None
        existing.role = body.role
        db.commit()
        db.refresh(existing)
        member = existing
    else:
        member = ProjectMember(project_id=project_id, user_id=body.user_id, role=body.role, invited_by=current_user.id)
        db.add(member)
        db.commit()
        db.refresh(member)

    # Send project added email (for both new and reactivated members)
    project = _get_project(db, project_id)
    added_user = db.query(User).filter(User.id == body.user_id).first()
    if added_user:
        project_link = f"{settings.frontend_url}/projects/{project_id}"
        send_task_safe(send_project_added_email,
            to_email=added_user.email,
            adder_name=current_user.name,
            project_name=project.name,
            project_link=project_link,
            role=body.role.value if body.role else None,
        )

    return member

@router.patch("/{project_id}/members/{user_id}", response_model=ProjectMemberResponse)
def update_project_member(project_id: uuid.UUID, user_id: uuid.UUID, body: UpdateProjectMemberRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _get_project(db, project_id)
    _require_project_owner(db, project_id, current_user)
    member = db.query(ProjectMember).filter(ProjectMember.project_id == project_id, ProjectMember.user_id == user_id, ProjectMember.deleted_at.is_(None)).first()
    if not member:
        raise HTTPException(status_code=404, detail="Member not found")
    member.role = body.role
    db.commit()
    db.refresh(member)
    return member

@router.delete("/{project_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_project_member(project_id: uuid.UUID, user_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _get_project(db, project_id)
    _require_project_owner(db, project_id, current_user)
    member = db.query(ProjectMember).filter(ProjectMember.project_id == project_id, ProjectMember.user_id == user_id, ProjectMember.deleted_at.is_(None)).first()
    if not member:
        raise HTTPException(status_code=404, detail="Member not found")
    member.deleted_at = datetime.now(timezone.utc)
    db.commit()

ALLOWED_POSTER_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
MAX_POSTER_SIZE = 10 * 1024 * 1024  # 10MB

@router.post("/{project_id}/poster", response_model=ProjectResponse)
async def upload_project_poster(
    project_id: uuid.UUID,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    project = _get_project(db, project_id)
    _require_project_owner(db, project_id, current_user)

    if file.content_type not in ALLOWED_POSTER_TYPES:
        raise HTTPException(status_code=400, detail="File must be JPEG, PNG, WebP, or GIF")

    data = await file.read()
    if len(data) > MAX_POSTER_SIZE:
        raise HTTPException(status_code=400, detail="File must be under 10MB")

    # Delete old poster if exists
    if project.poster_s3_key:
        try:
            delete_object(project.poster_s3_key)
        except Exception:
            pass

    ext = file.filename.rsplit(".", 1)[-1].lower() if file.filename and "." in file.filename else "jpg"
    s3_key = f"posters/{project_id}/poster.{ext}"
    put_object(s3_key, data, content_type=file.content_type, cache_control="max-age=86400")

    project.poster_s3_key = s3_key
    db.commit()
    db.refresh(project)

    resp = ProjectResponse.model_validate(project)
    resp.poster_url = _resolve_poster_url(project, _automatic_poster_keys(db, [project.id]).get(project.id))
    return resp

@router.delete("/{project_id}/poster", status_code=status.HTTP_204_NO_CONTENT)
def remove_project_poster(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    project = _get_project(db, project_id)
    _require_project_owner(db, project_id, current_user)

    if project.poster_s3_key:
        try:
            delete_object(project.poster_s3_key)
        except Exception:
            pass
        project.poster_s3_key = None
        db.commit()
