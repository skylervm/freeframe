import uuid
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from apps.api.routers import comments as comments_module
from apps.api.schemas.comment import CommentUpdate


def _comment(author_id, *, start=10.0, end=20.0, parent_id=None, body="Clip 1"):
    return MagicMock(
        id=uuid.uuid4(), author_id=author_id, asset_id=uuid.uuid4(), parent_id=parent_id,
        timecode_start=start, timecode_end=end, body=body, deleted_at=None,
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


def test_author_can_move_their_own_range(monkeypatch):
    author = uuid.uuid4()
    comment = _comment(author)
    call, db = _patch(monkeypatch, comment, user_id=author, project_owner=False)

    call(CommentUpdate(timecode_start=12.5, timecode_end=31.0))

    assert (comment.timecode_start, comment.timecode_end) == (12.5, 31.0)
    assert comment.body == "Clip 1"
    db.commit.assert_called_once()


def test_project_owner_can_move_someone_elses_range(monkeypatch):
    comment = _comment(uuid.uuid4())
    call, _ = _patch(monkeypatch, comment, user_id=uuid.uuid4(), project_owner=True)

    call(CommentUpdate(timecode_start=1.0, timecode_end=2.0))

    assert (comment.timecode_start, comment.timecode_end) == (1.0, 2.0)


def test_other_member_cannot_move_a_range(monkeypatch):
    comment = _comment(uuid.uuid4())
    call, db = _patch(monkeypatch, comment, user_id=uuid.uuid4(), project_owner=False)

    with pytest.raises(HTTPException) as error:
        call(CommentUpdate(timecode_start=1.0, timecode_end=2.0))

    assert error.value.status_code == 403
    assert (comment.timecode_start, comment.timecode_end) == (10.0, 20.0)
    db.commit.assert_not_called()


def test_body_only_update_leaves_the_range_alone(monkeypatch):
    author = uuid.uuid4()
    comment = _comment(author)
    call, _ = _patch(monkeypatch, comment, user_id=author, project_owner=False)

    call(CommentUpdate(body="Clip 1 (tight)"))

    assert comment.body == "Clip 1 (tight)"
    assert (comment.timecode_start, comment.timecode_end) == (10.0, 20.0)


def test_range_only_update_leaves_the_body_alone(monkeypatch):
    author = uuid.uuid4()
    comment = _comment(author, body="keep me")
    call, _ = _patch(monkeypatch, comment, user_id=author, project_owner=False)

    call(CommentUpdate(timecode_start=3.0, timecode_end=4.0))

    assert comment.body == "keep me"


@pytest.mark.parametrize("kwargs", [{"parent_id": uuid.uuid4()}, {"start": None, "end": None}])
def test_untimed_notes_and_replies_cannot_gain_a_range(monkeypatch, kwargs):
    author = uuid.uuid4()
    comment = _comment(author, **kwargs)
    call, db = _patch(monkeypatch, comment, user_id=author, project_owner=False)

    with pytest.raises(HTTPException) as error:
        call(CommentUpdate(timecode_start=1.0, timecode_end=2.0))

    assert error.value.status_code == 400
    db.commit.assert_not_called()


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"timecode_start": 5.0},
        {"timecode_end": 5.0},
        {"timecode_start": 5.0, "timecode_end": 5.0},
        {"timecode_start": 6.0, "timecode_end": 5.0},
        {"timecode_start": -1.0, "timecode_end": 5.0},
        {"timecode_start": 1.0, "timecode_end": float("inf")},
        {"timecode_start": float("nan"), "timecode_end": 5.0},
    ],
)
def test_update_rejects_bad_payloads(payload):
    with pytest.raises(ValidationError):
        CommentUpdate(**payload)
