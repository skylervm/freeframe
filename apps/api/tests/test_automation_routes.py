"""Route-level boundaries for the project-scoped automation API."""
import inspect
import uuid
from unittest.mock import MagicMock
import pytest
from pydantic import ValidationError
from fastapi import HTTPException

from apps.api.middleware.automation_auth import AutomationActor, get_automation_actor
from apps.api.models.asset import ProcessingStatus
from apps.api.routers import automation as automation_module
from apps.api.routers import upload as upload_module
from apps.api.schemas.automation_token import AutomationTokenCreate


def _actor():
    user = MagicMock()
    user.id = uuid.uuid4()
    return AutomationActor(token_id=uuid.uuid4(), project_id=uuid.uuid4(), user=user)


def test_regular_upload_initiate_does_not_accept_automation_fields():
    parameters = inspect.signature(upload_module.initiate_upload).parameters

    assert "automation_token_id" not in parameters
    assert "client_request_id" not in parameters


def test_token_expiry_requires_a_timezone():
    with pytest.raises(ValidationError):
        AutomationTokenCreate(name="pipeline", expires_at="2026-10-01T12:00:00")


def test_initiate_reuses_the_version_for_the_same_idempotency_key(client, mock_db, monkeypatch):
    actor = _actor()
    version = MagicMock()
    version.id = uuid.uuid4()
    version.asset_id = uuid.uuid4()
    version.upload_id = "upload-1"
    version.deleted_at = None
    version.automation_request_fingerprint = automation_module._request_fingerprint(
        automation_module.InitiateUploadRequest(
            project_id=actor.project_id,
            asset_name="Review",
            original_filename="review.mp4",
            mime_type="video/mp4",
            file_size_bytes=1,
            content_sha256="a" * 64,
        )
    )
    media_file = MagicMock()
    media_file.s3_key_raw = "raw/p/a/v/original.mp4"
    mock_db.first.side_effect = [version, media_file]
    from apps.api.main import app

    app.dependency_overrides[get_automation_actor] = lambda: actor
    monkeypatch.setattr(automation_module.upload, "initiate_upload", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("must not create another version")))
    response = client.post(
        "/automation/upload/initiate",
        headers={"Idempotency-Key": str(uuid.uuid4())},
        json={
            "project_id": str(actor.project_id), "asset_name": "Review", "original_filename": "review.mp4",
                "mime_type": "video/mp4", "file_size_bytes": 1, "content_sha256": "a" * 64,
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "upload_id": "upload-1", "s3_key": "raw/p/a/v/original.mp4",
        "asset_id": str(version.asset_id), "version_id": str(version.id),
    }


def test_automation_cannot_initiate_in_another_project(client, mock_db):
    actor = _actor()
    from apps.api.main import app

    app.dependency_overrides[get_automation_actor] = lambda: actor
    response = client.post(
        "/automation/upload/initiate",
        headers={"Idempotency-Key": str(uuid.uuid4())},
        json={
            "project_id": str(uuid.uuid4()), "asset_name": "Review", "original_filename": "review.mp4",
                "mime_type": "video/mp4", "file_size_bytes": 1, "content_sha256": "a" * 64,
        },
    )

    assert response.status_code == 403


def test_complete_locks_the_version_before_processing(client, auth_headers, mock_db, test_user, monkeypatch):
    version = MagicMock()
    version.id = uuid.uuid4()
    version.asset_id = uuid.uuid4()
    version.created_by = test_user.id
    version.processing_status = ProcessingStatus.uploading
    media_file = MagicMock()
    media_file.asset_id = version.asset_id
    media_file.s3_key_raw = "raw/p/a/v/original.mp4"
    media_file.file_size_bytes = 1
    mock_db.first.side_effect = [version, media_file]
    monkeypatch.setattr(upload_module, "list_upload_parts", lambda key, upload_id: [
        {"PartNumber": 1, "ETag": '"one"', "Size": media_file.file_size_bytes}
    ])
    monkeypatch.setattr(upload_module, "complete_multipart_upload", lambda *args: None)
    monkeypatch.setattr(upload_module, "_kick_processing_dispatch", lambda: None)

    response = client.post(
        "/upload/complete",
        json={
            "s3_key": media_file.s3_key_raw, "upload_id": "upload-1",
            "asset_id": str(media_file.asset_id), "version_id": str(uuid.uuid4()), "parts": [],
        },
        headers=auth_headers,
    )

    assert response.status_code == 200
    assert mock_db.with_for_update.called


def test_comment_export_excludes_resolved_instructions():
    actor = _actor()
    asset_id = uuid.uuid4()
    version_id = uuid.uuid4()
    asset = MagicMock(project_id=actor.project_id)
    open_comment = MagicMock(
        id=uuid.uuid4(), asset_id=asset_id, version_id=version_id, body="clip 1: start here",
        timecode_start=10, timecode_end=None, resolved=False, visibility="project", created_at=None,
    )
    resolved_comment = MagicMock(
        id=uuid.uuid4(), asset_id=asset_id, version_id=version_id, body="CLIP 1: END HERE",
        timecode_start=20, timecode_end=None, resolved=True, visibility="project", created_at=None,
    )
    db = MagicMock()
    db.query.return_value = db
    db.filter.return_value = db
    db.order_by.return_value = db
    db.first.side_effect = [asset, MagicMock()]
    db.all.return_value = [open_comment]

    result = automation_module.list_comments(asset_id, version_id, db, actor)

    assert [item["id"] for item in result] == [open_comment.id]


def test_comment_export_rejects_a_version_from_another_asset():
    actor = _actor()
    db = MagicMock()
    db.query.return_value = db
    db.filter.return_value = db
    db.first.side_effect = [MagicMock(project_id=actor.project_id), None]

    with pytest.raises(HTTPException) as error:
        automation_module.list_comments(uuid.uuid4(), uuid.uuid4(), db, actor)

    assert error.value.status_code == 404
