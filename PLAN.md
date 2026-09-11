# Project Plan: Project Folder Workspace

## Goal

Give FreeFrame one explicit-membership workspace in which people can organize
projects in personal or shared nested folders. Folder access grants Viewer by
default, while a direct project share remains limited to that project.

## Phases

### Phase 1: Data model and access rules — complete

Add the singleton workspace, explicit membership, project folders, folder
shares, and project placement. Extend project and asset permission resolution
so inherited folder access is checked everywhere current project membership is
checked.

Personal placements are non-authoritative shortcuts. Shared and workspace
placements grant access only when a project owner creates or moves them.

### Phase 2: Folder and workspace APIs — complete

Add workspace membership administration, project-folder CRUD, nesting,
privacy boundaries, project movement, and direct project sharing endpoints.

### Phase 3: Project workspace UI — complete

Replace the visual-only **My Projects** section with the folder browser and
add project movement, folder sharing, and workspace-member controls.

### Phase 4: Verification and rollout — complete

Run API permission coverage, web tests, independent review, and production
build. Hand off nested-sharing and direct-project-share scenarios for browser
verification.

### Phase 5: Unified Trash — complete

Keep deleted assets, media folders, projects, and project folders recoverable
for the configured retention window (30 days by default). Record each deletion
operation and its affected items so restoring a container cannot resurrect
content, shares, or placements that were deleted or changed independently.

Provide an owner-scoped dashboard Trash with restore and immediate empty
actions. A restore returns an item to its original active parent, otherwise a
safe root destination that preserves private-folder visibility boundaries.
The retention job permanently removes expired project-folder records and their
dependent placement/share rows as well as the existing asset/project data.

The permission test matrix covers direct grants, inherited grants, private
boundaries, revocation, events, uploads, list/detail views, and the direct
membership-only owner and automation paths.

### Phase 6: Project Dropbox link — complete

- Nullable `dropbox_url` on projects (migration `a1b2c3d4e5f6`), https dropbox.com validator.
- Owner edits via settings dialog or DROPBOX sidebar section; owner/editor see it, lower roles redacted.
- `PATCH /automation/project/dropbox-link` lets a project-scoped automation token set only that field (60/hour).
- Shipped 2026-09-11 in PR #8; all four live projects linked.
- Known: the web app has no `typecheck` script; run `./node_modules/.bin/tsc --noEmit -p .` inside `apps/web`. ~27 API tests need a local Postgres and fail without one.

## Active tracker

This file and [the project-folder specification](docs/spec-project-folder-workspace.md)
define the active implementation scope.

## Decisions Log

- 2026-09-04: Use one explicit-membership workspace. Project invitations do
  not create workspace membership.
- 2026-09-04: Folder shares inherit Viewer access by default; Editors are
  explicit and project ownership never inherits.
- 2026-09-04: A private nested folder stops inherited parent shares, but direct
  folder and project grants remain valid.
- 2026-09-05: Trash restoration is operation-scoped. A container restore only
  revives rows deleted by that same operation; later deletions, revocations,
  and placement changes remain authoritative.
- 2026-09-06: The Projects screen supports both grid and list views, including
  folder-contained projects. Web Docker builds exclude host build artifacts and
  clear `.next` before compilation so deployments cannot retain stale UI bundles.
- 2026-09-11: A project's Dropbox link is a capability URL for the delivery
  folder, so it is owner/editor-only in the UI and redacted from the API for
  lower roles; automation tokens may set it only on their own project.
