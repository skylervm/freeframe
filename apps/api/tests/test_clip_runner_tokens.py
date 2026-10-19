"""Clip runner token: auth boundary, management endpoints, and migration."""
import hashlib
import importlib.util
import io
import logging
import re
import uuid
from dataclasses import FrozenInstanceError
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from fastapi import HTTPException
from fastapi.routing import APIRoute

from apps.api.main import app
from apps.api.middleware import clip_runner_auth
from apps.api.middleware.auth import get_current_user, get_optional_user
from apps.api.middleware.automation_auth import get_automation_actor
from apps.api.middleware.clip_runner_auth import get_clip_runner_actor
from apps.api.models.automation_token import ProjectAutomationToken
from apps.api.models.clip_runner_token import ClipRunnerToken
from apps.api.models.project import Project, ProjectMember, ProjectRole
from apps.api.models.user import User, UserStatus
from apps.api.tests.test_clip_render_jobs import FixtureQuery, job, queue  # noqa: F401  (queue is a fixture)

SECRET = "s3cret-value_with-underscores_and-dashes"
GENERIC_401 = {"detail": "Invalid clip runner token"}
RUNNER_PATHS = {
    ("GET", "/runner/clip-render-jobs"),
    ("POST", "/runner/clip-render-jobs/{job_id}/claim"),
    ("POST", "/runner/clip-render-jobs/{job_id}/finish"),
}


def _sha(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def _store(data):
    rows = SimpleNamespace(data=data, locked_models=[], updates=[])
    db = MagicMock()
    db.query.side_effect = lambda *entities: FixtureQuery(rows, *entities)
    return db


def _creator(**kwargs):
    values = dict(id=uuid.uuid4(), is_superadmin=True, status=UserStatus.active, deleted_at=None)
    values.update(kwargs)
    return User(**values)


def _runner_token(creator, **kwargs):
    values = dict(id=uuid.uuid4(), name="Mac clip runner", secret_hash=_sha(SECRET), created_by=creator.id,
                  last_used_at=None, revoked_at=None, expires_at=datetime.now(timezone.utc) + timedelta(days=30))
    values.update(kwargs)
    return ClipRunnerToken(**values)


def _runner_db(token, creator):
    return _store({ClipRunnerToken: [token], User: [creator] if creator else []})


def _header(token_id, prefix="ffcr", secret=SECRET):
    return f"Bearer {prefix}_{token_id}_{secret}"


def _rejects(authorization, db):
    with pytest.raises(HTTPException) as error:
        get_clip_runner_actor(authorization, db)
    assert error.value.status_code == 401
    assert error.value.detail == GENERIC_401["detail"]


# ── Auth dependency ────────────────────────────────────────────────────────────

def test_valid_runner_token_authenticates_and_records_use():
    creator = _creator()
    token = _runner_token(creator)
    db = _runner_db(token, creator)
    actor = get_clip_runner_actor(_header(token.id), db)
    assert actor.token_id == token.id and actor.user is creator
    assert token.last_used_at is not None
    db.commit.assert_called_once()
    with pytest.raises(FrozenInstanceError):
        actor.token_id = uuid.uuid4()  # frozen


@pytest.mark.parametrize("age,writes", [(None, 1), (61, 1), (30, 0)])
def test_last_used_is_written_atomically_at_most_once_per_minute(age, writes):
    creator = _creator()
    before = None if age is None else datetime.now(timezone.utc) - timedelta(seconds=age)
    token = _runner_token(creator, last_used_at=before)
    db = _runner_db(token, creator)
    get_clip_runner_actor(_header(token.id), db)
    assert (token.last_used_at != before) == bool(writes)
    assert db.commit.call_count == writes


@pytest.mark.parametrize("case", ["revoked", "expired", "expires_now", "wrong_secret", "creator_deactivated",
                                  "creator_pending", "creator_deleted", "creator_not_superadmin", "creator_missing",
                                  "unknown_id"])
def test_runner_token_failures_share_one_generic_401(case):
    creator = _creator()
    token = _runner_token(creator)
    token_id, secret = token.id, SECRET
    if case == "revoked":
        token.revoked_at = datetime.now(timezone.utc)
    if case == "expired":
        token.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    if case == "expires_now":
        token.expires_at = datetime.now(timezone.utc)
    if case == "wrong_secret":
        secret = SECRET + "x"
    if case == "creator_deactivated":
        creator.status = UserStatus.deactivated
    if case == "creator_pending":
        creator.status = UserStatus.pending_invite
    if case == "creator_deleted":
        creator.deleted_at = datetime.now(timezone.utc)
    if case == "creator_not_superadmin":
        creator.is_superadmin = False
    if case == "unknown_id":
        token_id = uuid.uuid4()
    db = _runner_db(token, None if case == "creator_missing" else creator)
    _rejects(_header(token_id, secret=secret), db)
    db.commit.assert_not_called()


@pytest.mark.parametrize("authorization", [None, "", "ffcr_x", "Basic abc", "Bearer ", "Bearer jwt.token.value",
                                           "Bearer ffcr", "Bearer ffcr_", "Bearer ffcr_not-a-uuid_secret",
                                           "Bearer ffcr_{id}", "Bearer ffcr_{id}_", "Bearer FFCR_{id}_" + SECRET,
                                           "Bearer xffcr_{id}_" + SECRET, "Bearer ffcrx_{id}_" + SECRET])
def test_malformed_runner_tokens_are_rejected(authorization):
    creator = _creator()
    token = _runner_token(creator)
    db = _runner_db(token, creator)
    _rejects(authorization.replace("{id}", str(token.id)) if authorization else authorization, db)


def test_runner_dependency_rejects_a_project_automation_token_with_a_matching_id_and_secret():
    creator = _creator()
    token = _runner_token(creator)
    db = _runner_db(token, creator)
    _rejects(_header(token.id, prefix="ffat"), db)
    assert get_clip_runner_actor(_header(token.id), db).token_id == token.id  # positive control


def _automation_db(token_id):
    user = _creator(is_superadmin=False)
    project = Project(id=uuid.uuid4(), deleted_at=None)
    automation = ProjectAutomationToken(id=token_id, project_id=project.id, created_by=user.id, secret_hash=_sha(SECRET),
                                        deleted_at=None, revoked_at=None, expires_at=None, last_used_at=None)
    member = ProjectMember(id=uuid.uuid4(), project_id=project.id, user_id=user.id, role=ProjectRole.owner, deleted_at=None)
    return _store({ProjectAutomationToken: [automation], Project: [project], User: [user], ProjectMember: [member]})


def test_automation_dependency_rejects_a_runner_token_with_a_matching_id_and_secret():
    token_id = uuid.uuid4()
    db = _automation_db(token_id)
    assert get_automation_actor(_header(token_id, prefix="ffat"), db).token_id == token_id  # positive control
    with pytest.raises(HTTPException) as error:
        get_automation_actor(_header(token_id, prefix="ffcr"), db)
    assert error.value.status_code == 401


def _traced(case, monkeypatch):
    """Run one authentication; return (outcome, models queried, compare calls)."""
    compares = []
    real = clip_runner_auth.hmac.compare_digest
    monkeypatch.setattr(clip_runner_auth.hmac, "compare_digest", lambda a, b: compares.append(1) or real(a, b))
    creator = _creator()
    token = _runner_token(creator, last_used_at=datetime.now(timezone.utc) - timedelta(hours=1))
    token_id, secret = token.id, SECRET
    if case == "unknown_id":
        token_id = uuid.uuid4()
    if case == "wrong_secret":
        secret = SECRET + "x"
    if case == "revoked":
        token.revoked_at = datetime.now(timezone.utc)
    if case == "expired":
        token.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    if case == "demoted":
        creator.is_superadmin = False
    if case == "deactivated":
        creator.status = UserStatus.deactivated
    if case == "deleted":
        creator.deleted_at = datetime.now(timezone.utc)
    db = _runner_db(token, creator)
    queried = []
    lookup = db.query.side_effect
    db.query.side_effect = lambda *entities: queried.append(entities[0]) or lookup(*entities)
    try:
        get_clip_runner_actor(_header(token_id, secret=secret), db)
        outcome = "ok"
    except HTTPException as error:
        outcome = (error.status_code, error.detail)
    return outcome, queried, len(compares)


FAILURES = ["unknown_id", "wrong_secret", "revoked", "expired", "demoted", "deactivated", "deleted"]


def test_every_failure_does_the_same_database_and_hash_work_as_success(monkeypatch):
    traces = {case: _traced(case, monkeypatch) for case in FAILURES + ["success"]}
    for case in FAILURES:
        outcome, queried, compares = traces[case]
        assert outcome == (401, GENERIC_401["detail"]), case
        assert (queried, compares) == ([ClipRunnerToken, User], 1), case
    outcome, queried, compares = traces["success"]
    assert outcome == "ok"
    # Identical up to the last_used_at write, which is the only extra query.
    assert (queried, compares) == ([ClipRunnerToken, User, ClipRunnerToken], 1)


# ── The runner token reaches only the three runner endpoints ───────────────────

def _dependency_calls(dependant):
    for dependency in dependant.dependencies:
        yield dependency.call
        yield from _dependency_calls(dependency)


def _api_routes(routes):
    # Recent FastAPI wraps included routers lazily; unwrap them.
    for route in routes:
        if isinstance(route, APIRoute):
            yield route
        elif hasattr(route, "original_router"):
            yield from _api_routes(route.original_router.routes)


def test_only_the_three_runner_routes_accept_a_runner_token_and_they_accept_nothing_else():
    session_auth = {get_current_user, get_optional_user, get_automation_actor}
    runner_routes = set()
    routes = list(_api_routes(app.routes))
    # The walk must see every documented operation, or this test proves nothing.
    documented = {(method.upper(), path) for path, item in app.openapi()["paths"].items() for method in item}
    assert documented <= {(method, re.sub(r":[^}]+}", "}", route.path)) for route in routes for method in route.methods}
    for route in routes:
        calls = set(_dependency_calls(route.dependant))
        if get_clip_runner_actor in calls:
            runner_routes.update((method, route.path) for method in route.methods)
            assert not calls & session_auth, route.path
        if route.path.startswith("/runner"):
            assert get_clip_runner_actor in calls, route.path
    assert runner_routes == RUNNER_PATHS


def test_old_automation_clip_render_job_routes_are_gone():
    paths = app.openapi()["paths"]
    assert not [path for path in paths if path.startswith("/automation/clip-render-jobs")]
    assert {path for path in paths if path.startswith("/runner")} == {path for _, path in RUNNER_PATHS}


@pytest.fixture
def live_runner(queue):  # noqa: F811 (queue is the imported fixture)
    """A real, valid runner token for queue.user, authenticated by the real dependency."""
    from apps.api.main import app as application
    application.dependency_overrides.pop(get_clip_runner_actor)
    application.dependency_overrides.pop(get_current_user)
    token = _runner_token(queue.user)
    queue.data[ClipRunnerToken].append(token)
    queue.headers = {"Authorization": _header(token.id)}
    queue.token = token
    return queue


def test_runner_token_gets_401_on_every_other_kind_of_endpoint(live_runner):
    queue = live_runner  # noqa: F811 (queue is the imported fixture)
    row = job(queue)
    listed = queue.client.get("/runner/clip-render-jobs", headers=queue.headers)
    assert listed.status_code == 200 and [item["id"] for item in listed.json()] == [str(row.id)]  # the token is valid
    asset, version = queue.asset.id, queue.version.id
    attempts = [
        ("GET", f"/automation/assets/{asset}/comments?version_id={version}"),
        ("GET", f"/automation/assets/{asset}/review-comments?version_id={version}"),
        ("GET", f"/automation/versions/{version}"),
        ("DELETE", f"/automation/assets/{asset}"),
        ("GET", "/projects"),
        ("GET", "/me/assets"),
        ("GET", f"/assets/{asset}"),
        ("GET", f"/assets/{asset}/clip-render-jobs/latest?version_id={version}"),
        ("POST", f"/clip-render-jobs/{row.id}/cancel"),
        ("GET", "/clip-runner-tokens"),
        ("DELETE", f"/clip-runner-tokens/{queue.token.id}"),
        ("GET", "/admin/users"),
        ("GET", "/users"),
    ]
    for method, path in attempts:
        response = queue.client.request(method, path, headers=queue.headers)
        assert response.status_code == 401, (method, path, response.status_code)
    assert row.status == "queued" and queue.token.revoked_at is None


@pytest.mark.parametrize("case", ["revoked", "expired", "not_superadmin", "deactivated"])
def test_runner_endpoints_return_the_same_401_body_for_a_dead_token(live_runner, case):
    queue = live_runner  # noqa: F811 (queue is the imported fixture)
    row = job(queue)
    if case == "revoked":
        queue.token.revoked_at = datetime.now(timezone.utc)
    if case == "expired":
        queue.token.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    if case == "not_superadmin":
        queue.user.is_superadmin = False
    if case == "deactivated":
        queue.user.status = UserStatus.deactivated
    responses = [
        queue.client.get("/runner/clip-render-jobs", headers=queue.headers),
        queue.client.post(f"/runner/clip-render-jobs/{row.id}/claim", headers=queue.headers),
        queue.client.post(f"/runner/clip-render-jobs/{row.id}/finish", headers=queue.headers,
                          json={"claim_id": str(uuid.uuid4()), "status": "done", "clips_rendered": 2, "message": ""}),
        queue.client.get("/runner/clip-render-jobs", headers={"Authorization": "Bearer garbage"}),
    ]
    assert [(response.status_code, response.json()) for response in responses] == [(401, GENERIC_401)] * 4
    assert row.status == "queued"


# ── Management endpoints (session auth, superadmin only) ───────────────────────

@pytest.fixture
def admin(client, mock_db):
    user = _creator()
    state = SimpleNamespace(data={ClipRunnerToken: [], User: [user]}, locked_models=[], updates=[], user=user, client=client, db=mock_db)
    mock_db.query.side_effect = lambda *entities: FixtureQuery(state, *entities)

    def add(row):
        row.created_at = row.created_at or datetime.now(timezone.utc)
        state.data.setdefault(type(row), []).append(row)

    mock_db.add.side_effect = add
    app.dependency_overrides[get_current_user] = lambda: user
    state.tokens = state.data[ClipRunnerToken]
    return state


def _expiry(delta):
    return (datetime.now(timezone.utc) + delta).isoformat()


def test_superadmin_creates_a_token_shown_once_and_stored_hashed(admin, caplog):
    with caplog.at_level(logging.INFO):
        response = admin.client.post("/clip-runner-tokens", json={"name": "Mac clip runner", "expires_at": _expiry(timedelta(days=365))})
    assert response.status_code == 201
    body = response.json()
    assert set(body) == {"id", "name", "created_at", "expires_at", "token"}
    prefix, token_id, secret = body["token"].split("_", 2)
    assert prefix == "ffcr" and uuid.UUID(token_id) == uuid.UUID(body["id"])
    assert len(secret) >= 43  # token_urlsafe(32) is 32 random bytes
    stored, = admin.tokens
    assert stored.secret_hash == _sha(secret) and secret not in stored.secret_hash
    assert stored.created_by == admin.user.id and stored.revoked_at is None
    assert any(body["id"] in record.getMessage() for record in caplog.records)
    assert not any(secret in record.getMessage() or stored.secret_hash in record.getMessage() for record in caplog.records)
    # The created token works with the real runner dependency.
    assert get_clip_runner_actor(f"Bearer {body['token']}", admin.db).token_id == stored.id


def test_two_tokens_get_different_secrets(admin):
    first = admin.client.post("/clip-runner-tokens", json={"name": "a", "expires_at": _expiry(timedelta(days=1))}).json()
    second = admin.client.post("/clip-runner-tokens", json={"name": "b", "expires_at": _expiry(timedelta(days=1))}).json()
    assert first["token"].split("_", 2)[2] != second["token"].split("_", 2)[2]


@pytest.mark.parametrize("expires_at", [
    pytest.param(lambda: _expiry(-timedelta(minutes=1)), id="past"),
    pytest.param(lambda: datetime.now(timezone.utc).isoformat(), id="now"),
    pytest.param(lambda: _expiry(timedelta(days=366, minutes=1)), id="over_366_days"),
    pytest.param(lambda: (datetime.now(timezone.utc) + timedelta(days=30)).replace(tzinfo=None).isoformat(), id="no_timezone"),
])
def test_expiry_must_be_future_aware_and_within_366_days(admin, expires_at):
    response = admin.client.post("/clip-runner-tokens", json={"name": "Mac clip runner", "expires_at": expires_at()})
    assert response.status_code == 400
    assert admin.tokens == []


def test_expiry_at_366_days_with_any_timezone_is_accepted(admin):
    offset = timezone(timedelta(hours=-7))
    expires_at = (datetime.now(timezone.utc) + timedelta(days=366) - timedelta(minutes=1)).astimezone(offset).isoformat()
    assert admin.client.post("/clip-runner-tokens", json={"name": "x", "expires_at": expires_at}).status_code == 201


@pytest.mark.parametrize("name", ["", "x" * 256])
def test_name_must_be_1_to_255_characters(admin, name):
    assert admin.client.post("/clip-runner-tokens", json={"name": name, "expires_at": _expiry(timedelta(days=1))}).status_code == 422


def test_creation_is_rate_limited(admin, monkeypatch):
    seen = []
    monkeypatch.setattr("apps.api.middleware.rate_limit.check_rate_limit",
                        lambda ip, action, limit, window: seen.append((action, limit, window)) or (False, 60))
    response = admin.client.post("/clip-runner-tokens", json={"name": "x", "expires_at": _expiry(timedelta(days=1))})
    assert response.status_code == 429
    assert ("clip_runner_token_create", 10, 3600) in seen
    assert admin.tokens == []


@pytest.mark.parametrize("flag", [False, None])
def test_non_superadmins_cannot_create_list_or_revoke(admin, flag):
    token = _runner_token(admin.user)
    admin.tokens.append(token)
    admin.user.is_superadmin = flag
    assert admin.client.post("/clip-runner-tokens", json={"name": "x", "expires_at": _expiry(timedelta(days=1))}).status_code == 403
    assert admin.client.get("/clip-runner-tokens").status_code == 403
    assert admin.client.delete(f"/clip-runner-tokens/{token.id}").status_code == 403
    assert admin.tokens == [token] and token.revoked_at is None


def test_management_requires_a_session(admin):
    app.dependency_overrides.pop(get_current_user)
    assert admin.client.get("/clip-runner-tokens").status_code == 401
    assert admin.client.post("/clip-runner-tokens", json={"name": "x", "expires_at": _expiry(timedelta(days=1))}).status_code == 401


def test_list_returns_only_the_callers_tokens_and_never_a_secret(admin):
    mine_old = _runner_token(admin.user, created_at=datetime(2026, 1, 1, tzinfo=timezone.utc))
    mine_new = _runner_token(admin.user, created_at=datetime(2026, 2, 1, tzinfo=timezone.utc),
                             last_used_at=datetime(2026, 2, 2, tzinfo=timezone.utc), revoked_at=datetime(2026, 2, 3, tzinfo=timezone.utc))
    other = _runner_token(_creator(), created_at=datetime(2026, 3, 1, tzinfo=timezone.utc))
    admin.tokens.extend([mine_old, mine_new, other])
    response = admin.client.get("/clip-runner-tokens")
    assert response.status_code == 200
    rows = response.json()
    assert [row["id"] for row in rows] == [str(mine_new.id), str(mine_old.id)]
    for row in rows:
        assert set(row) == {"id", "name", "created_at", "last_used_at", "expires_at", "revoked_at"}
    assert mine_new.secret_hash not in response.text and SECRET not in response.text


def test_revoke_is_idempotent_and_scoped_to_the_caller(admin, caplog):
    mine = _runner_token(admin.user)
    other = _runner_token(_creator())
    admin.tokens.extend([mine, other])
    with caplog.at_level(logging.INFO):
        assert admin.client.delete(f"/clip-runner-tokens/{mine.id}").status_code == 204
    revoked_at = mine.revoked_at
    assert revoked_at is not None
    assert any(str(mine.id) in record.getMessage() for record in caplog.records)
    assert admin.client.delete(f"/clip-runner-tokens/{mine.id}").status_code == 204
    assert mine.revoked_at == revoked_at
    assert admin.client.delete(f"/clip-runner-tokens/{other.id}").status_code == 404
    assert admin.client.delete(f"/clip-runner-tokens/{uuid.uuid4()}").status_code == 404
    assert other.revoked_at is None
    _rejects(_header(mine.id), _runner_db(mine, admin.user))


# ── Model and migration ────────────────────────────────────────────────────────

def test_runner_token_migration_is_the_single_head_and_compiles():
    api = Path(__file__).resolve().parents[1]
    assert ScriptDirectory.from_config(Config(str(api / "alembic.ini"))).get_heads() == ["ee56ff78aa90"]
    spec = importlib.util.spec_from_file_location("runner_token_migration", api / "alembic/versions/ee56ff78aa90_add_clip_runner_tokens.py")
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    assert migration.down_revision == "dd45ee67ff89"
    sql = io.StringIO()
    context = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": sql})
    with Operations.context(context):
        migration.upgrade()
        migration.downgrade()
    output = sql.getvalue()
    assert "CREATE TABLE clip_runner_tokens" in output
    assert "expires_at TIMESTAMP WITH TIME ZONE NOT NULL" in output
    assert "FOREIGN KEY(created_by) REFERENCES users (id) ON DELETE CASCADE" in output
    assert "CREATE INDEX ix_clip_runner_tokens_created_by ON clip_runner_tokens (created_by)" in output
    assert "DROP TABLE clip_runner_tokens" in output
    assert output.count("REFERENCES") == 1


def test_runner_token_model_matches_the_migration():
    table = ClipRunnerToken.__table__
    assert set(table.columns.keys()) == {"id", "name", "secret_hash", "created_by", "created_at", "last_used_at", "expires_at", "revoked_at"}
    assert not table.c.expires_at.nullable and table.c.last_used_at.nullable and table.c.revoked_at.nullable
    foreign_key, = table.c.created_by.foreign_keys
    assert foreign_key.target_fullname == "users.id" and foreign_key.ondelete == "CASCADE"
    assert [index.name for index in table.indexes] == ["ix_clip_runner_tokens_created_by"]
