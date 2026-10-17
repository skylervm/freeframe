"""Authentication for the Mac clip runner.

A clip runner token (`ffcr_<uuid>_<secret>`) is accepted ONLY by the
`/runner/clip-render-jobs` endpoints. No other dependency recognises the
`ffcr` prefix, and this dependency rejects every other token class.
"""
import hashlib
import hmac
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.clip_runner_token import ClipRunnerToken
from ..models.user import User, UserStatus

CLIP_RUNNER_TOKEN_PREFIX = "ffcr"
# Compared against when no token row matches, so a missing id costs the same
# hash-and-compare work as a wrong secret.
_DUMMY_HASH = hashlib.sha256(b"clip-runner-token-not-found").hexdigest()


@dataclass(frozen=True)
class ClipRunnerActor:
    token_id: uuid.UUID
    user: User


def hash_clip_runner_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def _unauthorized() -> HTTPException:
    return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid clip runner token")


def _parse(authorization: str | None) -> tuple[uuid.UUID, str]:
    if not authorization or not authorization.startswith("Bearer "):
        raise _unauthorized()
    raw_token = authorization.removeprefix("Bearer ").strip()
    prefix, separator, remainder = raw_token.partition("_")
    if prefix != CLIP_RUNNER_TOKEN_PREFIX or not separator:
        raise _unauthorized()
    token_id_text, separator, secret = remainder.partition("_")
    if not separator or not secret:
        raise _unauthorized()
    try:
        return uuid.UUID(token_id_text), secret
    except ValueError as exc:
        raise _unauthorized() from exc


def get_clip_runner_actor(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> ClipRunnerActor:
    token_id, secret = _parse(authorization)
    now = datetime.now(timezone.utc)
    token = db.query(ClipRunnerToken).filter(
        ClipRunnerToken.id == token_id,
        ClipRunnerToken.revoked_at.is_(None),
        ClipRunnerToken.expires_at > now,
    ).first()
    secret_matches = hmac.compare_digest(token.secret_hash if token else _DUMMY_HASH, hash_clip_runner_secret(secret))
    if not token or not secret_matches:
        raise _unauthorized()
    user = db.query(User).filter(User.id == token.created_by, User.deleted_at.is_(None)).first()
    if not user or user.deleted_at is not None or user.status != UserStatus.active or user.is_superadmin is not True:
        raise _unauthorized()
    if not token.last_used_at or (now - token.last_used_at).total_seconds() >= 60:
        token.last_used_at = now
        db.commit()
    return ClipRunnerActor(token_id=token.id, user=user)
