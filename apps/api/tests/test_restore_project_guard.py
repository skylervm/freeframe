"""Tests for restore-into-deleted-project guard (#65 adversarial-review fix A1).

There is no project-restore endpoint (only /assets/{id}/restore and /folders/{id}/restore) — a
soft-deleted project is permanent/purge-only. Without this guard, restoring an asset or folder whose
project is soft-deleted would report success while leaving the item parented under a project the
retention GC's `_purge_project` cascade will hard-delete on its next pass (with no re-check of
children's own deleted_at) — a silent, unrecoverable data-loss trap.
"""
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock

import apps.api.routers.folders as folders_module
from apps.api.models.asset import Asset
from apps.api.models.folder import Folder
from apps.api.models.project import Project, ProjectMember, ProjectRole
from apps.api.tests.conftest import configure_first_results


def test_restore_asset_rejects_soft_deleted_project(
    client, auth_headers, mock_db, test_user, monkeypatch
):
    project_id = uuid.uuid4()
    asset = MagicMock()
    asset.project_id = project_id
    asset.deleted_at = datetime.now(timezone.utc)
    asset.trash_operation_id = None

    project = MagicMock()
    project.deleted_at = datetime.now(timezone.utc)  # soft-deleted

    owner = MagicMock(role=ProjectRole.owner, user_id=test_user.id)
    configure_first_results(mock_db, {Asset: asset, ProjectMember: owner, Project: project})

    resp = client.post(f"/assets/{uuid.uuid4()}/restore", headers=auth_headers)

    assert resp.status_code == 409
    assert "project has been deleted" in resp.json()["detail"]


def test_restore_folder_rejects_soft_deleted_project(
    client, auth_headers, mock_db, test_user, monkeypatch
):
    project_id = uuid.uuid4()
    folder = MagicMock()
    folder.project_id = project_id
    folder.deleted_at = datetime.now(timezone.utc)
    folder.trash_operation_id = None

    project = MagicMock()
    project.deleted_at = datetime.now(timezone.utc)  # soft-deleted

    owner = MagicMock(role=ProjectRole.owner, user_id=test_user.id)
    configure_first_results(mock_db, {Folder: folder, ProjectMember: owner, Project: project})

    resp = client.post(f"/folders/{uuid.uuid4()}/restore", headers=auth_headers)

    assert resp.status_code == 409
    assert "project has been deleted" in resp.json()["detail"]
