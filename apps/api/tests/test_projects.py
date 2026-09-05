"""
Project endpoint tests.

DB is mocked; auth is bypassed via auth_headers fixture.
The projects router uses POST /projects (with org_id in body) and GET /projects.
"""
import uuid
import asyncio
from datetime import datetime, timezone
from unittest.mock import MagicMock
import pytest

from apps.api.models.project import ProjectType, ProjectRole


def _mock_project(
    org_id: uuid.UUID,
    created_by: uuid.UUID,
    name: str = "Test Project",
) -> MagicMock:
    p = MagicMock()
    p.id = uuid.uuid4()
    p.org_id = org_id
    p.team_id = None
    p.name = name
    p.description = None
    p.project_type = ProjectType.personal
    p.created_by = created_by
    p.created_at = datetime.now(timezone.utc)
    p.deleted_at = None
    p.is_public = False
    p.poster_url = None
    p.poster_source = None
    p.poster_s3_key = None
    p.asset_count = 0
    p.storage_bytes = 0
    p.member_count = 1
    p.role = None
    return p


def _mock_project_member(project_id: uuid.UUID, user_id: uuid.UUID, role: ProjectRole = ProjectRole.owner) -> MagicMock:
    m = MagicMock()
    m.id = uuid.uuid4()
    m.project_id = project_id
    m.user_id = user_id
    m.role = role
    m.invited_by = None
    m.deleted_at = None
    return m


def test_create_project(client, auth_headers, mock_db, test_user):
    """POST /projects — happy path returns 201."""
    org_id = uuid.uuid4()

    def _refresh_side_effect(obj):
        obj.id = uuid.uuid4()
        obj.created_at = datetime.now(timezone.utc)
        obj.deleted_at = None
        obj.team_id = None
        obj.description = None
        obj.project_type = ProjectType.personal
        obj.is_public = False
        obj.poster_url = None
        obj.created_by = test_user.id
        obj.org_id = org_id
        obj.name = "Test Project"

    mock_db.refresh.side_effect = _refresh_side_effect

    resp = client.post(
        "/projects",
        json={"name": "Test Project", "org_id": str(org_id)},
        headers=auth_headers,
    )
    assert resp.status_code == 201
    assert resp.json()["name"] == "Test Project"


def test_list_projects(client, auth_headers, mock_db, test_user):
    """GET /projects — returns empty list when no memberships."""
    # The list_projects router does complex joins (memberships, asset counts,
    # storage, member counts).  With a mock DB every chained call returns the
    # same MagicMock, so the simplest reliable assertion is an empty result.
    mock_db.all.return_value = []  # no memberships → no projects

    resp = client.get("/projects", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json() == []


def test_get_project(client, auth_headers, mock_db, test_user):
    """GET /projects/{project_id} — returns project for member."""
    org_id = uuid.uuid4()
    proj = _mock_project(org_id, test_user.id)
    member = _mock_project_member(proj.id, test_user.id)

    call_count = 0

    def _first_side_effect():
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return proj
        return member

    mock_db.first.side_effect = _first_side_effect

    resp = client.get(f"/projects/{proj.id}", headers=auth_headers)
    assert resp.status_code == 200


def test_get_project_not_member(client, auth_headers, mock_db, test_user):
    """GET /projects/{project_id} — 403 if user is not a member."""
    org_id = uuid.uuid4()
    proj = _mock_project(org_id, test_user.id)

    call_count = 0

    def _first_side_effect():
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return proj
        return None  # no membership

    mock_db.first.side_effect = _first_side_effect

    resp = client.get(f"/projects/{proj.id}", headers=auth_headers)
    assert resp.status_code == 403


def test_delete_project(client, auth_headers, mock_db, test_user):
    """DELETE /projects/{project_id} — owner can delete, returns 204."""
    org_id = uuid.uuid4()
    proj = _mock_project(org_id, test_user.id)
    member = _mock_project_member(proj.id, test_user.id, ProjectRole.owner)

    call_count = 0

    def _first_side_effect():
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return proj
        return member

    mock_db.first.side_effect = _first_side_effect

    resp = client.delete(f"/projects/{proj.id}", headers=auth_headers)
    assert resp.status_code == 204


def test_update_project(client, auth_headers, mock_db, test_user):
    """PATCH /projects/{project_id} — owner can update name."""
    org_id = uuid.uuid4()
    proj = _mock_project(org_id, test_user.id, "Old Name")
    member = _mock_project_member(proj.id, test_user.id, ProjectRole.owner)

    call_count = 0

    def _first_side_effect():
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return proj  # _get_project
        return member    # _require_project_owner

    mock_db.first.side_effect = _first_side_effect

    def _refresh_side_effect(obj):
        obj.name = "New Name"

    mock_db.refresh.side_effect = _refresh_side_effect

    resp = client.patch(
        f"/projects/{proj.id}",
        json={"name": "New Name"},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "New Name"


@pytest.fixture
def poster_setup(monkeypatch, mock_db, test_user):
    from apps.api.routers import projects

    project = _mock_project(uuid.uuid4(), test_user.id)
    project.poster_s3_key = "posters/old.jpg"
    monkeypatch.setattr(projects, "_get_project", lambda *args: project)
    monkeypatch.setattr(projects, "_require_project_owner", lambda *args: None)
    put = MagicMock()
    delete = MagicMock()
    monkeypatch.setattr(projects, "put_object", put)
    monkeypatch.setattr(projects, "delete_object", delete)
    monkeypatch.setattr(projects, "generate_presigned_get_url", lambda key: f"https://storage.test/{key}")
    return projects, project, put, delete


def _poster_file():
    from io import BytesIO
    from fastapi import UploadFile
    from starlette.datastructures import Headers

    return UploadFile(file=BytesIO(b"poster"), filename="new.jpg", headers=Headers({"content-type": "image/jpeg"}))


def test_poster_upload_commit_failure_removes_only_uncommitted_replacement(poster_setup, mock_db, test_user):
    projects, project, put, delete = poster_setup
    mock_db.commit.side_effect = RuntimeError("commit failed")

    with pytest.raises(RuntimeError, match="commit failed"):
        asyncio.run(projects.upload_project_poster(project.id, _poster_file(), mock_db, test_user))

    new_key = put.call_args.args[0]
    assert new_key != "posters/old.jpg"
    delete.assert_called_once_with(new_key)
    mock_db.rollback.assert_called_once()
    mock_db.refresh.assert_not_called()


def test_poster_upload_refresh_failure_keeps_committed_replacement(poster_setup, mock_db, test_user):
    projects, project, put, delete = poster_setup
    committed_keys = []
    mock_db.commit.side_effect = lambda: committed_keys.append(project.poster_s3_key)
    mock_db.refresh.side_effect = RuntimeError("refresh failed")

    with pytest.raises(RuntimeError, match="refresh failed"):
        asyncio.run(projects.upload_project_poster(project.id, _poster_file(), mock_db, test_user))

    assert committed_keys == [put.call_args.args[0]]
    delete.assert_not_called()
    mock_db.rollback.assert_not_called()


def test_poster_upload_deletes_old_object_only_after_commit(poster_setup, mock_db, test_user):
    projects, project, put, delete = poster_setup
    events = []
    mock_db.commit.side_effect = lambda: events.append(("commit", project.poster_s3_key))
    delete.side_effect = lambda key: events.append(("delete", key))

    response = asyncio.run(projects.upload_project_poster(project.id, _poster_file(), mock_db, test_user))

    assert events == [("commit", put.call_args.args[0]), ("delete", "posters/old.jpg")]
    assert response.poster_source == "manual"


def test_poster_reset_commit_failure_preserves_stored_object(poster_setup, mock_db, test_user):
    projects, project, _put, delete = poster_setup
    mock_db.commit.side_effect = RuntimeError("commit failed")

    with pytest.raises(RuntimeError, match="commit failed"):
        projects.remove_project_poster(project.id, mock_db, test_user)

    delete.assert_not_called()
    mock_db.rollback.assert_called_once()


def test_poster_reset_clears_pointer_before_deleting_object(poster_setup, mock_db, test_user):
    projects, project, _put, delete = poster_setup
    events = []
    mock_db.commit.side_effect = lambda: events.append(("commit", project.poster_s3_key))
    delete.side_effect = lambda key: events.append(("delete", key))

    projects.remove_project_poster(project.id, mock_db, test_user)

    assert events == [("commit", None), ("delete", "posters/old.jpg")]
