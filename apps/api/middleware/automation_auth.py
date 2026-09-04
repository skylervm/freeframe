import hashlib
import hmac
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.automation_token import ProjectAutomationToken
from ..models.project import Project, ProjectMember, ProjectRole
from ..models.user import User, UserStatus


@dataclass(frozen=True)
class AutomationActor:
    token_id: uuid.UUID
    project_id: uuid.UUID
    user: User


def _unauthorized() -> HTTPException:
    return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid automation token")


def get_automation_actor(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> AutomationActor:
    if not authorization or not authorization.startswith("Bearer "):
        raise _unauthorized()
    raw_token = authorization[7:]
    prefix, separator, remainder = raw_token.partition("_")
    if prefix != "ffat" or not separator:
        raise _unauthorized()
    token_id_text, separator, secret = remainder.partition("_")
    if not separator or not secret:
        raise _unauthorized()
    try:
        token_id = uuid.UUID(token_id_text)
    except ValueError as exc:
        raise _unauthorized() from exc

    token = db.query(ProjectAutomationToken).filter(
        ProjectAutomationToken.id == token_id,
        ProjectAutomationToken.deleted_at.is_(None),
        ProjectAutomationToken.revoked_at.is_(None),
    ).first()
    if not token or not hmac.compare_digest(token.secret_hash, hashlib.sha256(secret.encode()).hexdigest()):
        raise _unauthorized()
    now = datetime.now(timezone.utc)
    if token.expires_at and token.expires_at <= now:
        raise _unauthorized()
    project = db.query(Project).filter(Project.id == token.project_id, Project.deleted_at.is_(None)).first()
    if not project:
        raise _unauthorized()
    user = db.query(User).filter(User.id == token.created_by, User.deleted_at.is_(None)).first()
    if not user or user.deleted_at is not None or user.status != UserStatus.active:
        raise _unauthorized()
    member = db.query(ProjectMember).filter(
        ProjectMember.project_id == token.project_id,
        ProjectMember.user_id == user.id,
        ProjectMember.deleted_at.is_(None),
    ).first()
    if not member or member.role not in (ProjectRole.owner, ProjectRole.editor):
        raise _unauthorized()
    # Keep a useful audit trail without writing once per multipart part.
    if not token.last_used_at or (now - token.last_used_at).total_seconds() >= 60:
        token.last_used_at = now
        db.commit()
    return AutomationActor(token_id=token.id, project_id=token.project_id, user=user)
