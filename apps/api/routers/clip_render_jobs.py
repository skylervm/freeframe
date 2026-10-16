import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.asset import Asset, AssetType, AssetVersion, MediaFile, ProcessingStatus
from ..models.automation_token import ProjectAutomationToken
from ..models.clip_render_job import ClipRenderJob
from ..models.project import ProjectRole
from ..models.user import User
from ..schemas.clip_render_job import ClipRenderJobCreate, ClipRenderJobResponse, LatestClipRenderJob
from ..services.clip_render_jobs import CLIP_RENDER_LEASE, locked_snapshot, range_comments
from ..services.permissions import get_effective_project_role


router = APIRouter(tags=["clip-render-jobs"])


def _asset_access(db: Session, asset_id: uuid.UUID, user: User, *, write: bool = False) -> Asset:
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    role = get_effective_project_role(db, asset.project_id, user)
    if not role or (write and role not in (ProjectRole.owner, ProjectRole.editor)):
        raise HTTPException(status_code=403, detail="Requires project owner or editor" if write else "Requires project access")
    return asset


def _version(db: Session, asset: Asset, version_id: uuid.UUID, *, lock: bool = False) -> AssetVersion:
    query = db.query(AssetVersion).filter(
        AssetVersion.id == version_id, AssetVersion.asset_id == asset.id, AssetVersion.deleted_at.is_(None),
    )
    if lock:
        query = query.with_for_update()
    version = query.first()
    if not version:
        raise HTTPException(status_code=409, detail={"code": "version_not_ready", "message": "Version is unavailable"})
    return version


@router.post("/assets/{asset_id}/clip-render-jobs", response_model=ClipRenderJobResponse, status_code=201)
def create_clip_render_job(
    asset_id: uuid.UUID,
    body: ClipRenderJobCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = _asset_access(db, asset_id, current_user, write=True)
    # Serialize creation for this version so two button presses cannot both queue a job.
    version = _version(db, asset, body.version_id, lock=True)
    if asset.asset_type != AssetType.video or version.processing_status != ProcessingStatus.ready:
        raise HTTPException(status_code=409, detail={"code": "version_not_ready", "message": "A ready video version is required"})
    media_file = db.query(MediaFile).filter(MediaFile.version_id == version.id).first()
    if not media_file or not media_file.mime_type.startswith("video/"):
        raise HTTPException(status_code=409, detail={"code": "version_not_ready", "message": "A ready video version is required"})
    ranges, ranges_hash = locked_snapshot(range_comments(db, asset.id, version.id))
    if not ranges:
        raise HTTPException(status_code=409, detail={"code": "no_locked_ranges", "message": "Lock a range to generate clips"})
    jobs = db.query(ClipRenderJob).filter(
        ClipRenderJob.project_id == asset.project_id,
        ClipRenderJob.version_id == version.id,
        ClipRenderJob.deleted_at.is_(None),
    )
    now = datetime.now(timezone.utc)
    jobs.filter(
        ClipRenderJob.status == "claimed",
        ClipRenderJob.claimed_at <= now - CLIP_RENDER_LEASE,
    ).update({"status": "failed", "message": "Render lease expired", "finished_at": now}, synchronize_session=False)
    active = jobs.filter(or_(
        ClipRenderJob.status == "queued",
        and_(ClipRenderJob.status == "claimed", ClipRenderJob.claimed_at > now - CLIP_RENDER_LEASE),
    )).first()
    if active:
        raise HTTPException(status_code=409, detail={"code": "job_active", "message": "A render job is already active"})
    done = jobs.filter(ClipRenderJob.status == "done").order_by(ClipRenderJob.created_at.desc(), ClipRenderJob.id.desc()).first()
    if done and done.ranges_hash == ranges_hash:
        raise HTTPException(status_code=409, detail={"code": "already_rendered", "message": "These locked ranges have already been rendered"})
    job = ClipRenderJob(
        project_id=asset.project_id, asset_id=asset.id, version_id=version.id,
        requested_by=current_user.id, status="queued", ranges=ranges, ranges_hash=ranges_hash,
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


@router.get("/assets/{asset_id}/clip-render-jobs/latest", response_model=LatestClipRenderJob)
def latest_clip_render_job(
    asset_id: uuid.UUID,
    version_id: uuid.UUID = Query(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = _asset_access(db, asset_id, current_user, write=True)
    _version(db, asset, version_id)
    comments = range_comments(db, asset.id, version_id)
    job = db.query(ClipRenderJob).filter(
        ClipRenderJob.project_id == asset.project_id,
        ClipRenderJob.asset_id == asset.id,
        ClipRenderJob.version_id == version_id,
        ClipRenderJob.deleted_at.is_(None),
    ).order_by(ClipRenderJob.created_at.desc(), ClipRenderJob.id.desc()).first()
    last_seen = db.query(func.max(ProjectAutomationToken.last_used_at)).filter(
        ProjectAutomationToken.project_id == asset.project_id,
        ProjectAutomationToken.revoked_at.is_(None),
        ProjectAutomationToken.deleted_at.is_(None),
    ).scalar()
    return {"job": job, "locked_count": sum(comment.locked_at is not None for comment in comments),
            "range_count": len(comments), "worker_last_seen_at": last_seen}


@router.post("/clip-render-jobs/{job_id}/cancel", response_model=ClipRenderJobResponse)
def cancel_clip_render_job(
    job_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    job = db.query(ClipRenderJob).filter(ClipRenderJob.id == job_id, ClipRenderJob.deleted_at.is_(None)).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    _asset_access(db, job.asset_id, current_user, write=True)
    changed = db.query(ClipRenderJob).filter(
        ClipRenderJob.id == job_id, ClipRenderJob.deleted_at.is_(None), ClipRenderJob.status == "queued",
    ).update({"status": "cancelled", "finished_at": datetime.now(timezone.utc)}, synchronize_session=False)
    if changed != 1:
        raise HTTPException(status_code=409, detail="Only a queued job can be cancelled")
    db.commit()
    db.refresh(job)
    return job
