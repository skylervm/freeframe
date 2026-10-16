# Clip render jobs

On a video asset, project owners and editors can use **Generate clips** in the
comments toolbar, or in the phone's More menu. Lock at least one range first.
Unlocked ranges are skipped. The button queues work; it does not render on the
server or upload any clips. A separate Mac runner must be on and connected to
pull the job. Until then the job stays queued and can be cancelled.

The queue snapshots unresolved, top-level, non-deleted `Clip N` range comments
for the selected ready video version. Only locked ranges are included, with
clip numbers from 1 through 999. Later comment edits do not change that snapshot.
Every locked range must have finite timecodes, a nonnegative start, and an end
after its start. An invalid range returns a conflict naming the clip number.
An active job prevents duplicates. The newest successful job also prevents
rendering an identical locked snapshot again. Failed or cancelled jobs can be
retried. Changing which ranges are locked, or editing a range and relocking it,
allows a new snapshot to be queued.
Creating a replacement retires all expired claims for that version as failed
with the message `Render lease expired`, so they cannot be claimed again.
An existing job remains visible even after all range comments are deleted;
generation stays disabled until a range is locked again.

## Session API

- `POST /assets/{asset_id}/clip-render-jobs`, body `{"version_id": "<uuid>"}`:
  owner/editor only; returns the job with HTTP 201.
- `GET /assets/{asset_id}/clip-render-jobs/latest?version_id=<uuid>`:
  returns `job` (or null), `locked_count`, `range_count`, and
  `worker_last_seen_at`. Owner/editor only, including on public projects.
- `POST /clip-render-jobs/{job_id}/cancel`: owner/editor only; only queued jobs
  can be cancelled.

Creation conflicts return HTTP 409 with a structured `detail` containing `code`
and `message`. Codes are `version_not_ready`, `no_locked_ranges`, `invalid_range`,
`job_active`, and `already_rendered`.

The Mac last-seen time is the newest `last_used_at` of a non-revoked,
non-deleted project automation token. It reflects automation API use, which
the existing authentication middleware updates at most once per minute. It is
not proof that a Mac is currently online.

## Automation API

Use the existing project automation-token authentication. Each operation is
restricted to the token's project and counts as token use.

- `GET /automation/clip-render-jobs?status=queued`: returns queued jobs and
  claimed jobs with expired leases, oldest first.
- `POST /automation/clip-render-jobs/{job_id}/claim`: atomically claims queued
  work or reclaims an expired lease. Each successful claim returns a fresh
  `claim_id` UUID. Competing claims return HTTP 409.
- `POST /automation/clip-render-jobs/{job_id}/finish`, body
  `{"claim_id": "<uuid>", "status": "done", "clips_rendered": 2, "message": ""}`:
  only claimed jobs with the matching current `claim_id` can finish. A stale
  claim returns HTTP 409. `status` may be `done` or `failed`; the clip count must
  be an integer from 0 through 999. A `done` job must report exactly the number
  of ranges in its snapshot; otherwise HTTP 422 with code `incomplete_render`
  leaves the job claimed. A `failed` job may report any count from zero through
  the snapshot's range count; a larger count returns HTTP 422 with code
  `invalid_clip_count`. Failed jobs permit retry. Messages are truncated to
  300 characters server-side.

The lease lasts 90 minutes from `claimed_at`. A fresh claim cannot be reclaimed.
There is no lease renewal in this version; the 90 minute lease is intended to
cover a render.
The list and claim responses contain only `id`, `asset_id`, `version_id`,
`ranges`, and `created_at`, with `claim_id` added only to the claim response.
The claim ID never appears in browser responses. Each range contains
`comment_id`, `number`, `start`, and `end` in seconds, with the same finite,
nonnegative, ordered timecode constraints as creation. The finish response
contains only `id` and `clips_rendered`. No comment text, user details, media
paths, filenames, or URLs are included in these responses. Cross-project jobs
and jobs whose asset or version is deleted return HTTP 404 and are excluded
from the worker list. Retention cleanup cascades job deletion when its project,
asset, version, or requesting user is purged.

The UI checks job status every ten seconds while a job is queued or claimed,
and stops polling when the control unmounts or the job reaches a terminal state.
