import hashlib
import importlib.util
import io
import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from sqlalchemy import and_
from sqlalchemy.orm.evaluator import _EvaluatorCompiler
from sqlalchemy.sql import operators

from apps.api.main import app
from apps.api.middleware.auth import get_current_user
from apps.api.middleware.automation_auth import AutomationActor, get_automation_actor
from apps.api.models.asset import Asset, AssetType, AssetVersion, MediaFile, ProcessingStatus
from apps.api.models.automation_token import ProjectAutomationToken
from apps.api.models.clip_render_job import ClipRenderJob
from apps.api.models.comment import Comment
from apps.api.models.project import Project, ProjectMember, ProjectRole
from apps.api.models.user import User
from apps.api.services.clip_render_jobs import locked_snapshot


NOW = datetime(2026, 10, 16, 12, tzinfo=timezone.utc)


class FixtureQuery:
    """Evaluate the real SQL filters against fixture objects; never connect to a DB."""

    def __init__(self, rows, model, filters=(), ordering=()):
        self.rows = rows
        self.model = model if isinstance(model, type) else ProjectAutomationToken
        self.filters = filters
        self.ordering = ordering

    def filter(self, *conditions):
        return FixtureQuery(self.rows, self.model, self.filters + conditions, self.ordering)

    def order_by(self, *columns):
        return FixtureQuery(self.rows, self.model, self.filters, columns)

    def with_for_update(self):
        self.rows.locked_models.append(self.model)
        return self

    def all(self):
        matches = _EvaluatorCompiler(self.model).process(and_(*self.filters))
        result = [row for row in self.rows.data.get(self.model, []) if matches(row)]
        for column in reversed(self.ordering):
            descending = getattr(column, "modifier", None) is operators.desc_op
            key = column.element.key if descending else column.key
            result.sort(key=lambda row: getattr(row, key), reverse=descending)
        return result

    def first(self):
        return next(iter(self.all()), None)

    def scalar(self):
        return max((row.last_used_at for row in self.all() if row.last_used_at is not None), default=None)

    def update(self, values, **kwargs):
        rows = self.all()
        self.rows.updates.append(self)
        for row in rows:
            for key, value in values.items():
                setattr(row, key, value)
        return len(rows)


@pytest.fixture
def queue(client, mock_db):
    user = User(id=uuid.uuid4())
    project = Project(id=uuid.uuid4(), is_public=False, project_folder_id=None, deleted_at=None)
    asset = Asset(id=uuid.uuid4(), project_id=project.id, asset_type=AssetType.video, deleted_at=None)
    version = AssetVersion(id=uuid.uuid4(), asset_id=asset.id, processing_status=ProcessingStatus.ready, deleted_at=None)
    media = MediaFile(id=uuid.uuid4(), version_id=version.id, mime_type="video/mp4")
    member = ProjectMember(id=uuid.uuid4(), project_id=project.id, user_id=user.id, role=ProjectRole.owner, deleted_at=None)
    state = SimpleNamespace(data={Project: [project], Asset: [asset], AssetVersion: [version], MediaFile: [media],
                                 ProjectMember: [member], ClipRenderJob: [], Comment: [], ProjectAutomationToken: []},
                            locked_models=[], updates=[], client=client, db=mock_db,
                            user=user, project=project, asset=asset, version=version, media=media, member=member)
    mock_db.query.side_effect = lambda model: FixtureQuery(state, model)

    def add(row):
        if isinstance(row, ClipRenderJob):
            row.id = row.id or uuid.uuid4()
            row.created_at = row.created_at or datetime.now(timezone.utc)
        state.data.setdefault(type(row), []).append(row)

    mock_db.add.side_effect = add
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_automation_actor] = lambda: AutomationActor(uuid.uuid4(), project.id, user)

    def comment(number, **kwargs):
        values = dict(id=uuid.uuid4(), asset_id=asset.id, version_id=version.id, parent_id=None,
                      body=f"Clip {number}", timecode_start=float(number * 10), timecode_end=float(number * 10 + 5),
                      locked_at=NOW, resolved=False, deleted_at=None)
        values.update(kwargs)
        row = Comment(**values)
        state.data[Comment].append(row)
        return row

    state.comment = comment
    state.comments = [comment(1), comment(2, locked_at=None), comment(3)]
    state.jobs = state.data[ClipRenderJob]
    state.create = lambda: client.post(f"/assets/{asset.id}/clip-render-jobs", json={"version_id": str(version.id)})
    state.latest = lambda: client.get(f"/assets/{asset.id}/clip-render-jobs/latest", params={"version_id": str(version.id)})
    return state


def job(queue, **kwargs):
    ranges, digest = locked_snapshot(queue.comments)
    values = dict(id=uuid.uuid4(), project_id=queue.project.id, asset_id=queue.asset.id, version_id=queue.version.id,
                  requested_by=queue.user.id, status="queued", ranges=ranges, ranges_hash=digest,
                  created_at=NOW, claimed_at=None, finished_at=None, clips_rendered=None, message=None, deleted_at=None)
    values.update(kwargs)
    row = ClipRenderJob(**values)
    queue.jobs.append(row)
    return row


@pytest.mark.parametrize("role", [ProjectRole.owner, ProjectRole.editor])
def test_owner_and_editor_can_queue_only_the_locked_snapshot(queue, role):
    queue.member.role = role
    response = queue.create()
    assert response.status_code == 201
    ranges = [{"comment_id": str(c.id), "number": n, "start": c.timecode_start, "end": c.timecode_end}
              for n, c in [(1, queue.comments[0]), (3, queue.comments[2])]]
    assert response.json()["ranges"] == ranges
    assert response.json()["status"] == "queued"
    assert response.json()["ranges_hash"] == hashlib.sha256(
        json.dumps(ranges, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    assert queue.locked_models == [AssetVersion]


@pytest.mark.parametrize("role", [ProjectRole.viewer, ProjectRole.reviewer, None])
def test_viewer_reviewer_and_nonmember_cannot_create_or_cancel(queue, role):
    if role is None:
        queue.data[ProjectMember].clear()
    else:
        queue.member.role = role
    row = job(queue)
    assert queue.create().status_code == 403
    assert queue.client.post(f"/clip-render-jobs/{row.id}/cancel").status_code == 403
    assert row.status == "queued"


@pytest.mark.parametrize("change", ["asset_missing", "asset_deleted", "version_missing", "wrong_asset", "version_deleted", "audio", "processing",
                                    "media_missing", "media_other_version", "media_not_video"])
def test_requires_an_existing_ready_video_version_of_this_asset(queue, change):
    if change == "asset_missing": queue.data[Asset].clear()
    if change == "asset_deleted": queue.asset.deleted_at = NOW
    if change == "version_missing": queue.data[AssetVersion].clear()
    if change == "wrong_asset": queue.version.asset_id = uuid.uuid4()
    if change == "version_deleted": queue.version.deleted_at = NOW
    if change == "audio": queue.asset.asset_type = AssetType.audio
    if change == "processing": queue.version.processing_status = ProcessingStatus.processing
    if change == "media_missing": queue.data[MediaFile].clear()
    if change == "media_other_version": queue.media.version_id = uuid.uuid4()
    if change == "media_not_video": queue.media.mime_type = "image/jpeg"
    response = queue.create()
    assert response.status_code == (404 if change.startswith("asset_") else 409)
    assert queue.jobs == []


def test_no_locked_ranges_has_a_distinct_conflict_code(queue):
    for comment in queue.comments:
        comment.locked_at = None
    response = queue.create()
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "no_locked_ranges"


@pytest.mark.parametrize("excluded", [dict(resolved=True), dict(deleted_at=NOW), dict(parent_id=uuid.uuid4()),
                                      dict(asset_id=uuid.uuid4()), dict(version_id=uuid.uuid4()),
                                      dict(timecode_start=None), dict(timecode_end=None), dict(body="ordinary note"),
                                      dict(body="Clip 0"), dict(body="Clip 1000"),
                                      pytest.param(dict(body="Clip " + "9" * 5000), id="oversized_number")])
def test_snapshot_and_counts_exclude_nonmatching_comments(queue, excluded):
    queue.comment(4, **excluded)
    assert queue.create().status_code == 201
    assert len(queue.jobs[0].ranges) == 2
    latest = queue.latest().json()
    assert (latest["locked_count"], latest["range_count"]) == (2, 3)


@pytest.mark.parametrize("status,age,blocked", [("queued", None, True), ("claimed", 10, True), ("claimed", 91, False),
                                               ("failed", None, False), ("cancelled", None, False)])
def test_only_queued_and_unexpired_claimed_jobs_block_create(queue, status, age, blocked):
    job(queue, status=status, claimed_at=datetime.now(timezone.utc) - timedelta(minutes=age) if age else None)
    response = queue.create()
    assert response.status_code == (409 if blocked else 201)
    if blocked:
        assert response.json()["detail"]["code"] == "job_active"


def test_second_button_press_cannot_queue_a_duplicate(queue):
    assert queue.create().status_code == 201
    response = queue.create()
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "job_active"
    assert len(queue.jobs) == 1


def test_identical_done_snapshot_is_blocked_even_if_query_order_changes(queue):
    job(queue, status="done")
    queue.data[Comment].reverse()
    response = queue.create()
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "already_rendered"


@pytest.mark.parametrize("change", ["unlocked", "changed_and_relocked"])
def test_a_changed_locked_snapshot_can_be_rendered_again(queue, change):
    job(queue, status="done")
    queue.comments[0].locked_at = None
    if change == "changed_and_relocked":
        queue.comments[0].timecode_end += 1
        queue.comments[0].locked_at = NOW + timedelta(minutes=1)
    assert queue.create().status_code == 201


@pytest.mark.parametrize("same_newest", [False, True])
def test_only_the_newest_done_job_is_compared(queue, same_newest):
    job(queue, status="done", created_at=NOW - timedelta(days=1), ranges_hash="different" if same_newest else locked_snapshot(queue.comments)[1])
    job(queue, status="done", ranges_hash=locked_snapshot(queue.comments)[1] if same_newest else "different")
    assert queue.create().status_code == (409 if same_newest else 201)


def test_deleted_or_other_version_jobs_do_not_block_create(queue):
    job(queue, deleted_at=NOW)
    job(queue, version_id=uuid.uuid4())
    assert queue.create().status_code == 201


@pytest.mark.parametrize("status", ["queued", "claimed", "done", "failed", "cancelled"])
def test_only_a_queued_job_can_be_cancelled(queue, status):
    row = job(queue, status=status)
    response = queue.client.post(f"/clip-render-jobs/{row.id}/cancel")
    assert response.status_code == (200 if status == "queued" else 409)
    assert row.status == ("cancelled" if status == "queued" else status)
    if status == "queued":
        assert response.json()["finished_at"] is not None
        assert queue.create().status_code == 201


@pytest.mark.parametrize("role", list(ProjectRole))
def test_latest_is_readable_by_every_project_role_and_uses_active_tokens_only(queue, role):
    queue.member.role = role
    older = job(queue, created_at=NOW - timedelta(days=1))
    newest = job(queue, created_at=NOW + timedelta(minutes=1))
    job(queue, created_at=NOW + timedelta(days=1), version_id=uuid.uuid4())
    job(queue, created_at=NOW + timedelta(days=1), deleted_at=NOW)
    tokens = queue.data[ProjectAutomationToken]
    def token(**kwargs):
        values = dict(id=uuid.uuid4(), project_id=queue.project.id, revoked_at=None, deleted_at=None, last_used_at=NOW)
        values.update(kwargs)
        tokens.append(ProjectAutomationToken(**values))
    token(last_used_at=NOW - timedelta(minutes=1))
    token()
    token(revoked_at=NOW, last_used_at=NOW + timedelta(days=1))
    token(deleted_at=NOW, last_used_at=NOW + timedelta(days=1))
    token(project_id=uuid.uuid4(), last_used_at=NOW + timedelta(days=1))
    response = queue.latest()
    assert response.status_code == 200
    result = response.json()
    assert result["job"]["id"] == str(newest.id) != str(older.id)
    assert (result["locked_count"], result["range_count"]) == (2, 3)
    assert datetime.fromisoformat(result["worker_last_seen_at"]) == NOW


def test_latest_returns_null_without_a_job_or_worker_and_denies_nonmembers(queue):
    result = queue.latest().json()
    assert result["job"] is None and result["worker_last_seen_at"] is None
    queue.data[ProjectMember].clear()
    assert queue.latest().status_code == 403


def test_worker_list_is_project_scoped_and_contains_only_documented_fields(queue):
    queued = job(queue, message="must never leave the server", ranges=[{**locked_snapshot(queue.comments)[0][0], "body": "private comment", "path": "/private/media"}])
    expired = job(queue, status="claimed", claimed_at=datetime.now(timezone.utc) - timedelta(minutes=91))
    job(queue, status="claimed", claimed_at=datetime.now(timezone.utc))
    for status in ["done", "failed", "cancelled"]:
        job(queue, status=status)
    job(queue, project_id=uuid.uuid4())
    job(queue, deleted_at=NOW)
    response = queue.client.get("/automation/clip-render-jobs?status=queued")
    assert response.status_code == 200
    result = response.json()
    assert {row["id"] for row in result} == {str(queued.id), str(expired.id)}
    for row in result:
        assert set(row) == {"id", "asset_id", "version_id", "ranges", "created_at"}
        for clip in row["ranges"]:
            assert set(clip) == {"comment_id", "number", "start", "end"}
    assert queue.client.get("/automation/clip-render-jobs?status=done").status_code == 422


@pytest.mark.parametrize("change", ["other_project", "deleted", "missing"])
def test_worker_claim_and_finish_hide_out_of_scope_jobs(queue, change):
    row = job(queue, status="claimed")
    if change == "other_project": row.project_id = uuid.uuid4()
    if change == "deleted": row.deleted_at = NOW
    if change == "missing": queue.jobs.clear()
    assert queue.client.post(f"/automation/clip-render-jobs/{row.id}/claim").status_code == 404
    assert queue.client.post(f"/automation/clip-render-jobs/{row.id}/finish", json={"status": "done", "clips_rendered": 2, "message": "ok"}).status_code == 404
    assert queue.updates == []


def test_exactly_one_of_two_sequential_claims_wins(queue):
    row = job(queue)
    first = queue.client.post(f"/automation/clip-render-jobs/{row.id}/claim")
    second = queue.client.post(f"/automation/clip-render-jobs/{row.id}/claim")
    assert (first.status_code, second.status_code) == (200, 409)
    assert row.status == "claimed" and row.claimed_at is not None
    assert set(first.json()) == {"id", "asset_id", "version_id", "ranges", "created_at"}


@pytest.mark.parametrize("age,expected", [(89, 409), (91, 200)])
def test_claimed_jobs_can_only_be_reclaimed_after_the_lease(queue, age, expected):
    previous = datetime.now(timezone.utc) - timedelta(minutes=age)
    row = job(queue, status="claimed", claimed_at=previous)
    assert queue.client.post(f"/automation/clip-render-jobs/{row.id}/claim").status_code == expected
    assert (row.claimed_at > previous) == (expected == 200)


@pytest.mark.parametrize("status", ["done", "failed", "cancelled"])
def test_terminal_jobs_cannot_be_claimed(queue, status):
    row = job(queue, status=status)
    assert queue.client.post(f"/automation/clip-render-jobs/{row.id}/claim").status_code == 409


@pytest.mark.parametrize("action", ["claim", "finish"])
@pytest.mark.parametrize("change", ["project", "deleted"])
def test_worker_conditional_update_rechecks_scope_after_lookup(queue, action, change):
    row = job(queue, status="queued" if action == "claim" else "claimed")
    query = queue.db.query.side_effect
    count = 0

    def concurrent_change(model):
        nonlocal count
        if model is ClipRenderJob:
            count += 1
            if count == 2:
                if change == "project": row.project_id = uuid.uuid4()
                else: row.deleted_at = NOW
        return query(model)

    queue.db.query.side_effect = concurrent_change
    body = {"status": "done", "clips_rendered": 2, "message": ""} if action == "finish" else None
    response = queue.client.post(f"/automation/clip-render-jobs/{row.id}/{action}", json=body)
    assert response.status_code == 409
    assert row.status == ("queued" if action == "claim" else "claimed")


@pytest.mark.parametrize("status", ["queued", "claimed", "done", "failed", "cancelled"])
@pytest.mark.parametrize("result", ["done", "failed"])
def test_finish_only_from_claimed_and_caps_the_message(queue, status, result):
    row = job(queue, status=status)
    response = queue.client.post(f"/automation/clip-render-jobs/{row.id}/finish", json={"status": result, "clips_rendered": 2, "message": "<script>unsafe</script>" * 30})
    assert response.status_code == (200 if status == "claimed" else 409)
    if status == "claimed":
        assert response.json() == {"id": str(row.id), "status": result, "clips_rendered": 2}
        assert len(row.message) == 300 and row.finished_at is not None
        assert queue.client.post(f"/automation/clip-render-jobs/{row.id}/finish", json={"status": result, "clips_rendered": 2, "message": "again"}).status_code == 409


@pytest.mark.parametrize("payload", [{"status": "queued", "clips_rendered": 0, "message": ""},
                                     {"status": "done", "clips_rendered": -1, "message": ""},
                                     {"status": "done", "clips_rendered": True, "message": ""}])
def test_invalid_finish_payloads_are_rejected(queue, payload):
    row = job(queue, status="claimed")
    assert queue.client.post(f"/automation/clip-render-jobs/{row.id}/finish", json=payload).status_code == 422
    assert row.status == "claimed"


def test_worker_endpoints_require_automation_auth(queue):
    app.dependency_overrides.pop(get_automation_actor)
    row = job(queue)
    assert queue.client.get("/automation/clip-render-jobs").status_code == 401
    assert queue.client.post(f"/automation/clip-render-jobs/{row.id}/claim").status_code == 401
    assert queue.client.post(f"/automation/clip-render-jobs/{row.id}/finish", json={"status": "done", "clips_rendered": 2, "message": ""}).status_code == 401


def test_user_endpoints_require_session_auth(queue):
    app.dependency_overrides.pop(get_current_user)
    row = job(queue)
    assert queue.create().status_code == 401
    assert queue.latest().status_code == 401
    assert queue.client.post(f"/clip-render-jobs/{row.id}/cancel").status_code == 401


def test_migration_has_one_head_and_compiles_upgrade_and_downgrade():
    api = Path(__file__).resolve().parents[1]
    config = Config(str(api / "alembic.ini"))
    assert ScriptDirectory.from_config(config).get_heads() == ["dd45ee67ff89"]
    spec = importlib.util.spec_from_file_location("clip_job_migration", api / "alembic/versions/dd45ee67ff89_add_clip_render_jobs.py")
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    assert migration.down_revision == "cc34dd56ee78"
    sql = io.StringIO()
    context = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": sql})
    with Operations.context(context):
        migration.upgrade()
        migration.downgrade()
    output = sql.getvalue()
    assert "CREATE TABLE clip_render_jobs" in output
    assert "CREATE INDEX ix_clip_render_jobs_project_status ON clip_render_jobs (project_id, status)" in output
    assert "DROP TABLE clip_render_jobs" in output
    assert set(ClipRenderJob.__table__.columns.keys()) == {"id", "project_id", "asset_id", "version_id", "requested_by", "status", "ranges", "ranges_hash", "clips_rendered", "message", "created_at", "claimed_at", "finished_at", "deleted_at"}
