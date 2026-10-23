import hashlib
import json
import math
import re
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from ..models.asset import Asset, AssetVersion
from ..models.clip_render_job import ClipRenderJob
from ..models.clip_runner_token import ClipRunnerToken
from ..models.comment import Comment
from ..models.project import Project, ProjectRole
from ..models.user import User, UserStatus
from ..schemas.clip_render_job import ClipRenderJobFinish, ClipRenderJobProgress
from .permissions import get_effective_project_role


_CLIP_INSTRUCTION = re.compile(
    r"^\s*clip\s+[0-9]+\s*(?::\s*(?:start|end)(?:\s+here)?)?\s*$", re.IGNORECASE
)

CLIP_RENDER_LEASE = timedelta(minutes=90)


def claimable_jobs(now: datetime):
    return or_(
        ClipRenderJob.status == "queued",
        and_(ClipRenderJob.status == "claimed", ClipRenderJob.claimed_at <= now - CLIP_RENDER_LEASE),
    )


def range_comments(db: Session, asset_id, version_id) -> list[Comment]:
    comments = db.query(Comment).filter(
        Comment.asset_id == asset_id,
        Comment.version_id == version_id,
        Comment.parent_id.is_(None),
        Comment.deleted_at.is_(None),
        Comment.resolved.is_(False),
        Comment.timecode_start.is_not(None),
        Comment.timecode_end.is_not(None),
    ).all()
    return comments


def locked_snapshot(comments: list[Comment]) -> tuple[list[dict], str]:
    """Locked ranges in start order, numbered 1..N. The comment text never sets the number."""
    locked = []
    for comment in comments:
        if comment.locked_at is None:
            continue
        start, end = float(comment.timecode_start), float(comment.timecode_end)
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
            raise HTTPException(status_code=409, detail={
                "code": "invalid_range",
                "message": "A locked range must have finite timecodes with start >= 0 and end > start",
            })
        locked.append((start, end, str(comment.id)))
    locked.sort()
    ranges = [{"comment_id": comment_id, "number": number, "start": start, "end": end}
              for number, (start, end, comment_id) in enumerate(locked, start=1)]
    canonical = json.dumps(ranges, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return ranges, hashlib.sha256(canonical.encode()).hexdigest()


# ── Mac clip runner ────────────────────────────────────────────────────────────
# The runner token is instance-wide, so every runner query is scoped by the
# token creator's CURRENT effective role on each job's project.

RUNNER_ROLES = (ProjectRole.owner, ProjectRole.editor)
RUNNER_LIST_LIMIT = 50
# Distinct projects with claimable jobs that one list request role-checks.
RUNNER_PROJECT_SCAN_LIMIT = 2000
# Distinct token creators one last-seen lookup checks.
RUNNER_LAST_SEEN_CREATOR_LIMIT = 100


def can_run_project_jobs(db: Session, project_id: uuid.UUID, user: User) -> bool:
    return get_effective_project_role(db, project_id, user) in RUNNER_ROLES


def _live_jobs(db: Session):
    """Jobs whose project, asset and version all still exist and are not deleted."""
    return db.query(ClipRenderJob).filter(*_live_job_conditions())


def _live_job_conditions() -> tuple:
    return (
        ClipRenderJob.deleted_at.is_(None),
        select(Project.id).where(
            Project.id == ClipRenderJob.project_id,
            Project.deleted_at.is_(None),
        ).exists(),
        select(Asset.id).where(
            Asset.id == ClipRenderJob.asset_id,
            Asset.project_id == ClipRenderJob.project_id,
            Asset.deleted_at.is_(None),
        ).exists(),
        select(AssetVersion.id).where(
            AssetVersion.id == ClipRenderJob.version_id,
            AssetVersion.asset_id == ClipRenderJob.asset_id,
            AssetVersion.deleted_at.is_(None),
        ).exists(),
    )


def list_runner_jobs(db: Session, user: User) -> list[ClipRenderJob]:
    """Oldest-first claimable jobs the creator can run, at most RUNNER_LIST_LIMIT.

    Scans PROJECTS, not jobs: any number of jobs in a project the creator cannot
    edit costs one role check and cannot hide newer runnable work.
    """
    now = datetime.now(timezone.utc)
    oldest = func.min(ClipRenderJob.created_at)
    projects = db.query(ClipRenderJob.project_id, oldest).filter(
        *_live_job_conditions(), claimable_jobs(now),
    ).group_by(ClipRenderJob.project_id).order_by(oldest, ClipRenderJob.project_id).limit(RUNNER_PROJECT_SCAN_LIMIT).all()
    allowed = [project_id for project_id, _ in projects if can_run_project_jobs(db, project_id, user)]
    if not allowed:
        return []
    return _live_jobs(db).filter(
        claimable_jobs(now), ClipRenderJob.project_id.in_(allowed),
    ).order_by(ClipRenderJob.created_at, ClipRenderJob.id).limit(RUNNER_LIST_LIMIT).all()


def _runner_job(db: Session, job_id: uuid.UUID, user: User) -> ClipRenderJob:
    job = _live_jobs(db).filter(ClipRenderJob.id == job_id).first()
    # A job the creator cannot edit is indistinguishable from a missing job.
    if not job or not can_run_project_jobs(db, job.project_id, user):
        raise HTTPException(status_code=404, detail="Job not found")
    return job


def claim_runner_job(db: Session, job_id: uuid.UUID, user: User) -> dict:
    job = _runner_job(db, job_id, user)
    now = datetime.now(timezone.utc)
    changed = _live_jobs(db).filter(
        ClipRenderJob.id == job_id,
        ClipRenderJob.project_id == job.project_id,
        claimable_jobs(now),
    ).update({"status": "claimed", "claimed_at": now, "claim_id": uuid.uuid4(), "clips_rendered": None},
             synchronize_session=False)
    if changed != 1:
        raise HTTPException(status_code=409, detail="Job is already claimed or finished")
    db.commit()
    db.refresh(job)
    version = db.query(AssetVersion).filter(AssetVersion.id == job.version_id).first()
    if not version:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"id": job.id, "asset_id": job.asset_id, "version_id": job.version_id, "ranges": job.ranges,
            "created_at": job.created_at, "claim_id": job.claim_id, "processing_status": version.processing_status}


def report_runner_progress(db: Session, job_id: uuid.UUID, body: ClipRenderJobProgress, user: User) -> ClipRenderJob:
    job = _runner_job(db, job_id, user)
    if job.status != "claimed" or job.claim_id != body.claim_id:
        raise HTTPException(status_code=409, detail="Only a claimed job can report progress")
    count = len(job.ranges)
    if body.clips_rendered > count:
        raise HTTPException(status_code=422, detail={"code": "invalid_clip_count", "message": f"Clip count cannot exceed {count}"})
    # Counts only go up, so a retried or out-of-order report cannot move the bar backwards.
    _live_jobs(db).filter(
        ClipRenderJob.id == job_id,
        ClipRenderJob.project_id == job.project_id,
        ClipRenderJob.status == "claimed",
        ClipRenderJob.claim_id == body.claim_id,
        or_(ClipRenderJob.clips_rendered.is_(None), ClipRenderJob.clips_rendered < body.clips_rendered),
    ).update({"clips_rendered": body.clips_rendered}, synchronize_session=False)
    db.commit()
    # An unchanged count is fine. A job that finished, was re-claimed or lost its media
    # meanwhile is not, and refresh() would not notice the deleted media.
    current = _live_jobs(db).filter(
        ClipRenderJob.id == job_id,
        ClipRenderJob.status == "claimed",
        ClipRenderJob.claim_id == body.claim_id,
    ).first()
    if current is None or current.clips_rendered is None:
        raise HTTPException(status_code=409, detail="Only a claimed job can report progress")
    return current


def finish_runner_job(db: Session, job_id: uuid.UUID, body: ClipRenderJobFinish, user: User) -> ClipRenderJob:
    job = _runner_job(db, job_id, user)
    if job.status != "claimed" or job.claim_id != body.claim_id:
        raise HTTPException(status_code=409, detail="Only a claimed job can finish")
    count = len(job.ranges)
    if body.status == "done" and body.clips_rendered != count:
        raise HTTPException(status_code=422, detail={"code": "incomplete_render", "message": f"A done job must render all {count} clips"})
    if body.clips_rendered > count:
        raise HTTPException(status_code=422, detail={"code": "invalid_clip_count", "message": f"Clip count cannot exceed {count}"})
    changed = _live_jobs(db).filter(
        ClipRenderJob.id == job_id,
        ClipRenderJob.project_id == job.project_id,
        ClipRenderJob.status == "claimed",
        ClipRenderJob.claim_id == body.claim_id,
    ).update({"status": body.status, "clips_rendered": body.clips_rendered,
              "message": body.message, "finished_at": datetime.now(timezone.utc)}, synchronize_session=False)
    if changed != 1:
        raise HTTPException(status_code=409, detail="Only a claimed job can finish")
    db.commit()
    db.refresh(job)
    return job


def runner_last_seen_at(db: Session, project_id: uuid.UUID) -> datetime | None:
    """Newest use of a live runner token whose creator can run this project's jobs.

    Groups by creator BEFORE checking eligibility, so many newer tokens of an
    ineligible creator cannot hide an eligible one.
    """
    now = datetime.now(timezone.utc)
    newest_use = func.max(ClipRunnerToken.last_used_at)
    creators = db.query(ClipRunnerToken.created_by, newest_use).filter(
        ClipRunnerToken.revoked_at.is_(None),
        ClipRunnerToken.expires_at > now,
        ClipRunnerToken.last_used_at.is_not(None),
    ).group_by(ClipRunnerToken.created_by).order_by(newest_use.desc(), ClipRunnerToken.created_by).limit(
        RUNNER_LAST_SEEN_CREATOR_LIMIT).all()
    seen = None
    for creator_id, last_used_at in creators:
        # Same creator rules as runner authentication: a token that cannot
        # authenticate is not a working runner.
        creator = db.query(User).filter(
            User.id == creator_id,
            User.deleted_at.is_(None),
            User.status == UserStatus.active,
            User.is_superadmin.is_(True),
        ).first()
        if creator and can_run_project_jobs(db, project_id, creator) and (seen is None or last_used_at > seen):
            seen = last_used_at
    return seen
