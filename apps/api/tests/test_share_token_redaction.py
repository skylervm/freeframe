import uuid
from datetime import datetime, timezone
from unittest.mock import patch

from apps.api.models.share import ShareLink, SharePermission
from apps.api.routers.share import _share_link_response


def _link() -> ShareLink:
    return ShareLink(
        id=uuid.uuid4(),
        asset_id=uuid.uuid4(),
        token="bearer-token",
        created_by=uuid.uuid4(),
        title="Client review",
        is_enabled=True,
        permission=SharePermission.view,
        visibility="public",
        allow_download=False,
        show_versions=True,
        show_watermark=False,
        appearance={},
        password_hash="hash",
        password_encrypted="encrypted-password",
        created_at=datetime.now(timezone.utc),
    )


def test_inherited_folder_viewer_share_metadata_redacts_bearer_token_and_password():
    link = _link()

    with patch("apps.api.routers.share.decrypt_password") as decrypt_password:
        response = _share_link_response(link, include_secret=False)

    assert response.token is None
    assert response.password_value is None
    assert response.has_password is True
    decrypt_password.assert_not_called()


def test_direct_project_editor_share_metadata_keeps_bearer_token_and_password():
    link = _link()

    with patch("apps.api.routers.share.decrypt_password", return_value="secret") as decrypt_password:
        response = _share_link_response(link, include_secret=True)

    assert response.token == "bearer-token"
    assert response.password_value == "secret"
    decrypt_password.assert_called_once_with("encrypted-password")
