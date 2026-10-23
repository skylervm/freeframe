import hashlib
import importlib.util
import io
import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import and_, literal
from sqlalchemy.orm.evaluator import _EvaluatorCompiler
from sqlalchemy.sql import operators, visitors
from sqlalchemy.sql.selectable import Exists

from apps.api.main import app
from apps.api.middleware.auth import get_current_user
from apps.api.middleware.clip_runner_auth import ClipRunnerActor, get_clip_runner_actor
from apps.api.models.asset import Asset, AssetType, AssetVersion, MediaFile, ProcessingStatus
from apps.api.models.clip_render_job import ClipRenderJob
from apps.api.models.clip_runner_token import ClipRunnerToken
from apps.api.models.comment import Comment
from apps.api.models.project import Project, ProjectMember, ProjectRole
from apps.api.models.user import User, UserStatus
from apps.api.schemas.clip_render_job import ClipRenderRange
from apps.api.services.clip_render_jobs import locked_snapshot


NOW = datetime(2026, 10, 16, 12, tzinfo=timezone.utc)


class FixtureQuery:
    """Evaluate the real SQL filters against fixture objects; never connect to a DB."""

    def __init__(self, rows, *entities):
        self.rows = rows
        # Column queries (e.g. `query(Job.project_id, func.min(Job.created_at))`)
        # filter the entity's model rows, then project them into tuples.
        self.entities = () if isinstance(entities[0], type) else entities
        self.model = entities[0] if isinstance(entities[0], type) else entities[0].class_
        self.filters, self.ordering, self.limit_count, self.grouping = (), (), None, None

    def _copy(self, **changes):
        query = FixtureQuery.__new__(FixtureQuery)
        query.__dict__.update(self.__dict__, **changes)
        return query

    def filter(self, *conditions):
        return self._copy(filters=self.filters + conditions)

    def order_by(self, *columns):
        return self._copy(ordering=columns)

    def limit(self, count):
        return self._copy(limit_count=count)

    def group_by(self, column):
        return self._copy(grouping=column)

    @staticmethod
    def _value(rows, expression):
        """Evaluate a selected/ordered column or min/max aggregate over a group of rows."""
        expression = getattr(expression, "element", expression) if expression.__class__.__name__ == "Label" else expression
        name = getattr(expression, "name", None)
        if name in ("min", "max"):
            key = list(expression.clauses)[0].key
            values = [getattr(row, key) for row in rows if getattr(row, key) is not None]
            return (min if name == "min" else max)(values, default=None)
        return getattr(rows[0], expression.key)

    def with_for_update(self):
        self.rows.locked_models.append(self.model)
        return self

    def all(self):
        result = []
        for row in self.rows.data.get(self.model, []):
            def replace_exists(expression, row=row):
                if not isinstance(expression, Exists):
                    return None
                statement = expression.element.element
                model = statement.column_descriptions[0]["entity"]

                def bind_outer(column):
                    if getattr(column, "table", None) is self.model.__table__:
                        return literal(getattr(row, column.key))
                    return None

                conditions = visitors.replacement_traverse(and_(*statement._where_criteria), {}, bind_outer)
                matches = _EvaluatorCompiler(model).process(conditions)
                return literal(any(matches(related) for related in self.rows.data.get(model, [])))

            conditions = visitors.replacement_traverse(and_(*self.filters), {}, replace_exists)
            if _EvaluatorCompiler(self.model).process(conditions)(row):
                result.append(row)
        groups = [[row] for row in result]
        if self.grouping is not None:
            keyed = {}
            for row in result:
                keyed.setdefault(getattr(row, self.grouping.key), []).append(row)
            groups = list(keyed.values())
        for column in reversed(self.ordering):
            descending = getattr(column, "modifier", None) is operators.desc_op
            expression = column.element if descending else column
            groups.sort(key=lambda group: self._value(group, expression), reverse=descending)
        if self.limit_count is not None:
            groups = groups[:self.limit_count]
        if not self.entities:
            return [group[0] for group in groups]
        return [tuple(self._value(group, entity) for entity in self.entities) for group in groups]

    def first(self):
        return next(iter(self.all()), None)

    def update(self, values, **kwargs):
        rows = self.all()
        self.rows.updates.append(self)
        for row in rows:
            for key, value in values.items():
                setattr(row, key, value)
        return len(rows)


@pytest.fixture
def queue(client, mock_db):
    user = User(id=uuid.uuid4(), is_superadmin=True, status=UserStatus.active, deleted_at=None)
    project = Project(id=uuid.uuid4(), is_public=False, project_folder_id=None, deleted_at=None)
    asset = Asset(id=uuid.uuid4(), project_id=project.id, asset_type=AssetType.video, deleted_at=None)
    version = AssetVersion(id=uuid.uuid4(), asset_id=asset.id, processing_status=ProcessingStatus.ready, deleted_at=None)
    media = MediaFile(id=uuid.uuid4(), version_id=version.id, mime_type="video/mp4")
    member = ProjectMember(id=uuid.uuid4(), project_id=project.id, user_id=user.id, role=ProjectRole.owner, deleted_at=None)
    state = SimpleNamespace(data={Project: [project], Asset: [asset], AssetVersion: [version], MediaFile: [media],
                                 ProjectMember: [member], ClipRenderJob: [], Comment: [], ClipRunnerToken: [], User: [user]},
                            locked_models=[], updates=[], client=client, db=mock_db,
                            user=user, project=project, asset=asset, version=version, media=media, member=member)
    mock_db.query.side_effect = lambda *entities: FixtureQuery(state, *entities)

    def add(row):
        if isinstance(row, ClipRenderJob):
            row.id = row.id or uuid.uuid4()
            row.created_at = row.created_at or datetime.now(timezone.utc)
        state.data.setdefault(type(row), []).append(row)

    mock_db.add.side_effect = add
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_clip_runner_actor] = lambda: ClipRunnerActor(uuid.uuid4(), user)

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
                  created_at=NOW, claim_id=None, claimed_at=None, finished_at=None, clips_rendered=None, message=None, deleted_at=None)
    values.update(kwargs)
    if values["status"] == "claimed" and "claim_id" not in kwargs:
        values["claim_id"] = uuid.uuid4()
    row = ClipRenderJob(**values)
    queue.jobs.append(row)
    return row


@pytest.mark.parametrize("role", [ProjectRole.owner, ProjectRole.editor])
def test_owner_and_editor_can_queue_only_the_locked_snapshot(queue, role):
    queue.member.role = role
    response = queue.create()
    assert response.status_code == 201
    ranges = [{"comment_id": str(c.id), "number": n, "start": c.timecode_start, "end": c.timecode_end}
              for n, c in [(1, queue.comments[0]), (2, queue.comments[2])]]
    assert response.json()["ranges"] == ranges
    assert response.json()["status"] == "queued"
    assert response.json()["ranges_hash"] == hashlib.sha256(
        json.dumps(ranges, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    assert queue.locked_models == [AssetVersion]


@pytest.mark.parametrize("role", [ProjectRole.viewer, ProjectRole.reviewer, None])
@pytest.mark.parametrize("is_public", [False, True])
def test_viewer_reviewer_and_nonmember_cannot_manage_jobs(queue, role, is_public):
    queue.project.is_public = is_public
    if role is None:
        queue.data[ProjectMember].clear()
    else:
        queue.member.role = role
    row = job(queue)
    assert queue.create().status_code == 403
    assert queue.latest().status_code == 403
    assert queue.client.post(f"/clip-render-jobs/{row.id}/cancel").status_code == 403
    assert row.status == "queued"


@pytest.mark.parametrize("change", ["asset_missing", "asset_deleted", "version_missing", "wrong_asset", "version_deleted", "audio", "processing",
                                    "media_missing", "media_other_version", "media_not_video"])
def test_requires_an_existing_ready_video_version_of_this_asset(queue, change):
    if change == "asset_missing":
        queue.data[Asset].clear()
    if change == "asset_deleted":
        queue.asset.deleted_at = NOW
    if change == "version_missing":
        queue.data[AssetVersion].clear()
    if change == "wrong_asset":
        queue.version.asset_id = uuid.uuid4()
    if change == "version_deleted":
        queue.version.deleted_at = NOW
    if change == "audio":
        queue.asset.asset_type = AssetType.audio
    if change == "processing":
        queue.version.processing_status = ProcessingStatus.processing
    if change == "media_missing":
        queue.data[MediaFile].clear()
    if change == "media_other_version":
        queue.media.version_id = uuid.uuid4()
    if change == "media_not_video":
        queue.media.mime_type = "image/jpeg"
    response = queue.create()
    assert response.status_code == (404 if change.startswith("asset_") else 409)
    assert queue.jobs == []


def test_no_locked_ranges_has_a_distinct_conflict_code(queue):
    for comment in queue.comments:
        comment.locked_at = None
    response = queue.create()
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "no_locked_ranges"


@pytest.mark.parametrize("start,end", [(-1, 2), (3, 3), (3, 2),
                                      (float("nan"), 2), (1, float("nan")),
                                      (float("inf"), 2), (1, float("inf")),
                                      (float("-inf"), 2), (1, float("-inf"))])
def test_invalid_locked_ranges_are_conflicts_before_hashing(queue, start, end):
    queue.comments[0].timecode_start = start
    queue.comments[0].timecode_end = end
    response = queue.create()
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "invalid_range"
    assert "must have finite timecodes" in response.json()["detail"]["message"]
    assert response.json()["detail"]["comment_id"] == str(queue.comments[0].id)
    assert queue.jobs == []
    queue.db.commit.assert_not_called()


@pytest.mark.parametrize("start,end", [(-1, 2), (3, 3), (3, 2),
                                      (float("nan"), 2), (1, float("nan")),
                                      (float("inf"), 2), (1, float("inf")),
                                      (float("-inf"), 2), (1, float("-inf"))])
def test_worker_range_schema_rejects_invalid_timecodes(start, end):
    with pytest.raises(ValidationError):
        ClipRenderRange(comment_id=uuid.uuid4(), number=1, start=start, end=end)


def test_any_text_counts_and_clips_are_numbered_by_start_time(queue):
    queue.data[Comment].clear()
    late = queue.comment(9, body="hook", timecode_start=50.0, timecode_end=55.0)
    early = queue.comment(9, body="2", timecode_start=10.0, timecode_end=15.0)
    middle = queue.comment(9, body="Clip 7", timecode_start=30.0, timecode_end=35.0)
    unlocked = queue.comment(9, body="maybe", timecode_start=40.0, timecode_end=45.0, locked_at=None)
    assert queue.create().status_code == 201
    assert [(item["comment_id"], item["number"]) for item in queue.jobs[0].ranges] == [
        (str(early.id), 1), (str(middle.id), 2), (str(late.id), 3)]
    latest = queue.latest().json()
    assert (latest["locked_count"], latest["range_count"]) == (3, 4)
    assert str(unlocked.id) not in [item["comment_id"] for item in queue.jobs[0].ranges]


def test_locked_ranges_with_the_same_text_are_not_a_conflict(queue):
    queue.data[Comment].clear()
    first = queue.comment(9, body="clip", timecode_start=20.0, timecode_end=25.0)
    second = queue.comment(9, body="clip", timecode_start=5.0, timecode_end=8.0)
    assert queue.create().status_code == 201
    assert [(item["comment_id"], item["number"]) for item in queue.jobs[0].ranges] == [
        (str(second.id), 1), (str(first.id), 2)]


def test_more_locked_ranges_than_the_runner_can_number_are_a_conflict(queue):
    many = [SimpleNamespace(id=uuid.uuid4(), locked_at=NOW, timecode_start=float(n), timecode_end=float(n) + 1)
            for n in range(1000)]
    assert len(locked_snapshot(many[:999])[0]) == 999
    with pytest.raises(HTTPException) as caught:
        locked_snapshot(many)
    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "too_many_ranges"


def test_a_new_earlier_range_renumbers_the_clips_and_allows_another_render(queue):
    job(queue, status="done")
    earlier = queue.comment(9, timecode_start=1.0, timecode_end=2.0)
    assert queue.create().status_code == 201
    numbers = {item["comment_id"]: item["number"] for item in queue.jobs[-1].ranges}
    assert numbers[str(earlier.id)] == 1
    assert numbers[str(queue.comments[0].id)] == 2


def test_ranges_that_start_together_get_a_stable_order(queue):
    queue.data[Comment].clear()
    longer = queue.comment(9, timecode_start=10.0, timecode_end=20.0)
    shorter = queue.comment(9, timecode_start=10.0, timecode_end=14.0)
    ranges, digest = locked_snapshot([longer, shorter])
    assert [item["comment_id"] for item in ranges] == [str(shorter.id), str(longer.id)]
    assert locked_snapshot([shorter, longer]) == (ranges, digest)


def test_valid_ranges_can_start_at_zero_and_invalid_unlocked_ranges_are_skipped(queue):
    queue.comments[0].timecode_start = 0
    queue.comments[1].timecode_start = float("nan")
    response = queue.create()
    assert response.status_code == 201
    assert response.json()["ranges"][0]["start"] == 0
    assert ClipRenderRange.model_validate(response.json()["ranges"][0]).start == 0


@pytest.mark.parametrize("excluded", [dict(resolved=True), dict(deleted_at=NOW), dict(parent_id=uuid.uuid4()),
                                      dict(asset_id=uuid.uuid4()), dict(version_id=uuid.uuid4()),
                                      dict(timecode_start=None), dict(timecode_end=None)])
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


def test_create_retires_every_expired_claim_before_queueing_replacement(queue):
    expired = [job(queue, status="claimed", claimed_at=datetime.now(timezone.utc) - timedelta(minutes=age))
               for age in (91, 180)]
    before = datetime.now(timezone.utc)
    assert queue.create().status_code == 201
    for row in expired:
        assert row.status == "failed"
        assert row.message == "Render lease expired"
        assert row.finished_at >= before
        response = queue.client.post(f"/runner/clip-render-jobs/{row.id}/finish", json={
            "claim_id": str(row.claim_id), "status": "done", "clips_rendered": 2, "message": "late",
        })
        assert response.status_code == 409
        assert queue.client.post(f"/runner/clip-render-jobs/{row.id}/claim").status_code == 409
    listed = queue.client.get("/runner/clip-render-jobs").json()
    assert [row["id"] for row in listed] == [str(queue.jobs[-1].id)]
    assert queue.locked_models == [AssetVersion]


@pytest.mark.parametrize("change", ["other_project", "other_version", "deleted"])
def test_create_does_not_retire_expired_claims_outside_its_version(queue, change):
    row = job(queue, status="claimed", claimed_at=datetime.now(timezone.utc) - timedelta(minutes=91))
    if change == "other_project":
        row.project_id = uuid.uuid4()
    if change == "other_version":
        row.version_id = uuid.uuid4()
    if change == "deleted":
        row.deleted_at = NOW
    assert queue.create().status_code == 201
    assert row.status == "claimed" and row.finished_at is None


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


@pytest.mark.parametrize("role", [ProjectRole.owner, ProjectRole.editor])
def test_latest_is_readable_by_owners_and_editors_and_uses_active_tokens_only(queue, role):
    queue.member.role = role
    older = job(queue, created_at=NOW - timedelta(days=1))
    newest = job(queue, created_at=NOW + timedelta(minutes=1))
    job(queue, created_at=NOW + timedelta(days=1), version_id=uuid.uuid4())
    job(queue, created_at=NOW + timedelta(days=1), deleted_at=NOW)
    runner_token(queue, last_used_at=NOW - timedelta(minutes=1))
    runner_token(queue, last_used_at=NOW)
    runner_token(queue, revoked_at=NOW, last_used_at=NOW + timedelta(days=1))
    response = queue.latest()
    assert response.status_code == 200
    result = response.json()
    assert result["job"]["id"] == str(newest.id) != str(older.id)
    assert (result["locked_count"], result["range_count"]) == (2, 3)
    assert datetime.fromisoformat(result["worker_last_seen_at"]) == NOW


def runner_token(queue, creator=None, **kwargs):
    values = dict(id=uuid.uuid4(), name="Mac clip runner", secret_hash="0" * 64, created_by=(creator or queue.user).id,
                  created_at=NOW - timedelta(days=1), last_used_at=NOW, revoked_at=None,
                  expires_at=datetime.now(timezone.utc) + timedelta(days=30))
    values.update(kwargs)
    row = ClipRunnerToken(**values)
    queue.data[ClipRunnerToken].append(row)
    return row


def other_user(queue, role=None, **kwargs):
    values = dict(id=uuid.uuid4(), is_superadmin=True, status=UserStatus.active, deleted_at=None)
    values.update(kwargs)
    user = User(**values)
    queue.data[User].append(user)
    if role is not None:
        queue.data[ProjectMember].append(ProjectMember(id=uuid.uuid4(), project_id=queue.project.id, user_id=user.id,
                                                       role=role, deleted_at=None))
    return user


@pytest.mark.parametrize("excluded", ["revoked", "expired", "other_project_creator", "viewer_creator", "reviewer_creator",
                                      "public_project_only", "creator_deactivated", "creator_deleted", "creator_not_superadmin",
                                      "creator_missing", "never_used"])
def test_last_seen_counts_only_live_runner_tokens_whose_creator_can_edit_this_project(queue, excluded):
    runner_token(queue, last_used_at=NOW - timedelta(hours=1))
    newer = NOW + timedelta(minutes=5)
    if excluded == "revoked":
        runner_token(queue, last_used_at=newer, revoked_at=NOW)
    if excluded == "expired":
        runner_token(queue, last_used_at=newer, expires_at=datetime.now(timezone.utc) - timedelta(seconds=1))
    if excluded == "other_project_creator":
        creator = other_user(queue)
        queue.data[ProjectMember].append(ProjectMember(id=uuid.uuid4(), project_id=uuid.uuid4(), user_id=creator.id,
                                                       role=ProjectRole.owner, deleted_at=None))
        runner_token(queue, creator, last_used_at=newer)
    if excluded == "viewer_creator":
        runner_token(queue, other_user(queue, ProjectRole.viewer), last_used_at=newer)
    if excluded == "reviewer_creator":
        runner_token(queue, other_user(queue, ProjectRole.reviewer), last_used_at=newer)
    if excluded == "public_project_only":
        queue.project.is_public = True
        runner_token(queue, other_user(queue), last_used_at=newer)
    if excluded == "creator_deactivated":
        runner_token(queue, other_user(queue, ProjectRole.owner, status=UserStatus.deactivated), last_used_at=newer)
    if excluded == "creator_deleted":
        runner_token(queue, other_user(queue, ProjectRole.owner, deleted_at=NOW), last_used_at=newer)
    if excluded == "creator_not_superadmin":
        runner_token(queue, other_user(queue, ProjectRole.owner, is_superadmin=False), last_used_at=newer)
    if excluded == "creator_missing":
        runner_token(queue, User(id=uuid.uuid4()), last_used_at=newer)
    if excluded == "never_used":
        runner_token(queue, last_used_at=None)
    seen = queue.latest().json()["worker_last_seen_at"]
    assert datetime.fromisoformat(seen) == NOW - timedelta(hours=1)


@pytest.mark.parametrize("role", [ProjectRole.owner, ProjectRole.editor])
def test_last_seen_uses_the_newest_eligible_token_of_any_editing_creator(queue, role):
    runner_token(queue, last_used_at=NOW - timedelta(hours=1))
    runner_token(queue, other_user(queue, role), last_used_at=NOW + timedelta(minutes=5))
    assert datetime.fromisoformat(queue.latest().json()["worker_last_seen_at"]) == NOW + timedelta(minutes=5)


def test_project_automation_tokens_no_longer_count_as_runner_last_seen(queue):
    from apps.api.models.automation_token import ProjectAutomationToken
    queue.data[ProjectAutomationToken] = [ProjectAutomationToken(id=uuid.uuid4(), project_id=queue.project.id, revoked_at=None,
                                                                 deleted_at=None, last_used_at=NOW)]
    assert queue.latest().json()["worker_last_seen_at"] is None


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
    response = queue.client.get("/runner/clip-render-jobs")
    assert response.status_code == 200
    result = response.json()
    assert {row["id"] for row in result} == {str(queued.id), str(expired.id)}
    for row in result:
        assert set(row) == {"id", "asset_id", "version_id", "ranges", "created_at"}
        for clip in row["ranges"]:
            assert set(clip) == {"comment_id", "number", "start", "end"}


@pytest.mark.parametrize("change", ["other_project", "deleted", "missing", "asset_deleted", "version_deleted",
                                    "asset_missing", "version_missing"])
def test_worker_claim_and_finish_hide_out_of_scope_jobs(queue, change):
    row = job(queue, status="claimed")
    if change == "other_project":
        row.project_id = uuid.uuid4()
    if change == "deleted":
        row.deleted_at = NOW
    if change == "missing":
        queue.jobs.clear()
    if change == "asset_deleted":
        queue.asset.deleted_at = NOW
    if change == "version_deleted":
        queue.version.deleted_at = NOW
    if change == "asset_missing":
        queue.data[Asset].clear()
    if change == "version_missing":
        queue.data[AssetVersion].clear()
    assert queue.client.get("/runner/clip-render-jobs").json() == []
    assert queue.client.post(f"/runner/clip-render-jobs/{row.id}/claim").status_code == 404
    assert queue.client.post(f"/runner/clip-render-jobs/{row.id}/finish", json={"claim_id": str(row.claim_id), "status": "done", "clips_rendered": 2, "message": "ok"}).status_code == 404
    assert queue.client.post(f"/runner/clip-render-jobs/{row.id}/progress", json={"claim_id": str(row.claim_id), "clips_rendered": 1}).status_code == 404
    assert queue.updates == []


@pytest.mark.parametrize("entity", [Asset, AssetVersion])
def test_worker_list_excludes_queued_and_expired_jobs_of_deleted_media(queue, entity):
    job(queue)
    job(queue, status="claimed", claimed_at=datetime.now(timezone.utc) - timedelta(minutes=91))
    queue.data[entity][0].deleted_at = NOW
    response = queue.client.get("/runner/clip-render-jobs")
    assert response.status_code == 200 and response.json() == []


def test_exactly_one_of_two_sequential_claims_wins(queue):
    row = job(queue)
    first = queue.client.post(f"/runner/clip-render-jobs/{row.id}/claim")
    second = queue.client.post(f"/runner/clip-render-jobs/{row.id}/claim")
    assert (first.status_code, second.status_code) == (200, 409)
    assert row.status == "claimed" and row.claimed_at is not None
    assert set(first.json()) == {"id", "asset_id", "version_id", "ranges", "created_at", "claim_id", "processing_status"}
    assert uuid.UUID(first.json()["claim_id"]) == row.claim_id
    assert first.json()["processing_status"] == "ready"


@pytest.mark.parametrize("age,expected", [(89, 409), (91, 200)])
def test_claimed_jobs_can_only_be_reclaimed_after_the_lease(queue, age, expected):
    previous = datetime.now(timezone.utc) - timedelta(minutes=age)
    row = job(queue, status="claimed", claimed_at=previous)
    assert queue.client.post(f"/runner/clip-render-jobs/{row.id}/claim").status_code == expected
    assert (row.claimed_at > previous) == (expected == 200)


def test_reclaim_changes_claim_id_and_only_the_new_runner_can_finish(queue):
    row = job(queue)
    first = queue.client.post(f"/runner/clip-render-jobs/{row.id}/claim").json()
    row.claimed_at = datetime.now(timezone.utc) - timedelta(minutes=91)
    second = queue.client.post(f"/runner/clip-render-jobs/{row.id}/claim").json()
    assert first["claim_id"] != second["claim_id"]
    before = row.claimed_at
    payload = {"claim_id": first["claim_id"], "status": "done", "clips_rendered": 2, "message": "stale"}
    response = queue.client.post(f"/runner/clip-render-jobs/{row.id}/finish", json=payload)
    assert response.status_code == 409
    assert row.status == "claimed" and row.claimed_at == before and row.finished_at is None
    payload["claim_id"] = second["claim_id"]
    response = queue.client.post(f"/runner/clip-render-jobs/{row.id}/finish", json=payload)
    assert response.status_code == 200
    assert response.json() == {"id": str(row.id), "clips_rendered": 2}


def test_browser_responses_never_expose_claim_id(queue):
    created = queue.create()
    assert "claim_id" not in created.json()
    row = queue.jobs[0]
    assert row.claim_id is None
    assert queue.client.post(f"/runner/clip-render-jobs/{row.id}/claim").status_code == 200
    assert "claim_id" not in queue.latest().json()["job"]
    queued = job(queue, claim_id=uuid.uuid4())
    assert "claim_id" not in queue.client.post(f"/clip-render-jobs/{queued.id}/cancel").json()


@pytest.mark.parametrize("status", ["done", "failed", "cancelled"])
def test_terminal_jobs_cannot_be_claimed(queue, status):
    row = job(queue, status=status)
    assert queue.client.post(f"/runner/clip-render-jobs/{row.id}/claim").status_code == 409


@pytest.mark.parametrize("action", ["claim", "finish"])
@pytest.mark.parametrize("change", ["project", "project_deleted", "deleted", "asset_deleted", "version_deleted"])
def test_worker_conditional_update_rechecks_scope_after_lookup(queue, action, change):
    row = job(queue, status="queued" if action == "claim" else "claimed")
    query = queue.db.query.side_effect
    count = 0

    def concurrent_change(model):
        nonlocal count
        if model is ClipRenderJob:
            count += 1
            if count == 2:
                if change == "project":
                    row.project_id = uuid.uuid4()
                if change == "project_deleted":
                    queue.project.deleted_at = NOW
                if change == "deleted":
                    row.deleted_at = NOW
                if change == "asset_deleted":
                    queue.asset.deleted_at = NOW
                if change == "version_deleted":
                    queue.version.deleted_at = NOW
        return query(model)

    queue.db.query.side_effect = concurrent_change
    body = {"claim_id": str(row.claim_id), "status": "done", "clips_rendered": 2, "message": ""} if action == "finish" else None
    response = queue.client.post(f"/runner/clip-render-jobs/{row.id}/{action}", json=body)
    assert response.status_code == 409
    assert row.status == ("queued" if action == "claim" else "claimed")


def test_finish_conditional_update_rechecks_claim_id_after_lookup(queue):
    row = job(queue, status="claimed")
    claim_id = row.claim_id
    query = queue.db.query.side_effect
    count = 0

    def concurrent_claim(model):
        nonlocal count
        if model is ClipRenderJob:
            count += 1
            if count == 2:
                row.claim_id = uuid.uuid4()
        return query(model)

    queue.db.query.side_effect = concurrent_claim
    response = queue.client.post(f"/runner/clip-render-jobs/{row.id}/finish", json={
        "claim_id": str(claim_id), "status": "done", "clips_rendered": 2, "message": "stale",
    })
    assert response.status_code == 409
    assert row.status == "claimed" and row.finished_at is None and row.clips_rendered is None


@pytest.mark.parametrize("status", ["queued", "claimed", "done", "failed", "cancelled"])
@pytest.mark.parametrize("result", ["done", "failed"])
def test_finish_only_from_claimed_and_caps_the_message(queue, status, result):
    row = job(queue, status=status)
    payload = {"claim_id": str(row.claim_id or uuid.uuid4()), "status": result, "clips_rendered": 2, "message": "<script>unsafe</script>" * 30}
    response = queue.client.post(f"/runner/clip-render-jobs/{row.id}/finish", json=payload)
    assert response.status_code == (200 if status == "claimed" else 409)
    if status == "claimed":
        assert response.json() == {"id": str(row.id), "clips_rendered": 2}
        assert len(row.message) == 300 and row.finished_at is not None
        assert queue.client.post(f"/runner/clip-render-jobs/{row.id}/finish", json=payload).status_code == 409


@pytest.mark.parametrize("count", [0, 1, 3])
def test_done_requires_exactly_the_snapshot_clip_count(queue, count):
    row = job(queue, status="claimed")
    response = queue.client.post(f"/runner/clip-render-jobs/{row.id}/finish", json={
        "claim_id": str(row.claim_id), "status": "done", "clips_rendered": count, "message": "partial",
    })
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "incomplete_render"
    assert row.status == "claimed" and row.finished_at is None and row.clips_rendered is None
    assert queue.updates == []
    queue.db.commit.assert_not_called()


@pytest.mark.parametrize("count", [0, 1, 2, 3])
def test_failed_count_cannot_exceed_the_snapshot_and_failure_allows_retry(queue, count):
    row = job(queue, status="claimed")
    response = queue.client.post(f"/runner/clip-render-jobs/{row.id}/finish", json={
        "claim_id": str(row.claim_id), "status": "failed", "clips_rendered": count, "message": "stopped",
    })
    assert response.status_code == (200 if count <= 2 else 422)
    assert row.status == ("failed" if count <= 2 else "claimed")
    if count <= 2:
        assert queue.create().status_code == 201


def progress(queue, row, count, claim_id=None):
    return queue.client.post(f"/runner/clip-render-jobs/{row.id}/progress", json={
        "claim_id": str(claim_id or row.claim_id), "clips_rendered": count,
    })


def test_progress_only_counts_up_and_a_lower_report_is_a_harmless_no_op(queue):
    row = job(queue, status="claimed")
    assert row.clips_rendered is None
    for reported, stored in [(0, 0), (1, 1), (2, 2), (1, 2), (2, 2)]:
        response = progress(queue, row, reported)
        assert response.status_code == 200
        assert response.json() == {"id": str(row.id), "clips_rendered": stored}
        assert row.clips_rendered == stored
    assert row.status == "claimed" and row.finished_at is None


@pytest.mark.parametrize("count", [3, 999])
def test_progress_cannot_exceed_the_snapshot_clip_count(queue, count):
    row = job(queue, status="claimed")
    response = progress(queue, row, count)
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_clip_count"
    assert row.clips_rendered is None and queue.updates == []
    queue.db.commit.assert_not_called()


@pytest.mark.parametrize("count", [-1, 1000, 1.5, "1", True, None])
def test_progress_count_must_be_a_strict_integer_in_range(queue, count):
    row = job(queue, status="claimed")
    assert progress(queue, row, count).status_code == 422
    assert row.clips_rendered is None and queue.updates == []


def test_progress_requires_the_current_claim(queue):
    row = job(queue, status="claimed")
    assert progress(queue, row, 1, claim_id=uuid.uuid4()).status_code == 409
    assert row.clips_rendered is None and queue.updates == []


@pytest.mark.parametrize("status", ["queued", "done", "failed", "cancelled"])
def test_progress_is_refused_unless_the_job_is_claimed(queue, status):
    row = job(queue, status=status, clips_rendered=1)
    assert progress(queue, row, 2, claim_id=row.claim_id or uuid.uuid4()).status_code == 409
    assert row.clips_rendered == 1 and queue.updates == []


def test_progress_after_a_reclaim_from_the_old_runner_cannot_move_the_new_count(queue):
    row = job(queue)
    first = queue.client.post(f"/runner/clip-render-jobs/{row.id}/claim").json()
    assert progress(queue, row, 2, claim_id=first["claim_id"]).status_code == 200
    row.claimed_at = datetime.now(timezone.utc) - timedelta(minutes=91)
    second = queue.client.post(f"/runner/clip-render-jobs/{row.id}/claim").json()
    assert row.clips_rendered is None
    assert progress(queue, row, 2, claim_id=first["claim_id"]).status_code == 409
    assert row.clips_rendered is None
    assert progress(queue, row, 1, claim_id=second["claim_id"]).status_code == 200
    assert row.clips_rendered == 1


def test_progress_conditional_update_rechecks_claim_id_after_lookup(queue):
    row = job(queue, status="claimed")
    claim_id = row.claim_id
    query = queue.db.query.side_effect
    count = 0

    def concurrent_claim(model):
        nonlocal count
        if model is ClipRenderJob:
            count += 1
            if count == 2:
                row.claim_id = uuid.uuid4()
        return query(model)

    queue.db.query.side_effect = concurrent_claim
    assert progress(queue, row, 1, claim_id=claim_id).status_code == 409
    assert row.clips_rendered is None


def test_progress_conditional_update_cannot_touch_a_job_that_finished_after_lookup(queue):
    row = job(queue, status="claimed")
    query = queue.db.query.side_effect
    count = 0

    def concurrent_finish(model):
        nonlocal count
        if model is ClipRenderJob:
            count += 1
            if count == 2:
                row.status = "done"
        return query(model)

    queue.db.query.side_effect = concurrent_finish
    assert progress(queue, row, 1).status_code == 409
    assert row.clips_rendered is None


@pytest.mark.parametrize("change", ["asset_deleted", "version_deleted", "project_deleted", "job_deleted"])
def test_progress_after_the_media_is_deleted_mid_request_is_a_409_not_a_server_error(queue, change):
    row = job(queue, status="claimed")
    query = queue.db.query.side_effect
    count = 0

    def concurrent_delete(model):
        nonlocal count
        if model is ClipRenderJob:
            count += 1
            if count == 2:
                if change == "asset_deleted":
                    queue.asset.deleted_at = NOW
                if change == "version_deleted":
                    queue.version.deleted_at = NOW
                if change == "project_deleted":
                    queue.project.deleted_at = NOW
                if change == "job_deleted":
                    row.deleted_at = NOW
        return query(model)

    queue.db.query.side_effect = concurrent_delete
    assert progress(queue, row, 1).status_code == 409
    assert row.clips_rendered is None


def test_latest_job_exposes_progress_and_clip_total_to_the_browser(queue):
    row = job(queue, status="claimed")
    assert progress(queue, row, 1).status_code == 200
    latest = queue.latest().json()["job"]
    assert latest["clips_rendered"] == 1 and len(latest["ranges"]) == 2
    assert "claim_id" not in latest


def test_incomplete_done_can_be_reported_as_failed_and_retried(queue):
    row = job(queue, status="claimed")
    payload = {"claim_id": str(row.claim_id), "status": "done", "clips_rendered": 1, "message": "partial"}
    assert queue.client.post(f"/runner/clip-render-jobs/{row.id}/finish", json=payload).status_code == 422
    payload["status"] = "failed"
    assert queue.client.post(f"/runner/clip-render-jobs/{row.id}/finish", json=payload).status_code == 200
    assert queue.create().status_code == 201


@pytest.mark.parametrize("count", [1000, 2**40])
def test_finish_count_cap_rejects_large_integers_before_querying(queue, count):
    row = job(queue, status="claimed")
    response = queue.client.post(f"/runner/clip-render-jobs/{row.id}/finish", json={
        "claim_id": str(row.claim_id), "status": "failed", "clips_rendered": count, "message": "",
    })
    assert response.status_code == 422
    assert response.json()["detail"][0]["type"] == "less_than_equal"
    assert response.json()["detail"][0]["loc"] == ["body", "clips_rendered"]
    queue.db.query.assert_not_called()
    assert row.status == "claimed"


@pytest.mark.parametrize("claim", [None, "not-a-uuid"])
def test_finish_requires_a_valid_claim_id(queue, claim):
    row = job(queue, status="claimed")
    payload = {"status": "done", "clips_rendered": 2, "message": ""}
    if claim is not None:
        payload["claim_id"] = claim
    assert queue.client.post(f"/runner/clip-render-jobs/{row.id}/finish", json=payload).status_code == 422
    assert row.status == "claimed"


@pytest.mark.parametrize("payload", [{"status": "queued", "clips_rendered": 0, "message": ""},
                                     {"status": "done", "clips_rendered": -1, "message": ""},
                                     {"status": "done", "clips_rendered": True, "message": ""}])
def test_invalid_finish_payloads_are_rejected(queue, payload):
    row = job(queue, status="claimed")
    payload = {"claim_id": str(row.claim_id), **payload}
    assert queue.client.post(f"/runner/clip-render-jobs/{row.id}/finish", json=payload).status_code == 422
    assert row.status == "claimed"


def test_worker_endpoints_require_runner_auth(queue):
    app.dependency_overrides.pop(get_clip_runner_actor)
    row = job(queue)
    assert queue.client.get("/runner/clip-render-jobs").status_code == 401
    assert queue.client.post(f"/runner/clip-render-jobs/{row.id}/claim").status_code == 401
    assert queue.client.post(f"/runner/clip-render-jobs/{row.id}/finish", json={"claim_id": str(uuid.uuid4()), "status": "done", "clips_rendered": 2, "message": ""}).status_code == 401


def test_user_endpoints_require_session_auth(queue):
    app.dependency_overrides.pop(get_current_user)
    row = job(queue)
    assert queue.create().status_code == 401
    assert queue.latest().status_code == 401
    assert queue.client.post(f"/clip-render-jobs/{row.id}/cancel").status_code == 401


def test_clip_render_job_migration_compiles_upgrade_and_downgrade():
    api = Path(__file__).resolve().parents[1]
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
    assert "claim_id UUID" in output and "claim_id UUID NOT NULL" not in output
    for column, table in [("project_id", "projects"), ("asset_id", "assets"),
                          ("version_id", "asset_versions"), ("requested_by", "users")]:
        assert f"FOREIGN KEY({column}) REFERENCES {table} (id) ON DELETE CASCADE" in output
    assert set(ClipRenderJob.__table__.columns.keys()) == {"id", "project_id", "asset_id", "version_id", "requested_by", "status", "ranges", "ranges_hash", "clips_rendered", "message", "created_at", "claim_id", "claimed_at", "finished_at", "deleted_at"}
    assert ClipRenderJob.__table__.c.claim_id.nullable


@pytest.mark.parametrize("column,target", [("project_id", "projects.id"), ("asset_id", "assets.id"),
                                          ("version_id", "asset_versions.id"), ("requested_by", "users.id")])
def test_job_model_foreign_keys_cascade_on_retention_cleanup(column, target):
    foreign_key, = ClipRenderJob.__table__.c[column].foreign_keys
    assert foreign_key.target_fullname == target
    assert foreign_key.ondelete == "CASCADE"


# ── Runner scope: the creator's live role on each job's project ────────────────

def _finish_body(row):
    return {"claim_id": str(row.claim_id or uuid.uuid4()), "status": "done", "clips_rendered": 2, "message": ""}


@pytest.mark.parametrize("access", ["viewer", "reviewer", "no_role", "public_project_only", "member_deleted", "project_deleted"])
def test_runner_cannot_see_or_touch_jobs_where_the_creator_cannot_edit(queue, access):
    queued = job(queue)
    claimed = job(queue, status="claimed")
    if access == "viewer":
        queue.member.role = ProjectRole.viewer
    if access == "reviewer":
        queue.member.role = ProjectRole.reviewer
    if access == "no_role":
        queue.data[ProjectMember].clear()
    if access == "public_project_only":
        queue.data[ProjectMember].clear()
        queue.project.is_public = True
    if access == "member_deleted":
        queue.member.deleted_at = NOW
    if access == "project_deleted":
        queue.project.deleted_at = NOW
    missing = uuid.uuid4()
    assert queue.client.get("/runner/clip-render-jobs").json() == []
    hidden_claim = queue.client.post(f"/runner/clip-render-jobs/{queued.id}/claim")
    hidden_finish = queue.client.post(f"/runner/clip-render-jobs/{claimed.id}/finish", json=_finish_body(claimed))
    # A wrong claim id or a queued job must still be 404, never a revealing 409.
    hidden_wrong_claim = queue.client.post(f"/runner/clip-render-jobs/{claimed.id}/finish",
                                           json={**_finish_body(claimed), "claim_id": str(uuid.uuid4())})
    hidden_queued_finish = queue.client.post(f"/runner/clip-render-jobs/{queued.id}/finish", json=_finish_body(queued))
    missing_claim = queue.client.post(f"/runner/clip-render-jobs/{missing}/claim")
    missing_finish = queue.client.post(f"/runner/clip-render-jobs/{missing}/finish", json=_finish_body(claimed))
    # Indistinguishable from a job that does not exist.
    hidden = [hidden_claim, hidden_finish, hidden_wrong_claim, hidden_queued_finish]
    assert [(r.status_code, r.json()) for r in hidden] == [(missing_claim.status_code, missing_claim.json())] * 4
    assert missing_claim.status_code == missing_finish.status_code == 404
    assert missing_claim.json() == missing_finish.json()
    assert queue.updates == []
    assert queued.status == "queued" and claimed.status == "claimed"


def test_runner_scope_is_per_job_project_across_many_projects(queue):
    editable = job(queue)
    other_project = Project(id=uuid.uuid4(), is_public=False, project_folder_id=None, deleted_at=None)
    other_asset = Asset(id=uuid.uuid4(), project_id=other_project.id, asset_type=AssetType.video, deleted_at=None)
    other_version = AssetVersion(id=uuid.uuid4(), asset_id=other_asset.id, processing_status=ProcessingStatus.ready, deleted_at=None)
    queue.data[Project].append(other_project)
    queue.data[Asset].append(other_asset)
    queue.data[AssetVersion].append(other_version)
    queue.data[ProjectMember].append(ProjectMember(id=uuid.uuid4(), project_id=other_project.id, user_id=queue.user.id,
                                                   role=ProjectRole.viewer, deleted_at=None))
    foreign = job(queue, project_id=other_project.id, asset_id=other_asset.id, version_id=other_version.id, created_at=NOW - timedelta(days=1))
    assert [row["id"] for row in queue.client.get("/runner/clip-render-jobs").json()] == [str(editable.id)]
    assert queue.client.post(f"/runner/clip-render-jobs/{foreign.id}/claim").status_code == 404
    assert foreign.status == "queued"
    queue.data[ProjectMember][-1].role = ProjectRole.editor
    listed = [row["id"] for row in queue.client.get("/runner/clip-render-jobs").json()]
    assert listed == [str(foreign.id), str(editable.id)]


def test_creator_downgraded_after_claim_can_no_longer_finish(queue):
    queue.member.role = ProjectRole.editor
    row = job(queue)
    claim = queue.client.post(f"/runner/clip-render-jobs/{row.id}/claim")
    assert claim.status_code == 200
    queue.member.role = ProjectRole.viewer
    payload = {"claim_id": claim.json()["claim_id"], "status": "done", "clips_rendered": 2, "message": ""}
    response = queue.client.post(f"/runner/clip-render-jobs/{row.id}/finish", json=payload)
    assert response.status_code == 404
    assert row.status == "claimed" and row.finished_at is None


def test_runner_list_resolves_roles_once_per_distinct_project_and_is_capped(queue, monkeypatch):
    from apps.api.services import clip_render_jobs as service
    rows = [job(queue, created_at=NOW + timedelta(seconds=index)) for index in range(60)]
    calls = []
    real = service.get_effective_project_role
    monkeypatch.setattr(service, "get_effective_project_role", lambda db, project_id, user: calls.append(project_id) or real(db, project_id, user))
    result = queue.client.get("/runner/clip-render-jobs").json()
    assert [row["id"] for row in result] == [str(row.id) for row in rows[:50]]
    assert calls == [queue.project.id]


def _project_with_media(queue, role=None):
    project = Project(id=uuid.uuid4(), is_public=False, project_folder_id=None, deleted_at=None)
    asset = Asset(id=uuid.uuid4(), project_id=project.id, asset_type=AssetType.video, deleted_at=None)
    version = AssetVersion(id=uuid.uuid4(), asset_id=asset.id, processing_status=ProcessingStatus.ready, deleted_at=None)
    queue.data[Project].append(project)
    queue.data[Asset].append(asset)
    queue.data[AssetVersion].append(version)
    if role is not None:
        queue.data[ProjectMember].append(ProjectMember(id=uuid.uuid4(), project_id=project.id, user_id=queue.user.id,
                                                       role=role, deleted_at=None))
    return lambda **kwargs: job(queue, project_id=project.id, asset_id=asset.id, version_id=version.id, **kwargs)


def _count_role_lookups(monkeypatch):
    from apps.api.services import clip_render_jobs as service
    calls = []
    real = service.get_effective_project_role
    monkeypatch.setattr(service, "get_effective_project_role",
                        lambda db, project_id, user: calls.append(project_id) or real(db, project_id, user))
    return calls


def test_600_older_jobs_in_one_denied_project_cannot_starve_a_newer_runnable_job(queue, monkeypatch):
    calls = _count_role_lookups(monkeypatch)
    denied = _project_with_media(queue, ProjectRole.viewer)
    for index in range(600):
        denied(created_at=NOW - timedelta(days=2) + timedelta(seconds=index))
    runnable = job(queue, created_at=NOW)
    assert [row["id"] for row in queue.client.get("/runner/clip-render-jobs").json()] == [str(runnable.id)]
    assert len(calls) == 2  # one classification per project, not per job
    assert [row["id"] for row in queue.client.get("/runner/clip-render-jobs").json()] == [str(runnable.id)]  # stable


def test_many_older_denied_projects_within_the_scan_limit_do_not_starve(queue, monkeypatch):
    from apps.api.services import clip_render_jobs as service
    monkeypatch.setattr(service, "RUNNER_PROJECT_SCAN_LIMIT", 31)
    for index in range(30):
        _project_with_media(queue)(created_at=NOW - timedelta(days=1) + timedelta(seconds=index))
    runnable = job(queue, created_at=NOW)
    assert [row["id"] for row in queue.client.get("/runner/clip-render-jobs").json()] == [str(runnable.id)]


def test_project_scan_limit_is_applied_oldest_projects_first(queue, monkeypatch):
    from apps.api.services import clip_render_jobs as service
    monkeypatch.setattr(service, "RUNNER_PROJECT_SCAN_LIMIT", 30)
    calls = _count_role_lookups(monkeypatch)
    denied = [_project_with_media(queue) for _ in range(30)]
    for index, make in enumerate(denied):
        make(created_at=NOW - timedelta(days=1) + timedelta(seconds=index))
    job(queue, created_at=NOW)
    assert queue.client.get("/runner/clip-render-jobs").json() == []
    assert len(calls) == 30 and queue.project.id not in calls


def test_each_distinct_project_is_classified_once(queue, monkeypatch):
    calls = _count_role_lookups(monkeypatch)
    denied = _project_with_media(queue, ProjectRole.reviewer)
    editable = _project_with_media(queue, ProjectRole.editor)
    for index in range(40):
        (denied if index % 2 else editable)(created_at=NOW + timedelta(seconds=index))
        job(queue, created_at=NOW + timedelta(seconds=index, milliseconds=500))
    queue.client.get("/runner/clip-render-jobs")
    assert sorted(calls, key=str) == sorted({row.project_id for row in queue.jobs}, key=str)


def test_cap_and_oldest_first_hold_across_interleaved_allowed_and_denied_projects(queue):
    denied = _project_with_media(queue, ProjectRole.reviewer)
    editable = _project_with_media(queue, ProjectRole.editor)
    expected = []
    for index in range(120):
        created_at = NOW + timedelta(seconds=index)
        if index % 3 == 0:
            denied(created_at=created_at)
        else:
            expected.append(job(queue, created_at=created_at) if index % 3 == 1 else editable(created_at=created_at))
    result = [row["id"] for row in queue.client.get("/runner/clip-render-jobs").json()]
    assert result == [str(row.id) for row in expected[:50]]


def test_claim_returns_the_version_processing_status_as_a_plain_string(queue):
    queue.version.processing_status = ProcessingStatus.ready
    row = job(queue)
    body = queue.client.post(f"/runner/clip-render-jobs/{row.id}/claim").json()
    assert body["processing_status"] == "ready"
    assert type(body["processing_status"]) is str


def test_many_newer_tokens_of_an_ineligible_creator_do_not_hide_an_eligible_one(queue):
    runner_token(queue, last_used_at=NOW - timedelta(hours=3))
    viewer = other_user(queue, ProjectRole.viewer)
    for index in range(50):
        runner_token(queue, viewer, last_used_at=NOW + timedelta(minutes=index))
    assert datetime.fromisoformat(queue.latest().json()["worker_last_seen_at"]) == NOW - timedelta(hours=3)


def test_last_seen_checks_each_creator_once_and_caps_creators(queue, monkeypatch):
    from apps.api.services import clip_render_jobs as service
    calls = _count_role_lookups(monkeypatch)
    for index in range(5):
        runner_token(queue, last_used_at=NOW - timedelta(minutes=index))
    assert datetime.fromisoformat(queue.latest().json()["worker_last_seen_at"]) == NOW
    assert calls == [queue.project.id]  # five tokens, one creator, one check
    monkeypatch.setattr(service, "RUNNER_LAST_SEEN_CREATOR_LIMIT", 1)
    runner_token(queue, other_user(queue, ProjectRole.viewer), last_used_at=NOW + timedelta(minutes=1))
    assert queue.latest().json()["worker_last_seen_at"] is None
