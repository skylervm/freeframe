"""Real-Postgres coverage for project-card automatic poster selection."""
import uuid
from datetime import datetime, timedelta, timezone

from apps.api.models.asset import Asset, AssetType, AssetVersion, FileType, MediaFile, ProcessingStatus
from apps.api.models.project import Project, ProjectType
from apps.api.models.user import User


def _seed_owner_and_project(db):
    owner = User(email=f"cover-{uuid.uuid4()}@test.local", name="cover")
    db.add(owner)
    db.flush()
    project = Project(name="cover", project_type=ProjectType.personal, created_by=owner.id)
    db.add(project)
    db.flush()
    return owner, project


def _video_asset(db, project, owner, created_at, deleted=False):
    asset = Asset(
        project_id=project.id,
        name="video",
        asset_type=AssetType.video,
        created_by=owner.id,
        created_at=created_at,
        deleted_at=created_at if deleted else None,
    )
    db.add(asset)
    db.flush()
    return asset


def _version(db, asset, owner, number, status, thumbnail_key=None, deleted=False):
    version = AssetVersion(
        asset_id=asset.id,
        version_number=number,
        processing_status=status,
        created_by=owner.id,
        deleted_at=datetime.now(timezone.utc) if deleted else None,
    )
    db.add(version)
    db.flush()
    db.add(MediaFile(
        version_id=version.id,
        file_type=FileType.video,
        original_filename="video.mp4",
        mime_type="video/mp4",
        file_size_bytes=1,
        s3_key_raw=f"raw/{version.id}",
        s3_key_thumbnail=thumbnail_key,
    ))
    db.flush()
    return version


def test_automatic_cover_uses_oldest_master_and_newest_ready_thumbnail(real_db):
    from apps.api.routers.projects import _automatic_poster_keys

    owner, project = _seed_owner_and_project(real_db)
    now = datetime.now(timezone.utc)
    master = _video_asset(real_db, project, owner, now)
    _version(real_db, master, owner, 1, ProcessingStatus.ready, "thumb/master-v1.jpg")
    _version(real_db, master, owner, 2, ProcessingStatus.processing, "thumb/master-v2.jpg")
    later = _video_asset(real_db, project, owner, now + timedelta(seconds=1))
    _version(real_db, later, owner, 1, ProcessingStatus.ready, "thumb/later.jpg")

    assert _automatic_poster_keys(real_db, [project.id]) == {project.id: "thumb/master-v1.jpg"}

    # Once the new master revision is ready, it replaces the prior thumbnail.
    real_db.query(AssetVersion).filter(AssetVersion.asset_id == master.id, AssetVersion.version_number == 2).update(
        {"processing_status": ProcessingStatus.ready}
    )
    real_db.flush()
    assert _automatic_poster_keys(real_db, [project.id]) == {project.id: "thumb/master-v2.jpg"}


def test_automatic_cover_ignores_deleted_and_non_ready_video(real_db):
    from apps.api.routers.projects import _automatic_poster_keys

    owner, project = _seed_owner_and_project(real_db)
    now = datetime.now(timezone.utc)
    deleted_master = _video_asset(real_db, project, owner, now, deleted=True)
    _version(real_db, deleted_master, owner, 1, ProcessingStatus.ready, "thumb/deleted.jpg")
    processing_master = _video_asset(real_db, project, owner, now + timedelta(seconds=1))
    _version(real_db, processing_master, owner, 1, ProcessingStatus.processing, "thumb/processing.jpg")
    eligible = _video_asset(real_db, project, owner, now + timedelta(seconds=2))
    _version(real_db, eligible, owner, 1, ProcessingStatus.ready, "thumb/eligible.jpg")

    assert _automatic_poster_keys(real_db, [project.id]) == {project.id: "thumb/eligible.jpg"}


def test_manual_cover_takes_precedence_over_automatic(real_db, monkeypatch):
    from apps.api.routers.projects import _apply_poster_response
    from apps.api.schemas.project import ProjectResponse

    owner, project = _seed_owner_and_project(real_db)
    project.poster_s3_key = "posters/manual.jpg"
    response = ProjectResponse.model_validate(project)
    monkeypatch.setattr(
        "apps.api.routers.projects.generate_presigned_get_url",
        lambda key: f"https://storage.test/{key}",
    )

    _apply_poster_response(response, project, "thumb/automatic.jpg")

    assert response.poster_source == "manual"
    assert response.poster_url == "https://storage.test/posters/manual.jpg"
