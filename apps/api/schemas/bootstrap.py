from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class BootstrapProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=2000)
    token_id: uuid.UUID
    token_secret_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


class BootstrapProjectResponse(BaseModel):
    project_id: uuid.UUID
    project_name: str
    token_id: uuid.UUID
    token_expires_at: datetime


class BootstrapTokenRenewal(BaseModel):
    token_secret_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
