"""PostgreSQL-backed durability races. Run only with FREEFRAME_REAL_POSTGRES=1."""
import os
import threading
import uuid
from datetime import datetime, timedelta, timezone

import pytest

if os.getenv("FREEFRAME_REAL_POSTGRES") != "1":
    pytest.skip("set FREEFRAME_REAL_POSTGRES=1 to run PostgreSQL durability tests", allow_module_level=True)

from apps.api.database import SessionLocal
from apps.api.models.asset import Asset, AssetType, AssetVersion, FileType, MediaFile, ProcessingOutbox, ProcessingStatus
from apps.api.models.project import Project, ProjectType
from apps.api.models.user import User
import apps.api.tasks.transcode_tasks as transcode_tasks


def _seed_version():
    db = SessionLocal()
    user = User(email=f"outbox-{uuid.uuid4()}@test.invalid", name="Outbox test")
    db.add(user)
    db.flush()
    project = Project(name="Outbox test", project_type=ProjectType.personal, created_by=user.id)
    db.add(project)
    db.flush()
    asset = Asset(project_id=project.id, name="Outbox test", asset_type=AssetType.video, created_by=user.id)
    db.add(asset)
    db.flush()
    version = AssetVersion(
        asset_id=asset.id,
        version_number=1,
        processing_status=ProcessingStatus.queued,
        created_by=user.id,
    )
    db.add(version)
    db.flush()
    outbox = ProcessingOutbox(version_id=version.id)
    db.add(outbox)
    db.add(MediaFile(
        version_id=version.id,
        file_type=FileType.video,
        original_filename="test.mp4",
        mime_type="video/mp4",
        file_size_bytes=1,
        s3_key_raw=f"raw/{version.id}/test.mp4",
    ))
    db.commit()
    ids = (user.id, project.id, asset.id, version.id)
    db.close()
    return ids


def _cleanup(ids):
    user_id, project_id, asset_id, version_id = ids
    db = SessionLocal()
    try:
        db.query(ProcessingOutbox).filter(ProcessingOutbox.version_id == version_id).delete()
        db.query(MediaFile).filter(MediaFile.version_id == version_id).delete()
        db.query(AssetVersion).filter(AssetVersion.id == version_id).delete()
        db.query(Asset).filter(Asset.id == asset_id).delete()
        db.query(Project).filter(Project.id == project_id).delete()
        db.query(User).filter(User.id == user_id).delete()
        db.commit()
    finally:
        db.close()


def test_postgres_advisory_lock_allows_only_one_worker():
    ids = _seed_version()
    version_id = ids[-1]
    barrier = threading.Barrier(2)
    release = threading.Event()
    acquired = []

    def attempt():
        connection = transcode_tasks._acquire_processing_lock(version_id)
        acquired.append(connection is not None)
        barrier.wait(timeout=5)
        release.wait(timeout=5)
        transcode_tasks._release_processing_lock(connection, version_id)

    try:
        first = threading.Thread(target=attempt)
        second = threading.Thread(target=attempt)
        first.start()
        second.start()
        first.join(timeout=5)
        second.join(timeout=5)
        release.set()
        assert sum(acquired) == 1
    finally:
        release.set()
        _cleanup(ids)


def test_postgres_dispatcher_respects_unexpired_lease(monkeypatch):
    ids = _seed_version()
    version_id = ids[-1]
    db = SessionLocal()
    try:
        row = db.query(ProcessingOutbox).filter(ProcessingOutbox.version_id == version_id).first()
        row.lease_expires_at = datetime.now(timezone.utc) + timedelta(minutes=10)
        db.commit()
    finally:
        db.close()
    published = []
    monkeypatch.setattr(transcode_tasks.process_asset, "apply_async", lambda args: published.append(args))
    try:
        assert transcode_tasks.dispatch_pending_processing.run() == 0
        assert published == []
        db = SessionLocal()
        row = db.query(ProcessingOutbox).filter(ProcessingOutbox.version_id == version_id).first()
        row.lease_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        db.commit()
        db.close()
        assert transcode_tasks.dispatch_pending_processing.run() == 1
        assert published == [(str(version_id),)]
    finally:
        _cleanup(ids)


def test_postgres_concurrent_dispatchers_claim_one_outbox_row(monkeypatch):
    ids = _seed_version()
    version_id = ids[-1]
    barrier = threading.Barrier(2)
    published = []
    results = []
    monkeypatch.setattr(transcode_tasks.process_asset, "apply_async", lambda args: published.append(args))

    def dispatch():
        barrier.wait(timeout=5)
        results.append(transcode_tasks.dispatch_pending_processing.run())

    try:
        first = threading.Thread(target=dispatch)
        second = threading.Thread(target=dispatch)
        first.start()
        second.start()
        first.join(timeout=5)
        second.join(timeout=5)
        assert sum(results) == 1
        assert published == [(str(version_id),)]
    finally:
        _cleanup(ids)


def test_postgres_locked_query_refreshes_a_preloaded_version():
    ids = _seed_version()
    version_id = ids[-1]
    first = SessionLocal()
    second = SessionLocal()
    try:
        cached = first.query(AssetVersion).filter(AssetVersion.id == version_id).first()
        assert cached.processing_status == ProcessingStatus.queued
        changed = second.query(AssetVersion).filter(AssetVersion.id == version_id).first()
        changed.processing_status = ProcessingStatus.processing
        second.commit()

        refreshed = first.query(AssetVersion).populate_existing().with_for_update().filter(
            AssetVersion.id == version_id
        ).first()
        assert refreshed.processing_status == ProcessingStatus.processing
    finally:
        first.close()
        second.close()
        _cleanup(ids)


def test_postgres_worker_retries_then_marks_ready(monkeypatch):
    ids = _seed_version()
    version_id = ids[-1]
    monkeypatch.setattr(transcode_tasks, "get_s3_client", lambda: object())
    monkeypatch.setattr(transcode_tasks, "_process_video", lambda *args: (_ for _ in ()).throw(RuntimeError("temporary")))
    try:
        transcode_tasks.process_asset.run(str(version_id))
        db = SessionLocal()
        version = db.query(AssetVersion).filter(AssetVersion.id == version_id).first()
        outbox = db.query(ProcessingOutbox).filter(ProcessingOutbox.version_id == version_id).first()
        assert version.processing_status == ProcessingStatus.queued
        assert outbox.attempt_count == 1
        db.close()

        monkeypatch.setattr(transcode_tasks, "_process_video", lambda *args: None)
        transcode_tasks.process_asset.run(str(version_id))
        db = SessionLocal()
        version = db.query(AssetVersion).filter(AssetVersion.id == version_id).first()
        outbox = db.query(ProcessingOutbox).filter(ProcessingOutbox.version_id == version_id).first()
        assert version.processing_status == ProcessingStatus.ready
        assert outbox.completed_at is not None
        db.close()
    finally:
        _cleanup(ids)


def test_postgres_expired_processing_lease_recovers_once(monkeypatch):
    ids = _seed_version()
    version_id = ids[-1]
    db = SessionLocal()
    version = db.query(AssetVersion).filter(AssetVersion.id == version_id).first()
    outbox = db.query(ProcessingOutbox).filter(ProcessingOutbox.version_id == version_id).first()
    version.processing_status = ProcessingStatus.processing
    outbox.attempt_count = 1
    outbox.lease_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    db.commit()
    db.close()
    monkeypatch.setattr(transcode_tasks, "get_s3_client", lambda: object())
    monkeypatch.setattr(transcode_tasks, "_process_video", lambda *args: None)
    try:
        transcode_tasks.process_asset.run(str(version_id))
        db = SessionLocal()
        version = db.query(AssetVersion).filter(AssetVersion.id == version_id).first()
        outbox = db.query(ProcessingOutbox).filter(ProcessingOutbox.version_id == version_id).first()
        assert version.processing_status == ProcessingStatus.ready
        assert outbox.attempt_count == 2
        db.close()
    finally:
        _cleanup(ids)
