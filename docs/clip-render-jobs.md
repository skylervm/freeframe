# Clip render jobs

On a video asset, project owners and editors can use **Generate clips** in the
comments toolbar, or in the phone's More menu. Lock at least one range first.
Unlocked ranges are skipped. The button queues work; it does not render on the
server or upload any clips. A separate Mac runner must be on and connected to
pull the job. Until then the job stays queued and can be cancelled.

The queue snapshots unresolved, top-level, non-deleted `Clip N` range comments
for the selected ready video version. Only locked ranges are included, with
clip numbers from 1 through 999. Later comment edits do not change that snapshot.
An active job prevents duplicates. The newest successful job also prevents
rendering an identical locked snapshot again. Failed or cancelled jobs can be
retried. Changing which ranges are locked, or editing a range and relocking it,
allows a new snapshot to be queued.

## Session API

- `POST /assets/{asset_id}/clip-render-jobs`, body `{"version_id": "<uuid>"}`:
  owner/editor only; returns the job with HTTP 201.
- `GET /assets/{asset_id}/clip-render-jobs/latest?version_id=<uuid>`:
  returns `job` (or null), `locked_count`, `range_count`, and
  `worker_last_seen_at`. Project members can read it.
- `POST /clip-render-jobs/{job_id}/cancel`: owner/editor only; only queued jobs
  can be cancelled.

Creation conflicts return HTTP 409 with a structured `detail` containing `code`
and `message`. Codes are `version_not_ready`, `no_locked_ranges`, `job_active`,
and `already_rendered`.

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
  work or reclaims an expired lease. Competing claims return HTTP 409.
- `POST /automation/clip-render-jobs/{job_id}/finish`, body
  `{"status": "done", "clips_rendered": 2, "message": ""}`: only claimed jobs
  can finish. `status` may be `done` or `failed`; the clip count must be a
  nonnegative integer. Messages are truncated to 300 characters server-side.

The lease lasts 90 minutes from `claimed_at`. A fresh claim cannot be reclaimed.
The list and claim responses contain only `id`, `asset_id`, `version_id`,
`ranges`, and `created_at`. Each range contains `comment_id`, `number`, `start`,
and `end` in seconds. The finish response contains only `id`, `status`, and
`clips_rendered`. No comment text, user details, media paths, filenames, or URLs
are included in these responses. Cross-project jobs return HTTP 404.

The UI checks job status every ten seconds while a job is queued or claimed,
and stops polling when the control unmounts or the job reaches a terminal state.
