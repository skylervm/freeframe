"""Authentication for the deliberately narrow terminal bootstrap endpoint."""
from __future__ import annotations

import hashlib
import hmac
import re
import uuid
from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..models.user import User, UserStatus


@dataclass(frozen=True)
class BootstrapActor:
    user: User


def _unauthorized() -> HTTPException:
    return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid bootstrap credential")


def get_bootstrap_actor(
    credential: str | None = Header(default=None, alias="X-FreeFrame-Bootstrap"),
    db: Session = Depends(get_db),
) -> BootstrapActor:
    configured_hash = settings.automation_bootstrap_token_sha256
    configured_owner = settings.automation_bootstrap_owner_id
    if not configured_hash or not configured_owner or not re.fullmatch(r"[0-9a-f]{64}", configured_hash):
        raise _unauthorized()
    try:
        owner_id = uuid.UUID(configured_owner)
    except ValueError as exc:
        raise _unauthorized() from exc
    if not credential or not hmac.compare_digest(hashlib.sha256(credential.encode()).hexdigest(), configured_hash):
        raise _unauthorized()
    user = db.query(User).filter(User.id == owner_id, User.deleted_at.is_(None)).first()
    if not user or user.status != UserStatus.active:
        raise _unauthorized()
    return BootstrapActor(user=user)
