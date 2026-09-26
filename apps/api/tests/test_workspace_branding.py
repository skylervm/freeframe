import base64
import uuid
from datetime import datetime, timezone
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


def test_oversized_value_rejected_before_decoding(monkeypatch):
    decoded = []
    monkeypatch.setattr(router.base64, "b64decode", lambda *a, **k: decoded.append(1))
    big = "data:image/png;base64," + "A" * (router.BRANDING_MAX_BYTES * 2)
    with pytest.raises(HTTPException) as e:
        router._decode_png_data_url(big, "icon")
    assert e.value.status_code == 413
    assert decoded == []


# The image routes below go through the real app so the `{image}.png` path is exercised.

def test_icon_served_as_png(client, monkeypatch):
    monkeypatch.setattr(router, "_active_workspace", lambda _db: _workspace(icon=PNG))
    res = client.get("/workspace/branding/icon.png")
    assert res.status_code == 200
    assert res.content == PNG
    assert res.headers["content-type"] == "image/png"
    assert res.headers["x-content-type-options"] == "nosniff"


def test_missing_icon_serves_default_without_redirect(client, monkeypatch):
    monkeypatch.setattr(router, "_active_workspace", lambda _db: _workspace())
    res = client.get("/workspace/branding/icon.png", follow_redirects=False)
    assert res.status_code == 200
    assert res.content == router._DEFAULT_ICON
    assert res.content.startswith(b"\x89PNG")


def test_etag_changes_with_branding_and_answers_304(client, monkeypatch):
    ws = _workspace(icon=PNG, branding_updated_at=datetime(2026, 9, 26, tzinfo=timezone.utc))
    monkeypatch.setattr(router, "_active_workspace", lambda _db: ws)
    etag = client.get("/workspace/branding/icon.png").headers["etag"]

    for header in (etag, f"W/{etag}", f'"other", {etag}', "*"):
        cached = client.get("/workspace/branding/icon.png", headers={"If-None-Match": header})
        assert cached.status_code == 304, header
        assert cached.content == b""
    assert router._DEFAULT_ICON_HASH in etag

    ws.branding_updated_at = datetime(2026, 9, 27, tzinfo=timezone.utc)
    fresh = client.get("/workspace/branding/icon.png", headers={"If-None-Match": etag})
    assert fresh.status_code == 200
    assert fresh.headers["etag"] != etag


def test_missing_logo_and_unknown_image_404(client, monkeypatch):
    monkeypatch.setattr(router, "_active_workspace", lambda _db: _workspace())
    for name in ("logo_dark", "name", "branding_updated_at"):
        assert client.get(f"/workspace/branding/{name}.png").status_code == 404
