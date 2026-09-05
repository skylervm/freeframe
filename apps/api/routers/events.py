from fastapi import APIRouter, Depends, Query, HTTPException, Request, status
from fastapi.responses import StreamingResponse
import asyncio
import uuid
from typing import Optional
from sqlalchemy.orm import Session
from ..database import SessionLocal, get_db
from ..middleware.auth import get_current_user, get_optional_user
from ..services.auth_service import decode_token, get_user_by_id
from ..models.user import User, UserStatus
from ..services.event_service import event_stream
from ..services.permissions import get_effective_project_role

router = APIRouter(prefix="/events", tags=["events"])

@router.get("/{project_id}")
async def stream_events(
    project_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    token: Optional[str] = Query(None),
    current_user: Optional[User] = Depends(get_optional_user),
):
    # EventSource can't send Authorization headers, so accept token as query param
    user = current_user
    if not user and token:
        payload = decode_token(token)
        if payload and payload.get("type") == "access":
            user = get_user_by_id(db, uuid.UUID(payload["sub"]))
    if not user or user.status == UserStatus.deactivated:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not authenticated")

    # Verify user has access to this project
    if not get_effective_project_role(db, project_id, user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a project member")

    async def still_authorized() -> bool:
        def check() -> bool:
            stream_db = SessionLocal()
            try:
                active_user = stream_db.query(User).filter(
                    User.id == user.id,
                    User.deleted_at.is_(None),
                    User.status != UserStatus.deactivated,
                ).first()
                return bool(active_user and get_effective_project_role(stream_db, project_id, active_user))
            finally:
                stream_db.close()
        return await asyncio.to_thread(check)

    return StreamingResponse(
        event_stream(
            str(project_id),
            is_authorized=still_authorized,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
