import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ClipRenderJobCreate(BaseModel):
    version_id: uuid.UUID


class ClipRenderRange(BaseModel):
    comment_id: uuid.UUID
    number: int = Field(ge=1, le=999)
    start: float
    end: float


class WorkerClipRenderJob(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    asset_id: uuid.UUID
    version_id: uuid.UUID
    ranges: list[ClipRenderRange]
    created_at: datetime


class ClipRenderJobResponse(WorkerClipRenderJob):
    project_id: uuid.UUID
    requested_by: uuid.UUID
    status: Literal["queued", "claimed", "done", "failed", "cancelled"]
    ranges_hash: str
    clips_rendered: int | None
    message: str | None
    claimed_at: datetime | None
    finished_at: datetime | None


class LatestClipRenderJob(BaseModel):
    job: ClipRenderJobResponse | None
    locked_count: int
    range_count: int
    worker_last_seen_at: datetime | None


class ClipRenderJobFinish(BaseModel):
    status: Literal["done", "failed"]
    clips_rendered: int = Field(ge=0, strict=True)
    message: str

    @field_validator("message")
    @classmethod
    def truncate_message(cls, value: str) -> str:
        return value[:300]


class WorkerClipRenderResult(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    status: Literal["done", "failed"]
    clips_rendered: int
