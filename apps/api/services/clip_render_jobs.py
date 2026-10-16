import hashlib
import json
import math
import re
from datetime import datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from ..models.clip_render_job import ClipRenderJob
from ..models.comment import Comment


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
    ranges.sort(key=lambda item: (item["number"], item["comment_id"]))
    canonical = json.dumps(ranges, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return ranges, hashlib.sha256(canonical.encode()).hexdigest()
