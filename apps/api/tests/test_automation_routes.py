"""Route-level boundaries for the project-scoped automation API."""
import inspect
import uuid
import hashlib
from unittest.mock import MagicMock
import pytest
from pydantic import ValidationError
from fastapi import HTTPException

from apps.api.middleware.automation_auth import AutomationActor, get_automation_actor
from apps.api.middleware.bootstrap_auth import BootstrapActor, get_bootstrap_actor
from apps.api.models.asset import ProcessingStatus
from apps.api.routers import automation as automation_module
from apps.api.routers import upload as upload_module
from apps.api.schemas.automation_token import AutomationTokenCreate
from apps.api.schemas.bootstrap import BootstrapProjectCreate


def _actor():
    user = MagicMock()
    user.id = uuid.uuid4()
    return AutomationActor(token_id=uuid.uuid4(), project_id=uuid.uuid4(), user=user)


def _bootstrap_actor():
    user = MagicMock()
    user.id = uuid.uuid4()
    return BootstrapActor(user=user)


def test_bootstrap_auth_fails_closed_without_configuration(monkeypatch, mock_db):
    monkeypatch.setattr(automation_module.settings, "automation_bootstrap_token_sha256", None)
    monkeypatch.setattr(automation_module.settings, "automation_bootstrap_owner_id", None)

    with pytest.raises(HTTPException) as error:
        get_bootstrap_actor("x" * 48, mock_db)

    assert error.value.status_code == 401


def test_bootstrap_replay_returns_the_same_project_and_token(mock_db, monkeypatch):
    actor = _bootstrap_actor()
    body = BootstrapProjectCreate(name="Program Radio EP3", token_id=uuid.uuid4(), token_secret_hash="a" * 64)
    request_id = uuid.uuid4()
    existing = MagicMock(request_fingerprint=automation_module._bootstrap_fingerprint(body))
    project = MagicMock(id=uuid.uuid4())
    project.name = body.name
    token = MagicMock(id=body.token_id, expires_at="2026-09-07T00:00:00Z")
    mock_db.first.side_effect = [existing, project, token]
    monkeypatch.setattr(automation_module.settings, "automation_bootstrap_max_projects_per_day", 3)
    monkeypatch.setattr(automation_module.settings, "automation_bootstrap_token_lifetime_hours", 72)
    monkeypatch.setattr(automation_module.settings, "automation_bootstrap_max_file_bytes", 10)
    monkeypatch.setattr(automation_module.settings, "automation_bootstrap_max_total_upload_bytes", 20)

    response = automation_module.bootstrap_project(body, request_id, mock_db, actor)

    assert response.project_id == project.id
    assert response.token_id == token.id
    assert not mock_db.commit.called


def test_bootstrap_rejects_conflicting_idempotency_reuse(mock_db, monkeypatch):
    actor = _bootstrap_actor()
    body = BootstrapProjectCreate(name="Program Radio EP3", token_id=uuid.uuid4(), token_secret_hash="a" * 64)
    mock_db.first.return_value = MagicMock(request_fingerprint="different")
    monkeypatch.setattr(automation_module.settings, "automation_bootstrap_max_projects_per_day", 3)
    monkeypatch.setattr(automation_module.settings, "automation_bootstrap_token_lifetime_hours", 72)
    monkeypatch.setattr(automation_module.settings, "automation_bootstrap_max_file_bytes", 10)
    monkeypatch.setattr(automation_module.settings, "automation_bootstrap_max_total_upload_bytes", 20)

    with pytest.raises(HTTPException) as error:
        automation_module.bootstrap_project(body, uuid.uuid4(), mock_db, actor)

    assert error.value.status_code == 409


def test_bootstrap_quota_reservation_rejects_overages():
    actor = _actor()
    token = MagicMock(max_file_bytes=10, max_total_upload_bytes=20, reserved_upload_bytes=15)
    db = MagicMock()
    db.query.return_value = db
    db.populate_existing.return_value = db
    db.with_for_update.return_value = db
    db.filter.return_value = db
    db.first.return_value = token

    with pytest.raises(HTTPException) as error:
        automation_module._reserve_bootstrap_upload_bytes(db, actor, 6)

    assert error.value.status_code == 413
    assert token.reserved_upload_bytes == 15


def test_bootstrap_quota_reservation_is_atomic_before_upload():
    actor = _actor()
    token = MagicMock(max_file_bytes=10, max_total_upload_bytes=20, reserved_upload_bytes=9)
    db = MagicMock()
    db.query.return_value = db
    db.populate_existing.return_value = db
    db.with_for_update.return_value = db
    db.filter.return_value = db
    db.first.return_value = token

    automation_module._reserve_bootstrap_upload_bytes(db, actor, 10)

    assert token.reserved_upload_bytes == 19
    assert db.with_for_update.called


def test_bootstrap_renewal_rejects_daily_limit(monkeypatch):
    actor = _bootstrap_actor()
    project_id = uuid.uuid4()
    body = automation_module.BootstrapTokenRenewal(token_secret_hash="a" * 64)
    token = MagicMock(id=uuid.uuid4(), project_id=project_id, deleted_at=None)
    project = MagicMock(id=project_id, deleted_at=None)
    request = MagicMock(project_id=project_id, token_id=token.id, owner_id=actor.user.id)
    db = MagicMock()
    db.query.return_value = db
    db.filter.return_value = db
    db.populate_existing.return_value = db
    db.with_for_update.return_value = db
    db.first.side_effect = [None, request, token, project]
    db.count.return_value = 3
    monkeypatch.setattr(automation_module.settings, "automation_bootstrap_max_renewals_per_day", 3)

    with pytest.raises(HTTPException) as error:
        automation_module.renew_bootstrap_token(project_id, body, uuid.uuid4(), db, actor)

    assert error.value.status_code == 429


def test_bootstrap_renewal_replay_rejects_a_stale_secret():
    actor = _bootstrap_actor()
    project_id = uuid.uuid4()
    body = automation_module.BootstrapTokenRenewal(token_secret_hash="a" * 64)
    prior = MagicMock(project_id=project_id, token_id=uuid.uuid4(), request_fingerprint=hashlib.sha256(f"{project_id}:{body.token_secret_hash}".encode()).hexdigest())
    project = MagicMock(id=project_id)
    token = MagicMock(secret_hash="b" * 64)
    db = MagicMock()
    db.query.return_value = db
    db.filter.return_value = db
    db.first.side_effect = [prior, project, token]

    with pytest.raises(HTTPException) as error:
        automation_module.renew_bootstrap_token(project_id, body, uuid.uuid4(), db, actor)

    assert error.value.status_code == 409


def test_upload_part_lengths_are_bound_to_declared_upload_size():
    chunk = upload_module._MULTIPART_CHUNK_BYTES
    size = chunk + 17

    assert upload_module._expected_part_length(size, 1) == chunk
    assert upload_module._expected_part_length(size, 2) == 17
    assert upload_module._expected_part_length(size, 3) is None


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


def test_review_version_matches_current_viewable_version():
    actor = _actor()
    asset_id = uuid.uuid4()
    asset = MagicMock(project_id=actor.project_id)
    version = MagicMock(
        id=uuid.uuid4(), version_number=2, processing_status=ProcessingStatus.ready
    )
    db = MagicMock()
    db.query.return_value = db
    db.filter.return_value = db
    db.order_by.return_value = db
    db.first.side_effect = [asset, version]

    result = automation_module.get_review_version(asset_id, db, actor)

    assert result["id"] == version.id
    assert result["version_number"] == 2


def test_review_version_falls_back_after_no_ready_version():
    actor = _actor()
    asset_id = uuid.uuid4()
    asset = MagicMock(project_id=actor.project_id)
    processing_version = MagicMock(
        id=uuid.uuid4(), version_number=3, processing_status=ProcessingStatus.processing
    )
    db = MagicMock()
    db.query.return_value = db
    db.filter.return_value = db
    db.order_by.return_value = db
    db.first.side_effect = [asset, None, processing_version]

    result = automation_module.get_review_version(asset_id, db, actor)

    assert result["id"] == processing_version.id
    assert db.first.call_count == 3


def test_review_version_falls_back_to_the_newest_version_when_needed():
    actor = _actor()
    asset_id = uuid.uuid4()
    asset = MagicMock(project_id=actor.project_id)
    uploading_version = MagicMock(
        id=uuid.uuid4(), version_number=3, processing_status=ProcessingStatus.uploading
    )
    db = MagicMock()
    db.query.return_value = db
    db.filter.return_value = db
    db.order_by.return_value = db
    db.first.side_effect = [asset, None, None, uploading_version]

    result = automation_module.get_review_version(asset_id, db, actor)

    assert result["id"] == uploading_version.id
    assert db.first.call_count == 4
