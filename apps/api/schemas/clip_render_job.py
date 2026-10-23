import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ..models.asset import ProcessingStatus


class ClipRenderJobCreate(BaseModel):
    version_id: uuid.UUID


class ClipRenderRange(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    comment_id: uuid.UUID
    number: int = Field(ge=1, le=999)
    start: float = Field(ge=0)
    end: float

    @model_validator(mode="after")
    def validate_end(self):
        if self.end <= self.start:
            raise ValueError("end must be greater than start")
        return self


class WorkerClipRenderJob(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    asset_id: uuid.UUID
    version_id: uuid.UUID
    ranges: list[ClipRenderRange]
    created_at: datetime


class WorkerClipRenderClaim(WorkerClipRenderJob):
    claim_id: uuid.UUID
    processing_status: ProcessingStatus


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
    claim_id: uuid.UUID
    status: Literal["done", "failed"]
    clips_rendered: int = Field(ge=0, le=999, strict=True)
    message: str

    @field_validator("message")
    @classmethod
    def truncate_message(cls, value: str) -> str:
        return value[:300]


class ClipRenderJobProgress(BaseModel):
    claim_id: uuid.UUID
    clips_rendered: int = Field(ge=0, le=999, strict=True)


class WorkerClipRenderResult(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    clips_rendered: int
