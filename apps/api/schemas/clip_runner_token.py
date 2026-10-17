import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ClipRunnerTokenCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    # Timezone, future and maximum lifetime are checked in the handler so every
    # expiry problem is the same HTTP 400.
    expires_at: datetime


class ClipRunnerTokenResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    created_at: datetime
    last_used_at: datetime | None
    expires_at: datetime
    revoked_at: datetime | None


class ClipRunnerTokenCreated(BaseModel):
    id: uuid.UUID
    name: str
    created_at: datetime
    expires_at: datetime
    token: str
