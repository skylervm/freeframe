import hashlib
import json
import math
import re
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from ..models.asset import Asset, AssetVersion
from ..models.clip_render_job import ClipRenderJob
from ..models.clip_runner_token import ClipRunnerToken
from ..models.comment import Comment
from ..models.project import Project, ProjectRole
from ..models.user import User, UserStatus
from ..schemas.clip_render_job import ClipRenderJobFinish
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
    return [comment for comment in comments if clip_number(comment.body) is not None]


def clip_number(body: str) -> int | None:
    if not _CLIP_INSTRUCTION.match(body or ""):
        return None
    digits = re.match(r"^\s*clip\s+(\d+)", body, re.IGNORECASE).group(1).lstrip("0") or "0"
    if len(digits) > 3:
        return None
    number = int(digits)
    return number if 1 <= number <= 999 else None


def locked_snapshot(comments: list[Comment]) -> tuple[list[dict], str]:
    ranges = []
    for comment in comments:
        if comment.locked_at is None:
            continue
        number = clip_number(comment.body)
        start, end = float(comment.timecode_start), float(comment.timecode_end)
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
            raise HTTPException(status_code=409, detail={
                "code": "invalid_range",
                "message": f"Clip {number} must have finite timecodes with start >= 0 and end > start",
            })
        ranges.append({"comment_id": str(comment.id), "number": number, "start": start, "end": end})
    numbers = [item["number"] for item in ranges]
    for number in sorted(set(numbers)):
        if numbers.count(number) > 1:
            raise HTTPException(status_code=409, detail={
                "code": "duplicate_clip_number",
                "message": f"Clip {number} is used by more than one locked range",
            })
    ranges.sort(key=lambda item: (item["number"], item["comment_id"]))
    canonical = json.dumps(ranges, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return ranges, hashlib.sha256(canonical.encode()).hexdigest()


# ── Mac clip runner ────────────────────────────────────────────────────────────
# The runner token is instance-wide, so every runner query is scoped by the
# token creator's CURRENT effective role on each job's project.

RUNNER_ROLES = (ProjectRole.owner, ProjectRole.editor)
RUNNER_LIST_LIMIT = 50
# Rows read per page, and the page cap, bound the work of one list request.
RUNNER_CANDIDATE_LIMIT = 500
RUNNER_MAX_PAGES = 20
RUNNER_LAST_SEEN_TOKEN_LIMIT = 50


def can_run_project_jobs(db: Session, project_id: uuid.UUID, user: User) -> bool:
    return get_effective_project_role(db, project_id, user) in RUNNER_ROLES


def _live_jobs(db: Session):
    """Jobs whose project, asset and version all still exist and are not deleted."""
    return db.query(ClipRenderJob).filter(
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

    Pages by (created_at, id) and excludes projects already found to be denied,
    so jobs in projects the creator cannot edit cannot hide newer runnable work.
    Each distinct project is role-checked once, never per row.
    """
    now = datetime.now(timezone.utc)
    allowed: set[uuid.UUID] = set()
    denied: set[uuid.UUID] = set()
    visible: list[ClipRenderJob] = []
    visible_ids: set[uuid.UUID] = set()
    cursor: tuple[datetime, uuid.UUID] | None = None
    for _ in range(RUNNER_MAX_PAGES):
        query = _live_jobs(db).filter(claimable_jobs(now))
        if denied:
            query = query.filter(ClipRenderJob.project_id.not_in(list(denied)))
        if cursor:
            created_at, job_id = cursor
            query = query.filter(or_(
                ClipRenderJob.created_at > created_at,
                and_(ClipRenderJob.created_at == created_at, ClipRenderJob.id > job_id),
            ))
        page = query.order_by(ClipRenderJob.created_at, ClipRenderJob.id).limit(RUNNER_CANDIDATE_LIMIT).all()
        for job in page:
            if job.project_id not in allowed and job.project_id not in denied:
                (allowed if can_run_project_jobs(db, job.project_id, user) else denied).add(job.project_id)
            if job.project_id in allowed and job.id not in visible_ids:
                visible_ids.add(job.id)
                visible.append(job)
                if len(visible) >= RUNNER_LIST_LIMIT:
                    return visible
        if len(page) < RUNNER_CANDIDATE_LIMIT:
            break
        cursor = (page[-1].created_at, page[-1].id)
    return visible


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
    ).update({"status": "claimed", "claimed_at": now, "claim_id": uuid.uuid4()}, synchronize_session=False)
    if changed != 1:
        raise HTTPException(status_code=409, detail="Job is already claimed or finished")
    db.commit()
    db.refresh(job)
    version = db.query(AssetVersion).filter(AssetVersion.id == job.version_id).first()
    if not version:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"id": job.id, "asset_id": job.asset_id, "version_id": job.version_id, "ranges": job.ranges,
            "created_at": job.created_at, "claim_id": job.claim_id, "processing_status": version.processing_status}


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
    """Newest use of a live runner token whose creator can run this project's jobs."""
    now = datetime.now(timezone.utc)
    tokens = db.query(ClipRunnerToken).filter(
        ClipRunnerToken.revoked_at.is_(None),
        ClipRunnerToken.expires_at > now,
        ClipRunnerToken.last_used_at.is_not(None),
    ).order_by(ClipRunnerToken.last_used_at.desc()).limit(RUNNER_LAST_SEEN_TOKEN_LIMIT).all()
    allowed: dict[uuid.UUID, bool] = {}
    for token in tokens:
        if token.created_by not in allowed:
            # Same creator rules as runner authentication: a token that cannot
            # authenticate is not a working runner.
            creator = db.query(User).filter(
                User.id == token.created_by,
                User.deleted_at.is_(None),
                User.status == UserStatus.active,
                User.is_superadmin.is_(True),
            ).first()
            allowed[token.created_by] = bool(creator) and can_run_project_jobs(db, project_id, creator)
        if allowed[token.created_by]:
            return token.last_used_at
    return None
