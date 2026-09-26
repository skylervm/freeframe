import base64
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from apps.api.routers import project_folders as router
from apps.api.schemas.project_folder import WorkspaceBrandingUpdate

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
PNG_URL = "data:image/png;base64," + base64.b64encode(PNG).decode()


def _workspace(**kw):
    ws = SimpleNamespace(id=uuid.uuid4(), logo_dark=None, logo_light=None, icon=None, branding_updated_at=None)
    ws.__dict__.update(kw)
    return ws


def test_superadmin_saves_logos_and_icon(monkeypatch):
    ws = _workspace()
    monkeypatch.setattr(router, "_lock_workspace", lambda _db: ws)
    user = SimpleNamespace(is_superadmin=True)

    db = MagicMock()
    # The response reads presence flags back from the database, not the blobs.
    db.query.return_value.filter.return_value.one.side_effect = lambda: (
        ws.logo_dark is not None, ws.logo_light is not None, ws.icon is not None, ws.branding_updated_at,
    )

    res = router.update_workspace_branding(
        WorkspaceBrandingUpdate(logo_dark=PNG_URL, logo_light=None, icon=PNG_URL), db=db, current_user=user
    )

    assert ws.logo_dark == PNG and ws.icon == PNG and ws.logo_light is None
    assert res.has_logo_dark and res.has_icon and not res.has_logo_light
    assert res.updated_at is not None
    db.commit.assert_called_once()


def test_non_superadmin_cannot_save(monkeypatch):
    monkeypatch.setattr(router, "_lock_workspace", lambda _db: _workspace())
    with pytest.raises(HTTPException) as e:
        router.update_workspace_branding(
            WorkspaceBrandingUpdate(icon=PNG_URL), db=MagicMock(), current_user=SimpleNamespace(is_superadmin=False)
        )
    assert e.value.status_code == 403


@pytest.mark.parametrize("value", [
    "data:image/svg+xml;base64," + base64.b64encode(b"<svg/>").decode(),
    "data:image/png;base64," + base64.b64encode(b"<svg onload=alert(1)/>").decode(),
    "data:image/png;base64,not base64!",
])
def test_rejects_non_png(value):
    with pytest.raises(HTTPException) as e:
        router._decode_png_data_url(value, "icon")
    assert e.value.status_code == 422


def test_rejects_oversized_png():
    big = "data:image/png;base64," + base64.b64encode(PNG + b"\x00" * router.BRANDING_MAX_BYTES).decode()
    with pytest.raises(HTTPException) as e:
        router._decode_png_data_url(big, "icon")
    assert e.value.status_code == 413


def test_icon_served_as_png(monkeypatch):
    monkeypatch.setattr(router, "_active_workspace", lambda _db: _workspace(icon=PNG))
    res = router.get_workspace_branding_image("icon", db=MagicMock())
    assert res.body == PNG
    assert res.media_type == "image/png"
    assert res.headers["x-content-type-options"] == "nosniff"


def test_missing_icon_falls_back_to_default(monkeypatch):
    monkeypatch.setattr(router, "_active_workspace", lambda _db: _workspace())
    monkeypatch.setattr(router.settings, "frontend_url", "https://review.example.com/")
    res = router.get_workspace_branding_image("icon", db=MagicMock())
    assert res.status_code == 307
    assert res.headers["location"] == "https://review.example.com/icon-default.png"


def test_missing_logo_and_unknown_image_404(monkeypatch):
    monkeypatch.setattr(router, "_active_workspace", lambda _db: _workspace())
    for name in ("logo_dark", "name", "branding_updated_at"):
        with pytest.raises(HTTPException) as e:
            router.get_workspace_branding_image(name, db=MagicMock())
        assert e.value.status_code == 404
