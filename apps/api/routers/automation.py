"""Narrow, project-scoped endpoints for unattended media pipeline uploads."""
import uuid
import re
import hashlib
import json

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import text

from ..database import get_db
from ..middleware.automation_auth import AutomationActor, get_automation_actor
from ..models.asset import Asset, AssetVersion, MediaFile
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
_CLIP_INSTRUCTION = re.compile(r"^\s*clip\s+\d+\s*:\s*(start here|end here)\s*$", re.IGNORECASE)


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


@router.get("/versions/{version_id}")
def get_version_status(
    version_id: uuid.UUID,
    db: Session = Depends(get_db),
    actor: AutomationActor = Depends(get_automation_actor),
):
    version, asset = _version_in_scope(db, version_id, actor)
    return {"asset_id": asset.id, "version_id": version.id, "processing_status": version.processing_status}
