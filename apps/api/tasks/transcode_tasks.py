import uuid
import sys
import os
import asyncio
import json
import logging
import hashlib
from datetime import datetime, timedelta, timezone

# Ensure the workspace root is on the path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))

from .celery_app import celery_app
from ..database import SessionLocal, engine
from ..models.asset import AssetVersion, MediaFile, ProcessingOutbox, ProcessingStatus, AssetType
from ..models.asset import Asset
from ..services.s3_service import get_s3_client
from ..config import settings

log = logging.getLogger("celery.transcode")
MAX_PROCESSING_ATTEMPTS = 3
RETRY_DELAY = timedelta(seconds=60)
PROCESSING_LEASE = timedelta(minutes=15)


def _run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


@celery_app.task(name="dispatch_pending_processing")
def dispatch_pending_processing():
    """Publish queued outbox rows. Rows remain recoverable until a worker completes them."""
    db = SessionLocal()
    try:
        # Old workers can finish pre-migration work without knowing its outbox
        # row exists. Mark those terminal rows complete before dispatching.
        terminal_rows = db.query(ProcessingOutbox).join(AssetVersion, AssetVersion.id == ProcessingOutbox.version_id).filter(
            ProcessingOutbox.completed_at.is_(None),
            AssetVersion.processing_status.in_([ProcessingStatus.ready, ProcessingStatus.failed]),
        ).all()
        for terminal_row in terminal_rows:
            terminal_row.completed_at = datetime.now(timezone.utc)
        db.commit()
        dispatched = 0
        while dispatched < 25:
            # Claim one row per transaction. Publishing is intentionally after
            # commit: a crash in between is recovered by the stale-dispatch sweep.
            row = (
                db.query(ProcessingOutbox)
                .join(AssetVersion, AssetVersion.id == ProcessingOutbox.version_id)
                .filter(
                    ProcessingOutbox.completed_at.is_(None),
                    AssetVersion.deleted_at.is_(None),
                    (ProcessingOutbox.next_attempt_at.is_(None) | (ProcessingOutbox.next_attempt_at <= datetime.now(timezone.utc))),
                    (
                        ((AssetVersion.processing_status == ProcessingStatus.queued) &
                         (ProcessingOutbox.lease_expires_at.is_(None) | (ProcessingOutbox.lease_expires_at < datetime.now(timezone.utc)))) |
                        ((AssetVersion.processing_status == ProcessingStatus.processing) &
                         (ProcessingOutbox.lease_expires_at.is_(None) | (ProcessingOutbox.lease_expires_at < datetime.now(timezone.utc))))
                    ),
                )
                .with_for_update(skip_locked=True)
                .first()
            )
            if not row:
                break
            row.dispatched_at = datetime.now(timezone.utc)
            row.lease_expires_at = datetime.now(timezone.utc) + PROCESSING_LEASE
            version_id = str(row.version_id)
            db.commit()
            process_asset.apply_async(args=(version_id,))
            dispatched += 1
        return dispatched
    finally:
        db.close()


def _mark_outbox_completed(db, version_id: uuid.UUID) -> None:
    row = db.query(ProcessingOutbox).filter(ProcessingOutbox.version_id == version_id).first()
    if row:
        row.completed_at = datetime.now(timezone.utc)


def _mark_processing_failed(db, version: AssetVersion, asset: Asset | None, error: str) -> None:
    version.processing_status = ProcessingStatus.failed
    _mark_outbox_completed(db, version.id)
    db.commit()
    if asset:
        _publish_event(str(asset.project_id), "transcode_failed", {
            "asset_id": str(asset.id), "error": error,
        })


def _processing_lock_key(version_id: uuid.UUID) -> int:
    """Return a stable signed bigint for PostgreSQL's session advisory lock."""
    return int.from_bytes(hashlib.sha256(version_id.bytes).digest()[:8], "big", signed=True)


def _acquire_processing_lock(version_id: uuid.UUID):
    """Hold a PostgreSQL session lock without holding a DB transaction open."""
    connection = engine.raw_connection()
    cursor = connection.cursor()
    try:
        cursor.execute("SELECT pg_try_advisory_lock(%s)", (_processing_lock_key(version_id),))
        acquired = bool(cursor.fetchone()[0])
    finally:
        cursor.close()
    if acquired:
        # Transaction-scoped work is complete, but session advisory locks survive
        # commit while this checked-out raw connection remains open.
        connection.commit()
        return connection
    connection.close()
    return None


def _release_processing_lock(connection, version_id: uuid.UUID) -> None:
    if not connection:
        return
    try:
        cursor = connection.cursor()
        try:
            cursor.execute("SELECT pg_advisory_unlock(%s)", (_processing_lock_key(version_id),))
        finally:
            cursor.close()
        connection.commit()
    finally:
        connection.close()


@celery_app.task
def process_asset(version_id_or_asset_id: str, legacy_version_id: str | None = None):
    """Main processing task dispatched after upload completes."""
    db = SessionLocal()
    version_id = legacy_version_id or version_id_or_asset_id
    parsed_version_id = uuid.UUID(version_id)
    lock_connection = None
    asset = None
    try:
        # Existing broker messages used (asset_id, version_id). Keep accepting
        # that shape until all messages created before this deployment drain.
        lock_connection = _acquire_processing_lock(parsed_version_id)
        if not lock_connection:
            return

        version = db.query(AssetVersion).with_for_update().filter(AssetVersion.id == parsed_version_id).first()
        if not version:
            return  # version already cleaned up
        if version.processing_status == ProcessingStatus.ready:
            _mark_outbox_completed(db, version.id)
            db.commit()
            return
        if version.processing_status not in (ProcessingStatus.queued, ProcessingStatus.processing):
            return
        outbox = db.query(ProcessingOutbox).with_for_update().filter(
            ProcessingOutbox.version_id == version.id,
            ProcessingOutbox.completed_at.is_(None),
        ).first()
        if not outbox:
            return
        outbox.attempt_count += 1
        outbox.lease_expires_at = datetime.now(timezone.utc) + PROCESSING_LEASE

        asset = db.query(Asset).filter(Asset.id == version.asset_id).first()
        if not asset:
            if version:
                _mark_processing_failed(db, version, None, "Asset not found")
            return

        if outbox.attempt_count > MAX_PROCESSING_ATTEMPTS:
            _mark_processing_failed(db, version, asset, "Processing retry limit reached")
            return

        media_file = db.query(MediaFile).filter(MediaFile.version_id == version.id).first()
        if not media_file:
            _mark_processing_failed(db, version, asset, "Media file not found")
            return

        # Commit the state transition before transcode. The separate advisory lock
        # serializes duplicate workers without retaining a row lock/transaction for
        # the duration of FFmpeg and S3 work.
        version.processing_status = ProcessingStatus.processing
        db.commit()

        output_prefix = f"processed/{asset.project_id}/{asset.id}/{version_id}"
        s3 = get_s3_client()

        try:
            if asset.asset_type in (AssetType.video,):
                _process_video(db, asset, version, media_file, s3, output_prefix)
            elif asset.asset_type == AssetType.audio:
                _process_audio(db, asset, version, media_file, s3, output_prefix)
            elif asset.asset_type in (AssetType.image, AssetType.image_carousel):
                _process_image(db, asset, version, media_file, s3, output_prefix)

            version = db.query(AssetVersion).with_for_update().filter(AssetVersion.id == parsed_version_id).first()
            if not version or version.processing_status == ProcessingStatus.ready:
                return
            version.processing_status = ProcessingStatus.ready
            _mark_outbox_completed(db, version.id)
            db.commit()

            # Publish SSE event (best-effort)
            _publish_event(str(asset.project_id), "transcode_complete", {
                "asset_id": str(asset.id),
                "version_id": version_id,
            })

        except Exception as exc:
            db.rollback()
            version = db.query(AssetVersion).with_for_update().filter(AssetVersion.id == parsed_version_id).first()
            if not version:
                return
            # A successful worker may have committed while this worker was
            # unwinding. Never put completed work back in the queue.
            if version.processing_status == ProcessingStatus.ready:
                _mark_outbox_completed(db, version.id)
                db.commit()
                return
            outbox = db.query(ProcessingOutbox).with_for_update().filter(
                ProcessingOutbox.version_id == version.id,
                ProcessingOutbox.completed_at.is_(None),
            ).first()
            terminal_failure = not outbox or outbox.attempt_count >= MAX_PROCESSING_ATTEMPTS
            if terminal_failure:
                _mark_processing_failed(db, version, asset, str(exc))
            else:
                version.processing_status = ProcessingStatus.queued
                outbox.next_attempt_at = datetime.now(timezone.utc) + RETRY_DELAY
                outbox.dispatched_at = None
                outbox.lease_expires_at = None
                db.commit()
            return

    finally:
        _release_processing_lock(lock_connection, parsed_version_id)
        db.close()


def _process_video(db, asset, version, media_file, s3, output_prefix):
    from packages.transcoder.ffmpeg_transcoder import FFmpegTranscoder
    from packages.transcoder.base import TranscodeJob

    transcoder = FFmpegTranscoder(s3, settings.s3_bucket, settings.s3_endpoint)
    job = TranscodeJob(
        media_id=str(asset.id),
        version_id=str(version.id),
        input_s3_key=media_file.s3_key_raw,
        output_s3_prefix=output_prefix,
        qualities=["1080p", "720p", "360p"],
    )
    result = _run_async(transcoder.transcode(job))
    if not result.success:
        raise RuntimeError(f"Transcode failed: {result.error}")

    media_file.s3_key_processed = result.hls_prefix
    if result.thumbnail_keys:
        media_file.s3_key_thumbnail = result.thumbnail_keys[0]
    if result.duration_seconds:
        media_file.duration_seconds = result.duration_seconds
    if result.width:
        media_file.width = result.width
    if result.height:
        media_file.height = result.height
    if result.fps:
        media_file.fps = result.fps
    db.flush()


def _process_audio(db, asset, version, media_file, s3, output_prefix):
    from packages.transcoder.image_processor import process_audio
    result = process_audio(s3, settings.s3_bucket, media_file.s3_key_raw, output_prefix)
    media_file.s3_key_processed = result.get("mp3_key")
    if result.get("waveform_key"):
        media_file.s3_key_thumbnail = result["waveform_key"]
    if result.get("duration_seconds"):
        media_file.duration_seconds = result["duration_seconds"]
    db.flush()


def _process_image(db, asset, version, media_file, s3, output_prefix):
    from packages.transcoder.image_processor import process_image
    result = process_image(s3, settings.s3_bucket, media_file.s3_key_raw, output_prefix)
    media_file.s3_key_processed = result.get("webp_key")
    media_file.s3_key_thumbnail = result.get("thumbnail_key")
    db.flush()


def _publish_event(project_id: str, event_type: str, payload: dict):
    """Publish SSE event via Redis from Celery worker context."""
    try:
        import redis as sync_redis
        r = sync_redis.from_url(settings.redis_url, decode_responses=True)
        message = json.dumps({"type": event_type, "payload": payload})
        r.publish(f"project:{project_id}", message)
        r.close()
    except Exception:
        pass  # SSE publish is best-effort


def _eligible_media_rows(db):
    """Rows the #124 backfill still needs: (MediaFile, asset_type) pairs."""
    return (
        db.query(MediaFile, Asset.asset_type)
        .join(AssetVersion, MediaFile.version_id == AssetVersion.id)
        .join(Asset, AssetVersion.asset_id == Asset.id)
        .filter(
            AssetVersion.processing_status == ProcessingStatus.ready,
            AssetVersion.deleted_at.is_(None),
            Asset.deleted_at.is_(None),
            MediaFile.duration_seconds.is_(None),
            Asset.asset_type.in_([AssetType.video, AssetType.audio]),
        )
        .all()
    )


@celery_app.task(bind=True)
def backfill_media_metadata(self):
    """One-off backfill for #124: probe raw S3 files to populate missing
    duration/width/height/fps on already-processed media. Idempotent —
    only touches rows where duration_seconds IS NULL."""
    import subprocess
    from packages.transcoder.ffmpeg_transcoder import parse_probe_metadata

    db = SessionLocal()
    updated = skipped = 0
    try:
        rows = _eligible_media_rows(db)
        s3 = get_s3_client()
        for media_file, asset_type in rows:
            row_id = media_file.id
            try:
                url = s3.generate_presigned_url(
                    "get_object",
                    Params={"Bucket": settings.s3_bucket, "Key": media_file.s3_key_raw},
                    ExpiresIn=3600,
                )
                cmd = ["ffprobe", "-v", "error", "-print_format", "json", "-show_format"]
                if asset_type == AssetType.video:
                    cmd += ["-show_streams", "-select_streams", "v:0"]
                probe = subprocess.run(cmd + [url], capture_output=True, text=True, timeout=300)
                if probe.returncode != 0:
                    skipped += 1
                    continue
                try:
                    data = json.loads(probe.stdout)
                except json.JSONDecodeError:
                    skipped += 1
                    continue
                if asset_type == AssetType.video:
                    meta = parse_probe_metadata(data)
                    if meta is None:
                        skipped += 1
                        continue
                    media_file.duration_seconds = meta.duration_seconds or None
                    media_file.width = meta.width or None
                    media_file.height = meta.height or None
                    media_file.fps = meta.fps or None
                else:
                    duration = float((data.get("format") or {}).get("duration") or 0)
                    media_file.duration_seconds = duration or None
                db.commit()
                updated += 1
            except Exception as exc:
                db.rollback()
                skipped += 1
                log.warning("backfill: skipping media_file %s: %s", row_id, exc)
                continue
        return {"updated": updated, "skipped": skipped}
    finally:
        db.close()
