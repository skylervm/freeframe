import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from apps.api.routers import comments as comments_module
from apps.api.schemas.comment import CommentUpdate

APPROVED = datetime(2026, 10, 1, tzinfo=timezone.utc)


def _comment(author_id, *, start=10.0, end=20.0, parent_id=None, locked_at=None):
    return MagicMock(
        id=uuid.uuid4(), author_id=author_id, asset_id=uuid.uuid4(), parent_id=parent_id,
        timecode_start=start, timecode_end=end, body="Clip 1", deleted_at=None, locked_at=locked_at,
    )


def _patch(monkeypatch, comment, *, user_id, project_owner):
    """Run update_comment against a mock db: the first query is the comment, the second the owner check."""
    db = MagicMock()
    db.query.return_value = db
    db.filter.return_value = db
    db.first.side_effect = [comment, MagicMock() if project_owner else None]
    monkeypatch.setattr(comments_module, "_get_asset", lambda _db, _id: MagicMock(project_id=uuid.uuid4()))
    monkeypatch.setattr(comments_module, "require_comment_access", lambda *_a, **_k: None)
    monkeypatch.setattr(comments_module, "_build_comment_response", lambda *_a, **_k: "ok")
    user = MagicMock(id=user_id)

    def call(update):
        return comments_module.update_comment(comment.id, update, db, user)

    return call, db


def test_author_can_lock_their_range_without_changing_it(monkeypatch):
    author = uuid.uuid4()
    comment = _comment(author)
    call, db = _patch(monkeypatch, comment, user_id=author, project_owner=False)

    call(CommentUpdate(locked=True))

    assert isinstance(comment.locked_at, datetime)
    assert (comment.timecode_start, comment.timecode_end, comment.body) == (10.0, 20.0, "Clip 1")
    db.commit.assert_called_once()


def test_project_owner_can_lock_and_unlock_someone_elses_range(monkeypatch):
    comment = _comment(uuid.uuid4())
    call, _ = _patch(monkeypatch, comment, user_id=uuid.uuid4(), project_owner=True)
    call(CommentUpdate(locked=True))
    assert comment.locked_at is not None

    call, _ = _patch(monkeypatch, comment, user_id=uuid.uuid4(), project_owner=True)
    call(CommentUpdate(locked=False))
    assert comment.locked_at is None


@pytest.mark.parametrize("locked", [True, False])
def test_other_member_cannot_lock_or_unlock(monkeypatch, locked):
    comment = _comment(uuid.uuid4(), locked_at=None if locked else APPROVED)
    call, db = _patch(monkeypatch, comment, user_id=uuid.uuid4(), project_owner=False)

    with pytest.raises(HTTPException) as error:
        call(CommentUpdate(locked=locked))

    assert error.value.status_code == 403
    assert comment.locked_at == (None if locked else APPROVED)
    db.commit.assert_not_called()


def test_locking_again_keeps_the_first_approval_time(monkeypatch):
    author = uuid.uuid4()
    comment = _comment(author, locked_at=APPROVED)
    call, _ = _patch(monkeypatch, comment, user_id=author, project_owner=False)

    call(CommentUpdate(locked=True))

    assert comment.locked_at == APPROVED


def test_unlocking_an_unlocked_range_is_a_no_op(monkeypatch):
    author = uuid.uuid4()
    comment = _comment(author)
    call, _ = _patch(monkeypatch, comment, user_id=author, project_owner=False)

    call(CommentUpdate(locked=False))

    assert comment.locked_at is None


def test_a_locked_range_cannot_be_moved(monkeypatch):
    author = uuid.uuid4()
    comment = _comment(author, locked_at=APPROVED)
    call, db = _patch(monkeypatch, comment, user_id=author, project_owner=False)

    with pytest.raises(HTTPException) as error:
        call(CommentUpdate(timecode_start=1.0, timecode_end=2.0))

    assert error.value.status_code == 409
    assert (comment.timecode_start, comment.timecode_end) == (10.0, 20.0)
    db.commit.assert_not_called()


def test_after_unlocking_the_range_can_be_moved_again(monkeypatch):
    author = uuid.uuid4()
    comment = _comment(author, locked_at=APPROVED)
    call, _ = _patch(monkeypatch, comment, user_id=author, project_owner=False)
    call(CommentUpdate(locked=False))

    call, _ = _patch(monkeypatch, comment, user_id=author, project_owner=False)
    call(CommentUpdate(timecode_start=1.0, timecode_end=2.0))

    assert (comment.timecode_start, comment.timecode_end) == (1.0, 2.0)


def test_a_locked_range_can_still_have_its_body_edited(monkeypatch):
    # Lock blocks range edits only; body edits are out of scope for the lock.
    author = uuid.uuid4()
    comment = _comment(author, locked_at=APPROVED)
    call, _ = _patch(monkeypatch, comment, user_id=author, project_owner=False)

    call(CommentUpdate(body="Clip 1 (approved)"))

    assert comment.body == "Clip 1 (approved)"
    assert comment.locked_at == APPROVED


@pytest.mark.parametrize(
    "kwargs",
    [{"parent_id": uuid.uuid4()}, {"start": None, "end": None}, {"end": None}],
    ids=["reply", "untimed note", "point comment"],
)
def test_only_a_range_comment_can_be_locked(monkeypatch, kwargs):
    author = uuid.uuid4()
    comment = _comment(author, **kwargs)
    call, db = _patch(monkeypatch, comment, user_id=author, project_owner=False)

    with pytest.raises(HTTPException) as error:
        call(CommentUpdate(locked=True))

    assert error.value.status_code == 400
    assert comment.locked_at is None
    db.commit.assert_not_called()


@pytest.mark.parametrize(
    "payload",
    [
        {"locked": True, "body": "Clip 1"},
        {"locked": False, "timecode_start": 1.0, "timecode_end": 2.0},
        {"locked": True, "timecode_start": 1.0},
    ],
)
def test_locked_must_be_sent_on_its_own(payload):
    with pytest.raises(ValidationError):
        CommentUpdate(**payload)


def test_locked_alone_is_a_valid_update():
    assert CommentUpdate(locked=False).locked is False
