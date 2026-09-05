"""Narrow, project-scoped endpoints for unattended media pipeline uploads."""
import uuid
import re
import hashlib
import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Query, status
from sqlalchemy.orm import Session
from sqlalchemy import text

from ..config import settings
from ..database import get_db
from ..middleware.automation_auth import AutomationActor, get_automation_actor
from ..middleware.bootstrap_auth import BootstrapActor, get_bootstrap_actor
from ..models.asset import Asset, AssetVersion, MediaFile, ProcessingStatus
from ..models.activity import ActivityLog
from ..models.automation_token import ProjectAutomationToken
from ..models.project import AutomationBootstrapRequest, AutomationBootstrapRenewal, Project, ProjectMember, ProjectRole, ProjectType
from ..models.trash import TrashEntityType, TrashOperation
from ..models.user import User, UserStatus
from ..schemas.bootstrap import BootstrapProjectCreate, BootstrapProjectResponse, BootstrapTokenRenewal
from ..middleware.rate_limit import rate_limit
from ..models.comment import Comment
from ..schemas.upload import (
    AbortUploadRequest,
    CompleteUploadRequest,
    CompleteUploadResponse,
    InitiateUploadRequest,
    InitiateUploadResponse,
    PresignPartRequest,
    PresignPartResponse,
)
from . import upload


router = APIRouter(prefix="/automation", tags=["automation"])
_CLIP_INSTRUCTION = re.compile(
    r"^\s*clip\s+\d+\s*:\s*(?:start|end)(?:\s+here)?\s*$", re.IGNORECASE
)


def _lock_idempotency_key(db: Session, token_id: uuid.UUID, key: uuid.UUID) -> None:
    """Serialize matching requests until their upload version is committed.

    FreeFrame is PostgreSQL-backed. Holding this transaction-scoped lock through
    the version commit prevents two lost-response retries from creating two
    multipart uploads for the same idempotency key.
    """
    lock_key = int.from_bytes(
        hashlib.sha256(f"{token_id}:{key}".encode()).digest()[:8], "big", signed=True
    )
    db.execute(text("SELECT pg_advisory_xact_lock(:lock_key)"), {"lock_key": lock_key})


def _request_fingerprint(body: InitiateUploadRequest) -> str:
    """Bind an idempotency key to one immutable upload request."""
    payload = {
        "project_id": str(body.project_id),
        "asset_id": str(body.asset_id) if body.asset_id else None,
        "folder_id": str(body.folder_id) if body.folder_id else None,
        "asset_name": body.asset_name,
        "original_filename": body.original_filename,
        "mime_type": body.mime_type,
        "file_size_bytes": body.file_size_bytes,
        "content_sha256": body.content_sha256,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _bootstrap_fingerprint(body: BootstrapProjectCreate) -> str:
    payload = {"name": body.name, "description": body.description, "token_id": str(body.token_id), "token_secret_hash": body.token_secret_hash}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _bootstrap_lock(db: Session, key: str) -> None:
    lock_key = int.from_bytes(hashlib.sha256(f"bootstrap:{key}".encode()).digest()[:8], "big", signed=True)
    db.execute(text("SELECT pg_advisory_xact_lock(:lock_key)"), {"lock_key": lock_key})


@router.post(
    "/bootstrap/projects",
    response_model=BootstrapProjectResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(rate_limit("automation_bootstrap_project", 3, 3600))],
)
def bootstrap_project(
    body: BootstrapProjectCreate,
    idempotency_key: uuid.UUID = Header(alias="Idempotency-Key"),
    db: Session = Depends(get_db),
    actor: BootstrapActor = Depends(get_bootstrap_actor),
):
    """Create one private project and a bounded scoped token, or replay it safely."""
    if settings.automation_bootstrap_max_projects_per_day < 1:
        raise HTTPException(status_code=503, detail="Bootstrap automation is disabled")
    if settings.automation_bootstrap_token_lifetime_hours < 1:
        raise HTTPException(status_code=503, detail="Bootstrap token lifetime is invalid")
    if settings.automation_bootstrap_max_file_bytes < 1 or settings.automation_bootstrap_max_total_upload_bytes < settings.automation_bootstrap_max_file_bytes:
        raise HTTPException(status_code=503, detail="Bootstrap upload limits are invalid")

    key = str(idempotency_key)
    fingerprint = _bootstrap_fingerprint(body)
    _bootstrap_lock(db, key)
    existing = db.query(AutomationBootstrapRequest).filter(AutomationBootstrapRequest.idempotency_key == key).first()
    if existing:
        if existing.request_fingerprint != fingerprint:
            raise HTTPException(status_code=409, detail="Idempotency key cannot be reused for a different project")
        project = db.query(Project).filter(Project.id == existing.project_id, Project.deleted_at.is_(None)).first()
        token = db.query(ProjectAutomationToken).filter(ProjectAutomationToken.id == existing.token_id, ProjectAutomationToken.deleted_at.is_(None)).first()
        if not project or not token:
            raise HTTPException(status_code=409, detail="Previous bootstrap request is no longer usable")
        return BootstrapProjectResponse(project_id=project.id, project_name=project.name, token_id=token.id, token_expires_at=token.expires_at)

    # Locking the configured owner makes the durable daily ceiling safe even if Redis is unavailable.
    owner = db.query(User).populate_existing().with_for_update().filter(
        User.id == actor.user.id,
        User.deleted_at.is_(None),
        User.status == UserStatus.active,
    ).first()
    if not owner:
        raise HTTPException(status_code=401, detail="Invalid bootstrap credential")
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    created_today = db.query(AutomationBootstrapRequest).filter(
        AutomationBootstrapRequest.owner_id == actor.user.id,
        AutomationBootstrapRequest.created_at >= today,
    ).count()
    if created_today >= settings.automation_bootstrap_max_projects_per_day:
        raise HTTPException(status_code=429, detail="Daily bootstrap project limit reached")

    expires_at = datetime.now(timezone.utc) + timedelta(hours=settings.automation_bootstrap_token_lifetime_hours)
    project = Project(name=body.name, description=body.description, project_type=ProjectType.personal, created_by=actor.user.id, is_public=False)
    db.add(project)
    db.flush()
    db.add(ProjectMember(project_id=project.id, user_id=actor.user.id, role=ProjectRole.owner))
    token = ProjectAutomationToken(
        id=body.token_id,
        project_id=project.id,
        name="terminal bootstrap",
        secret_hash=body.token_secret_hash,
        created_by=actor.user.id,
        expires_at=expires_at,
        max_file_bytes=settings.automation_bootstrap_max_file_bytes,
        max_total_upload_bytes=settings.automation_bootstrap_max_total_upload_bytes,
    )
    db.add(token)
    db.add(AutomationBootstrapRequest(idempotency_key=key, request_fingerprint=fingerprint, project_id=project.id, token_id=token.id, owner_id=actor.user.id))
    db.add(ActivityLog(project_id=project.id, user_id=actor.user.id, action="automation_bootstrap_project_created", payload={"request_id": key, "token_id": str(token.id)}))
    db.commit()
    return BootstrapProjectResponse(project_id=project.id, project_name=project.name, token_id=token.id, token_expires_at=expires_at)


@router.post(
    "/bootstrap/projects/{project_id}/token-renewals",
    response_model=BootstrapProjectResponse,
    dependencies=[Depends(rate_limit("automation_bootstrap_renewal", 3, 3600))],
)
def renew_bootstrap_token(
    project_id: uuid.UUID,
    body: BootstrapTokenRenewal,
    idempotency_key: uuid.UUID = Header(alias="Idempotency-Key"),
    db: Session = Depends(get_db),
    actor: BootstrapActor = Depends(get_bootstrap_actor),
):
    key = str(idempotency_key)
    fingerprint = hashlib.sha256(f"{project_id}:{body.token_secret_hash}".encode()).hexdigest()
    _bootstrap_lock(db, key)
    prior = db.query(AutomationBootstrapRenewal).filter(AutomationBootstrapRenewal.idempotency_key == key).first()
    if prior:
        if prior.request_fingerprint != fingerprint:
            raise HTTPException(status_code=409, detail="Idempotency key cannot be reused for a different renewal")
        project = db.query(Project).filter(Project.id == prior.project_id, Project.deleted_at.is_(None)).first()
        token = db.query(ProjectAutomationToken).filter(
            ProjectAutomationToken.id == prior.token_id,
            ProjectAutomationToken.project_id == prior.project_id,
            ProjectAutomationToken.deleted_at.is_(None),
            ProjectAutomationToken.revoked_at.is_(None),
        ).first()
        if not project or not token or token.secret_hash != body.token_secret_hash:
            raise HTTPException(status_code=409, detail="Previous bootstrap renewal is no longer usable")
        return BootstrapProjectResponse(project_id=project.id, project_name=project.name, token_id=prior.token_id, token_expires_at=prior.expires_at)
    request = db.query(AutomationBootstrapRequest).filter(AutomationBootstrapRequest.project_id == project_id).first()
    if not request or request.owner_id != actor.user.id:
        raise HTTPException(status_code=404, detail="Bootstrap project not found")
    token = db.query(ProjectAutomationToken).populate_existing().with_for_update().filter(
        ProjectAutomationToken.id == request.token_id,
        ProjectAutomationToken.project_id == project_id,
        ProjectAutomationToken.deleted_at.is_(None),
        ProjectAutomationToken.revoked_at.is_(None),
    ).first()
    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).first()
    if not token or not project:
        raise HTTPException(status_code=404, detail="Bootstrap project not found")
    if settings.automation_bootstrap_max_renewals_per_day < 1:
        raise HTTPException(status_code=503, detail="Bootstrap token renewal is disabled")
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    renewed_today = db.query(AutomationBootstrapRenewal).filter(
        AutomationBootstrapRenewal.project_id == project_id,
        AutomationBootstrapRenewal.created_at >= today,
    ).count()
    if renewed_today >= settings.automation_bootstrap_max_renewals_per_day:
        raise HTTPException(status_code=429, detail="Daily bootstrap token renewal limit reached")
    expires_at = datetime.now(timezone.utc) + timedelta(hours=settings.automation_bootstrap_token_lifetime_hours)
    token.secret_hash = body.token_secret_hash
    token.expires_at = expires_at
    db.add(AutomationBootstrapRenewal(idempotency_key=key, request_fingerprint=fingerprint, project_id=project_id, token_id=token.id, expires_at=expires_at))
    db.commit()
    return BootstrapProjectResponse(project_id=project.id, project_name=project.name, token_id=token.id, token_expires_at=expires_at)


def _asset_in_scope(db: Session, asset_id: uuid.UUID, actor: AutomationActor) -> Asset:
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset or asset.project_id != actor.project_id:
        raise HTTPException(status_code=404, detail="Asset not found")
    return asset


def _version_in_scope(db: Session, version_id: uuid.UUID, actor: AutomationActor) -> tuple[AssetVersion, Asset]:
    version = db.query(AssetVersion).filter(AssetVersion.id == version_id, AssetVersion.deleted_at.is_(None)).first()
    if not version or version.automation_token_id != actor.token_id:
        raise HTTPException(status_code=404, detail="Upload not found")
    asset = _asset_in_scope(db, version.asset_id, actor)
    return version, asset


def _validate_upload_key(db: Session, version: AssetVersion, s3_key: str) -> None:
    media_file = db.query(MediaFile).filter(
        MediaFile.version_id == version.id,
        MediaFile.s3_key_raw == s3_key,
    ).first()
    if not media_file:
        raise HTTPException(status_code=404, detail="Upload not found")


def _reserve_bootstrap_upload_bytes(db: Session, actor: AutomationActor, requested_bytes: int) -> None:
    """Atomically reserve quota for bounded tokens before S3 accepts bytes."""
    token = db.query(ProjectAutomationToken).populate_existing().with_for_update().filter(
        ProjectAutomationToken.id == actor.token_id,
        ProjectAutomationToken.deleted_at.is_(None),
    ).first()
    if not token:
        raise HTTPException(status_code=401, detail="Invalid automation token")
    if token.max_file_bytes is None and token.max_total_upload_bytes is None:
        return
    if token.max_file_bytes is None or token.max_total_upload_bytes is None:
        raise HTTPException(status_code=503, detail="Automation token limits are invalid")
    if requested_bytes > token.max_file_bytes:
        raise HTTPException(status_code=413, detail="File exceeds this token's upload limit")
    if token.reserved_upload_bytes + requested_bytes > token.max_total_upload_bytes:
        raise HTTPException(status_code=413, detail="This token's total upload limit has been reached")
    token.reserved_upload_bytes += requested_bytes


@router.post("/upload/initiate", response_model=InitiateUploadResponse)
def initiate_upload(
    body: InitiateUploadRequest,
    idempotency_key: uuid.UUID = Header(alias="Idempotency-Key"),
    db: Session = Depends(get_db),
    actor: AutomationActor = Depends(get_automation_actor),
):
    if body.project_id != actor.project_id:
        raise HTTPException(status_code=403, detail="Automation token is not valid for this project")
    if not body.content_sha256:
        raise HTTPException(status_code=400, detail="content_sha256 is required for automation uploads")
    if body.asset_id is not None:
        _asset_in_scope(db, body.asset_id, actor)
    _lock_idempotency_key(db, actor.token_id, idempotency_key)
    fingerprint = _request_fingerprint(body)
    existing = db.query(AssetVersion).filter(
        AssetVersion.automation_token_id == actor.token_id,
        AssetVersion.client_request_id == str(idempotency_key),
    ).first()
    if existing:
        if existing.deleted_at is not None or existing.automation_request_fingerprint != fingerprint:
            raise HTTPException(status_code=409, detail="Idempotency key cannot be reused for this upload")
        media_file = db.query(MediaFile).filter(MediaFile.version_id == existing.id).first()
        if not media_file or not existing.upload_id:
            raise HTTPException(status_code=409, detail="The previous upload request cannot be resumed")
        return InitiateUploadResponse(
            upload_id=existing.upload_id,
            s3_key=media_file.s3_key_raw,
            asset_id=existing.asset_id,
            version_id=existing.id,
        )
    _reserve_bootstrap_upload_bytes(db, actor, body.file_size_bytes)
    return upload._initiate_upload(
        body,
        db,
        actor.user,
        automation_token_id=actor.token_id,
        client_request_id=str(idempotency_key),
        automation_request_fingerprint=fingerprint,
    )


@router.post("/upload/presign-part", response_model=PresignPartResponse)
def presign_part(
    body: PresignPartRequest,
    db: Session = Depends(get_db),
    actor: AutomationActor = Depends(get_automation_actor),
):
    version = db.query(AssetVersion).join(MediaFile, MediaFile.version_id == AssetVersion.id).filter(
        MediaFile.s3_key_raw == body.s3_key,
        AssetVersion.deleted_at.is_(None),
    ).first()
    if not version:
        raise HTTPException(status_code=404, detail="Upload not found")
    scoped_version, _ = _version_in_scope(db, version.id, actor)
    if scoped_version.upload_id != body.upload_id:
        raise HTTPException(status_code=403, detail="Upload does not match this version")
    _validate_upload_key(db, scoped_version, body.s3_key)
    return upload.presign_part(body, db, actor.user)


@router.post("/upload/complete", response_model=CompleteUploadResponse)
def complete_upload(
    body: CompleteUploadRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    actor: AutomationActor = Depends(get_automation_actor),
):
    version, asset = _version_in_scope(db, body.version_id, actor)
    if body.asset_id != asset.id or version.upload_id != body.upload_id:
        raise HTTPException(status_code=403, detail="Upload does not match this version")
    _validate_upload_key(db, version, body.s3_key)
    return upload.complete_upload(body, background_tasks, db, actor.user)


@router.post("/upload/abort", status_code=204)
def abort_upload(
    body: AbortUploadRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    actor: AutomationActor = Depends(get_automation_actor),
):
    version, _ = _version_in_scope(db, body.version_id, actor)
    if version.upload_id != body.upload_id:
        raise HTTPException(status_code=403, detail="Upload does not match this version")
    _validate_upload_key(db, version, body.s3_key)
    return upload.abort_upload(body, background_tasks, db, actor.user)


@router.get("/assets/{asset_id}/comments")
def list_comments(
    asset_id: uuid.UUID,
    version_id: uuid.UUID = Query(...),
    db: Session = Depends(get_db),
    actor: AutomationActor = Depends(get_automation_actor),
):
    _asset_in_scope(db, asset_id, actor)
    version = db.query(AssetVersion).filter(
        AssetVersion.id == version_id,
        AssetVersion.asset_id == asset_id,
        AssetVersion.deleted_at.is_(None),
    ).first()
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")
    comments = db.query(Comment).filter(
        Comment.asset_id == asset_id,
        Comment.version_id == version_id,
        Comment.parent_id.is_(None),
        Comment.deleted_at.is_(None),
        Comment.resolved.is_(False),
    ).order_by(Comment.created_at).all()
    return [
        {
            "id": comment.id,
            "asset_id": comment.asset_id,
            "version_id": comment.version_id,
            "body": comment.body,
            "timecode_start": comment.timecode_start,
            "timecode_end": comment.timecode_end,
            "resolved": comment.resolved,
            "visibility": comment.visibility,
            "created_at": comment.created_at,
        }
        for comment in comments if _CLIP_INSTRUCTION.match(comment.body or "")
    ]


@router.get("/assets/{asset_id}/review-version")
def get_review_version(
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
    actor: AutomationActor = Depends(get_automation_actor),
):
    """Return the same current viewable version selected by the review UI."""
    _asset_in_scope(db, asset_id, actor)
    version = db.query(AssetVersion).filter(
        AssetVersion.asset_id == asset_id,
        AssetVersion.deleted_at.is_(None),
        AssetVersion.processing_status == ProcessingStatus.ready,
    ).order_by(AssetVersion.version_number.desc()).first()
    if not version:
        version = db.query(AssetVersion).filter(
            AssetVersion.asset_id == asset_id,
            AssetVersion.deleted_at.is_(None),
            AssetVersion.processing_status.notin_(
                (ProcessingStatus.uploading, ProcessingStatus.failed)
            ),
        ).order_by(AssetVersion.version_number.desc()).first()
    if not version:
        version = db.query(AssetVersion).filter(
            AssetVersion.asset_id == asset_id,
            AssetVersion.deleted_at.is_(None),
        ).order_by(AssetVersion.version_number.desc()).first()
    if not version:
        raise HTTPException(status_code=404, detail="No viewable version found")
    return {
        "id": version.id,
        "version_number": version.version_number,
        "processing_status": version.processing_status,
    }


@router.delete("/assets/{asset_id}", status_code=204)
def delete_automation_asset(
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
    actor: AutomationActor = Depends(get_automation_actor),
):
    """Soft-delete one asset only when it belongs to the token's project."""
    asset = _asset_in_scope(db, asset_id, actor)
    owner = db.query(ProjectMember).filter(
        ProjectMember.project_id == asset.project_id,
        ProjectMember.role == ProjectRole.owner,
        ProjectMember.deleted_at.is_(None),
    ).first()
    if not owner:
        raise HTTPException(status_code=409, detail="Project has no active owner")
    now = datetime.now(timezone.utc)
    operation = TrashOperation(
        entity_type=TrashEntityType.asset,
        entity_id=asset.id,
        deleted_by_id=owner.user_id,
        project_id=asset.project_id,
        deleted_at=now,
    )
    db.add(operation)
    db.flush()
    asset.deleted_at = now
    asset.trash_operation_id = operation.id
    db.commit()


@router.get("/versions/{version_id}")
def get_version_status(
    version_id: uuid.UUID,
    db: Session = Depends(get_db),
    actor: AutomationActor = Depends(get_automation_actor),
):
    version, asset = _version_in_scope(db, version_id, actor)
    return {"asset_id": asset.id, "version_id": version.id, "processing_status": version.processing_status}
