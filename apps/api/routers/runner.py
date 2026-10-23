"""Mac clip runner API. Authenticated ONLY by a clip runner token."""
import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.clip_runner_auth import ClipRunnerActor, get_clip_runner_actor
from ..schemas.clip_render_job import (
    ClipRenderJobFinish,
    ClipRenderJobProgress,
    WorkerClipRenderClaim,
    WorkerClipRenderJob,
    WorkerClipRenderResult,
)
from ..services.clip_render_jobs import claim_runner_job, finish_runner_job, list_runner_jobs, report_runner_progress

router = APIRouter(prefix="/runner", tags=["runner"])


@router.get("/clip-render-jobs", response_model=list[WorkerClipRenderJob])
def list_clip_render_jobs(
    db: Session = Depends(get_db),
    actor: ClipRunnerActor = Depends(get_clip_runner_actor),
):
    return list_runner_jobs(db, actor.user)


@router.post("/clip-render-jobs/{job_id}/claim", response_model=WorkerClipRenderClaim)
def claim_clip_render_job(
    job_id: uuid.UUID,
    db: Session = Depends(get_db),
    actor: ClipRunnerActor = Depends(get_clip_runner_actor),
):
    return claim_runner_job(db, job_id, actor.user)


@router.post("/clip-render-jobs/{job_id}/progress", response_model=WorkerClipRenderResult)
def report_clip_render_progress(
    job_id: uuid.UUID,
    body: ClipRenderJobProgress,
    db: Session = Depends(get_db),
    actor: ClipRunnerActor = Depends(get_clip_runner_actor),
):
    return report_runner_progress(db, job_id, body, actor.user)


@router.post("/clip-render-jobs/{job_id}/finish", response_model=WorkerClipRenderResult)
def finish_clip_render_job(
    job_id: uuid.UUID,
    body: ClipRenderJobFinish,
    db: Session = Depends(get_db),
    actor: ClipRunnerActor = Depends(get_clip_runner_actor),
):
    return finish_runner_job(db, job_id, body, actor.user)
