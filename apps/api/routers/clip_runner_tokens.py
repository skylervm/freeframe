"""Superadmin management of Mac clip runner tokens (session auth only)."""
import logging
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_current_user
from ..middleware.clip_runner_auth import CLIP_RUNNER_TOKEN_PREFIX, hash_clip_runner_secret
from ..middleware.rate_limit import rate_limit
from ..models.clip_runner_token import ClipRunnerToken
from ..models.user import User
from ..schemas.clip_runner_token import ClipRunnerTokenCreate, ClipRunnerTokenCreated, ClipRunnerTokenResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/clip-runner-tokens", tags=["clip-runner-tokens"])

MAX_CLIP_RUNNER_TOKEN_LIFETIME = timedelta(days=366)


def _require_superadmin(user: User) -> None:
    if user.is_superadmin is not True:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only admins can manage clip runner tokens")


@router.post(
    "",
    response_model=ClipRunnerTokenCreated,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(rate_limit("clip_runner_token_create", 10, 3600))],
)
def create_clip_runner_token(
    body: ClipRunnerTokenCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_superadmin(current_user)
    if body.expires_at.tzinfo is None or body.expires_at.utcoffset() is None:
        raise HTTPException(status_code=400, detail="Token expiry must include a timezone")
    now = datetime.now(timezone.utc)
    if body.expires_at <= now:
        raise HTTPException(status_code=400, detail="Token expiry must be in the future")
    if body.expires_at > now + MAX_CLIP_RUNNER_TOKEN_LIFETIME:
        raise HTTPException(status_code=400, detail="Token expiry must be at most 366 days away")
    token_id = uuid.uuid4()
    secret = secrets.token_urlsafe(32)
    token = ClipRunnerToken(
        id=token_id,
        name=body.name,
        secret_hash=hash_clip_runner_secret(secret),
        created_by=current_user.id,
        expires_at=body.expires_at,
    )
    db.add(token)
    db.commit()
    db.refresh(token)
    logger.info("clip runner token created token_id=%s user_id=%s", token.id, current_user.id)
    return ClipRunnerTokenCreated(
        id=token.id,
        name=token.name,
        created_at=token.created_at,
        expires_at=token.expires_at,
        token=f"{CLIP_RUNNER_TOKEN_PREFIX}_{token_id}_{secret}",
    )


@router.get("", response_model=list[ClipRunnerTokenResponse])
def list_clip_runner_tokens(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_superadmin(current_user)
    return db.query(ClipRunnerToken).filter(
        ClipRunnerToken.created_by == current_user.id,
    ).order_by(ClipRunnerToken.created_at.desc()).all()


@router.delete("/{token_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_clip_runner_token(
    token_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_superadmin(current_user)
    token = db.query(ClipRunnerToken).filter(
        ClipRunnerToken.id == token_id,
        ClipRunnerToken.created_by == current_user.id,
    ).first()
    if not token:
        raise HTTPException(status_code=404, detail="Clip runner token not found")
    if token.revoked_at is None:
        token.revoked_at = datetime.now(timezone.utc)
        db.commit()
        logger.info("clip runner token revoked token_id=%s user_id=%s", token.id, current_user.id)
