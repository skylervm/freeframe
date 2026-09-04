"""Durable dispatch tests: queued uploads survive a lost immediate handoff."""
import uuid
from unittest.mock import MagicMock

import apps.api.tasks.transcode_tasks as transcode_tasks
from apps.api.models.asset import ProcessingStatus


def test_dispatcher_publishes_a_pending_outbox_row(monkeypatch):
    db = MagicMock()
    db.query.return_value = db
    db.join.return_value = db
    db.filter.return_value = db
    db.with_for_update.return_value = db
    row = MagicMock()
    row.version_id = uuid.uuid4()
    db.first.side_effect = [row, None]
    monkeypatch.setattr(transcode_tasks, "SessionLocal", lambda: db)
    published = []
    monkeypatch.setattr(transcode_tasks.process_asset, "apply_async", lambda args: published.append(args))

    assert transcode_tasks.dispatch_pending_processing.run() == 1
    assert published == [(str(row.version_id),)]
    assert row.dispatched_at is not None
    assert db.commit.called


def test_duplicate_worker_delivery_marks_ready_work_complete(monkeypatch):
    db = MagicMock()
    db.query.return_value = db
    db.with_for_update.return_value = db
    db.filter.return_value = db
    version = MagicMock()
    version.id = uuid.uuid4()
    version.processing_status = ProcessingStatus.ready
    db.first.return_value = version
    monkeypatch.setattr(transcode_tasks, "SessionLocal", lambda: db)
    monkeypatch.setattr(transcode_tasks, "_acquire_processing_lock", lambda _: object())
    monkeypatch.setattr(transcode_tasks, "_release_processing_lock", lambda *_: None)

    transcode_tasks.process_asset.run(str(uuid.uuid4()))

    assert db.commit.call_count == 1


def test_worker_accepts_legacy_asset_and_version_arguments(monkeypatch):
    db = MagicMock()
    db.query.return_value = db
    db.with_for_update.return_value = db
    db.filter.return_value = db
    version = MagicMock()
    version.id = uuid.uuid4()
    version.processing_status = ProcessingStatus.ready
    db.first.return_value = version
    monkeypatch.setattr(transcode_tasks, "SessionLocal", lambda: db)
    acquired_for = []
    monkeypatch.setattr(transcode_tasks, "_acquire_processing_lock", lambda value: acquired_for.append(value) or object())
    monkeypatch.setattr(transcode_tasks, "_release_processing_lock", lambda *_: None)

    transcode_tasks.process_asset.run(str(uuid.uuid4()), str(version.id))

    assert acquired_for == [version.id]
