import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from apps.api.models.project import ProjectRole
from apps.api.models.share import SharePermission
from apps.api.models.workspace import WorkspaceRole
from apps.api.routers import comments as comment_router
from apps.api.services import permissions
from apps.api.services.permissions import workspace_role_to_project_role


def test_workspace_roles_map_to_project_roles():
    assert workspace_role_to_project_role(WorkspaceRole.viewer) == ProjectRole.viewer
    assert workspace_role_to_project_role(WorkspaceRole.reviewer) == ProjectRole.reviewer
    assert workspace_role_to_project_role(WorkspaceRole.editor) == ProjectRole.editor
    assert workspace_role_to_project_role(WorkspaceRole.owner) == ProjectRole.editor


def test_direct_asset_comment_grant_allows_comment_mutations(monkeypatch):
    asset = SimpleNamespace(project_id=uuid.uuid4())
    user = SimpleNamespace(id=uuid.uuid4())
    monkeypatch.setattr(permissions, "can_access_asset", lambda *_: True)
    monkeypatch.setattr(permissions, "get_effective_project_role", lambda *_: None)
    monkeypatch.setattr(permissions, "get_asset_share_permission", lambda *_: SharePermission.comment)

    permissions.require_comment_access(MagicMock(), asset, user)

    monkeypatch.setattr(permissions, "get_asset_share_permission", lambda *_: SharePermission.view)
    with pytest.raises(HTTPException, match="Requires comment access"):
        permissions.require_comment_access(MagicMock(), asset, user)


def test_attachment_delete_requires_comment_access(monkeypatch):
    user = SimpleNamespace(id=uuid.uuid4())
    comment = SimpleNamespace(id=uuid.uuid4(), asset_id=uuid.uuid4(), author_id=user.id)
    asset = SimpleNamespace(project_id=uuid.uuid4())
    attachment = SimpleNamespace(id=uuid.uuid4(), s3_key="comment-attachments/test")
    db = MagicMock()
    db.query().filter().first.return_value = attachment
    authorized_assets = []

    monkeypatch.setattr(comment_router, "_get_comment", lambda *_: comment)
    monkeypatch.setattr(comment_router, "_get_asset", lambda *_: asset)
    monkeypatch.setattr(
        comment_router,
        "require_comment_access",
        lambda _db, authorized_asset, _user: authorized_assets.append(authorized_asset),
    )
    monkeypatch.setattr(comment_router.s3_service, "delete_object", lambda *_: None)

    comment_router.delete_attachment(comment.id, attachment.id, db=db, current_user=user)

    assert authorized_assets == [asset]
    db.delete.assert_called_once_with(attachment)
    db.commit.assert_called_once()
