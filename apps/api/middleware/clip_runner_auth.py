"""Authentication for the Mac clip runner.

A clip runner token (`ffcr_<uuid>_<secret>`) is accepted ONLY by the
`/runner/clip-render-jobs` endpoints. No other dependency recognises the
`ffcr` prefix, and this dependency rejects every other token class.
"""
import hashlib
import hmac
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.clip_runner_token import ClipRunnerToken
from ..models.user import User, UserStatus

CLIP_RUNNER_TOKEN_PREFIX = "ffcr"
# Compared against when no token row matches, so a missing id costs the same
# hash-and-compare work as a wrong secret.
_DUMMY_HASH = hashlib.sha256(b"clip-runner-token-not-found").hexdigest()
# Looked up when no token row matches, so every failure runs the creator query.
_DUMMY_USER_ID = uuid.UUID(int=0)
LAST_USED_INTERVAL = timedelta(seconds=60)


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
    # Every well-formed credential does the same work whatever is wrong with it:
    # one token lookup, one constant-time compare, one creator lookup. All
    # conditions are then judged together, so timing does not reveal which failed.
    token = db.query(ClipRunnerToken).filter(ClipRunnerToken.id == token_id).first()
    secret_matches = hmac.compare_digest(token.secret_hash if token else _DUMMY_HASH, hash_clip_runner_secret(secret))
    user = db.query(User).filter(
        User.id == (token.created_by if token else _DUMMY_USER_ID),
        User.deleted_at.is_(None),
    ).first()
    checks = [
        token is not None,
        secret_matches,
        token is not None and token.revoked_at is None,
        token is not None and token.expires_at > now,
        user is not None,
        user is not None and user.deleted_at is None,
        user is not None and user.status == UserStatus.active,
        user is not None and user.is_superadmin is True,
    ]
    if not all(checks):
        raise _unauthorized()
    # Atomic once-per-minute throttle: only a stale or empty timestamp is written.
    changed = db.query(ClipRunnerToken).filter(
        ClipRunnerToken.id == token.id,
        or_(ClipRunnerToken.last_used_at.is_(None), ClipRunnerToken.last_used_at < now - LAST_USED_INTERVAL),
    ).update({"last_used_at": now}, synchronize_session=False)
    if changed:
        db.commit()
    return ClipRunnerActor(token_id=token.id, user=user)
