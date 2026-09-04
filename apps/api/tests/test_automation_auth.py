import hashlib
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from apps.api.middleware.automation_auth import get_automation_actor
from apps.api.models.project import ProjectRole


def _token(token_id, secret):
    token = MagicMock()
    token.id = token_id
    token.project_id = uuid.uuid4()
    token.created_by = uuid.uuid4()
    token.secret_hash = hashlib.sha256(secret.encode()).hexdigest()
    token.deleted_at = None
    token.revoked_at = None
    token.expires_at = None
    token.last_used_at = None
    return token


def _db_for(token, user_deleted_at=None, member_role=ProjectRole.owner):
    db = MagicMock()
    db.query.return_value = db
    db.filter.return_value = db
    project = MagicMock()
    user = MagicMock()
    user.deleted_at = user_deleted_at
    user.status.value = "active"
    member = MagicMock()
    member.role = member_role
    db.first.side_effect = [token, project, user, member]
    return db, user


def test_automation_token_accepts_only_its_exact_secret():
    token_id = uuid.uuid4()
    token = _token(token_id, "correct-secret")
    db, user = _db_for(token)

    actor = get_automation_actor(f"Bearer ffat_{token_id}_correct-secret", db)

    assert actor.token_id == token_id
    assert actor.project_id == token.project_id
    assert actor.user is user


@pytest.mark.parametrize("authorization", ["Bearer jwt", "Bearer ffat_not-a-uuid_secret", "Bearer ffat_x_wrong-secret"])
def test_bad_automation_token_is_unauthorized(authorization):
    with pytest.raises(HTTPException) as error:
        get_automation_actor(authorization, MagicMock())
    assert error.value.status_code == 401


def test_deleted_token_owner_is_unauthorized():
    token_id = uuid.uuid4()
    token = _token(token_id, "secret")
    db, _ = _db_for(token, user_deleted_at=datetime.now(timezone.utc))

    with pytest.raises(HTTPException) as error:
        get_automation_actor(f"Bearer ffat_{token_id}_secret", db)
    assert error.value.status_code == 401


def test_removed_token_creator_is_unauthorized():
    token_id = uuid.uuid4()
    token = _token(token_id, "secret")
    db, _ = _db_for(token)
    db.first.side_effect = [token, MagicMock(), MagicMock(), None]

    with pytest.raises(HTTPException) as error:
        get_automation_actor(f"Bearer ffat_{token_id}_secret", db)

    assert error.value.status_code == 401


def test_expired_token_is_unauthorized():
    token_id = uuid.uuid4()
    token = _token(token_id, "secret")
    token.expires_at = datetime(2020, 1, 1, tzinfo=timezone.utc)
    db, _ = _db_for(token)

    with pytest.raises(HTTPException) as error:
        get_automation_actor(f"Bearer ffat_{token_id}_secret", db)

    assert error.value.status_code == 401
