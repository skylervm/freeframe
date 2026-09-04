import uuid
from datetime import datetime

from pydantic import BaseModel, Field, field_validator


class AutomationTokenCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    expires_at: datetime

    @field_validator("expires_at")
    @classmethod
    def expiry_requires_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("expires_at must include a timezone")
        return value


class AutomationTokenResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    created_at: datetime
    last_used_at: datetime | None
    expires_at: datetime | None
    revoked_at: datetime | None
    model_config = {"from_attributes": True}


class AutomationTokenCreated(AutomationTokenResponse):
    token: str
