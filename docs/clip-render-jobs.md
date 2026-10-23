# Clip render jobs

On a video asset, project owners and editors can use **Generate clips** in the
comments toolbar, or in the phone's More menu. Lock at least one range first.
Unlocked ranges are skipped. The button queues work; it does not render on the
server or upload any clips. A separate Mac runner must be on and connected to
pull the job. Until then the job stays queued and can be cancelled.

The queue snapshots unresolved, top-level, non-deleted range comments for the
selected ready video version. The comment text does not matter. Only locked
ranges are included, numbered 1 upward by start time (then end, then comment
id). Later comment edits do not change that snapshot. Every locked range must
have finite timecodes, a nonnegative start, and an end after its start. An
invalid range returns a conflict that names the comment. At most 999 ranges can
be locked for one render (`too_many_ranges`). The automation clip-marker list
(`GET .../comments` under the project token) still lists only `Clip N` comments;
this rule applies to rendering.
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

The Mac last-seen time is the newest `last_used_at` of a clip runner token
that is not revoked, not expired, and whose creator is an active superadmin
with an owner or editor role on this project. Project automation tokens do not
count. Runner authentication updates `last_used_at` at most once per minute.
It is not proof that a Mac is currently online.

## Clip runner token

The Mac runner uses one instance-wide clip runner token. It works for every
project, but it can do nothing except list, claim, report progress on and finish clip render jobs.
Every other endpoint returns HTTP 401 for it, including the comment, asset,
project, upload, user, token and delete endpoints.

- Format: `ffcr_<token id>_<secret>`. The secret is 32 random bytes. The
  `ffcr_` prefix is never accepted where a project automation token (`ffat_`)
  is expected, and `ffat_` tokens are never accepted by the runner endpoints.
- Storage: only the SHA-256 hash of the secret is stored. It is compared in
  constant time. The full token is returned once, by the create call, and is
  never logged.
- Lifetime: an expiry is required, with a timezone, in the future, and at most
  366 days away. The Admin page offers 365 days by default.
- The token stops working when it is revoked, when it expires, or when its
  creator is deactivated, deleted, or no longer a superadmin. Every failure
  returns the same HTTP 401 body.

Create and revoke it in **Settings → Admin → Clip runner** (superadmins only).
After creation, copy the token, then run this one line in Terminal on the Mac.
It creates the folder if needed and writes the file readable only by you:

    (set -e; umask 077; mkdir -p ~/.config/freeframe; rm -f ~/.config/freeframe/clip-runner.token; pbpaste > ~/.config/freeframe/clip-runner.token)

Never paste the token into a chat. The management API uses the browser
session and is superadmin only (HTTP 403 otherwise):

- `POST /clip-runner-tokens`, body `{"name": "Mac clip runner", "expires_at": "<ISO 8601 with timezone>"}`:
  returns `id`, `name`, `created_at`, `expires_at`, and `token` with HTTP 201.
  An invalid expiry returns HTTP 400. Creation is limited to 10 per hour.
- `GET /clip-runner-tokens`: lists the caller's tokens with `id`, `name`,
  `created_at`, `last_used_at`, `expires_at`, and `revoked_at`. No secret or
  hash is ever returned.
- `DELETE /clip-runner-tokens/{id}`: revokes the token (HTTP 204, idempotent).
  A token that is not the caller's returns HTTP 404.

## Runner API

Send the clip runner token as `Authorization: Bearer ffcr_...`.

**Scope rule.** A job is visible, claimable and finishable only while all of
these hold at request time: the job is not deleted; its project exists and is
not deleted; its asset and version exist and are not deleted; and the token
creator's effective role on that job's project is owner or editor. Public
access or a viewer/reviewer role is not enough. A job outside this scope
returns the same HTTP 404 as a missing job and is absent from the list.

- `GET /runner/clip-render-jobs`: returns queued jobs and claimed jobs with
  expired leases, oldest first, at most 50. Each request role-checks only the
  first 2000 distinct projects with claimable work, ordered by their oldest
  claimable job. Projects the creator can edit count toward that limit too, so a
  runnable job in a project ranked below 2000 is not listed until older work is
  claimed or cancelled. The list is advisory: claim and finish re-check the
  creator's role on every call.
- `POST /runner/clip-render-jobs/{job_id}/claim`: atomically claims queued
  work or reclaims an expired lease. Each successful claim returns a fresh
  `claim_id` UUID and the version's `processing_status` (for example
  `ready`). Competing claims return HTTP 409.
- `POST /runner/clip-render-jobs/{job_id}/progress`, body
  `{"claim_id": "<uuid>", "clips_rendered": 3}`: the runner calls this after each
  finished clip so the review screen can show a progress bar. Only a claimed job
  with the matching current `claim_id` accepts it; anything else returns HTTP
  409. The count is an integer from 0 through 999 and may not exceed the
  snapshot's range count (HTTP 422, code `invalid_clip_count`). Counts only go
  up: a lower or equal count is accepted and changes nothing, so a retry is
  harmless. A new claim resets the count, so a re-claimed job never shows the
  old attempt's progress. A progress 409 means the claim was lost (the job
  finished, was cancelled or was re-claimed): the runner should stop reporting
  progress for that job, never treat it as a render failure. The browser reads
  the count from the latest-job response (`clips_rendered`, with `ranges` giving
  the total) and shows the bar while the job is claimed.
- `POST /runner/clip-render-jobs/{job_id}/finish`, body
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
`ranges`, and `created_at`, with `claim_id` and `processing_status` added only
to the claim response.
The claim ID never appears in browser responses. Each range contains
`comment_id`, `number`, `start`, and `end` in seconds, with the same finite,
nonnegative, ordered timecode constraints as creation. The progress and finish responses
contain only `id` and `clips_rendered`. No project id, names, comment text,
user details, media paths, filenames, or URLs are included in these responses. Retention cleanup cascades job deletion when its project,
asset, version, or requesting user is purged.

The UI checks job status every ten seconds while a job is queued or claimed,
and stops polling when the control unmounts or the job reaches a terminal state.
