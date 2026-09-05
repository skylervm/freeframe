# Project Plan: Project Folder Workspace

## Goal

Give FreeFrame one explicit-membership workspace in which people can organize
projects in personal or shared nested folders. Folder access grants Viewer by
default, while a direct project share remains limited to that project.

## Phases

### Phase 1: Data model and access rules

Add the singleton workspace, explicit membership, project folders, folder
shares, and project placement. Extend project and asset permission resolution
so inherited folder access is checked everywhere current project membership is
checked.

Personal placements are non-authoritative shortcuts. Shared and workspace
placements grant access only when a project owner creates or moves them.

### Phase 2: Folder and workspace APIs

Add workspace membership administration, project-folder CRUD, nesting,
privacy boundaries, project movement, and direct project sharing endpoints.

### Phase 3: Project workspace UI

Replace the visual-only **My Projects** section with the folder browser and
add project movement, folder sharing, and workspace-member controls.

### Phase 4: Verification and rollout

Run API permission coverage, web tests, independent review, and production
build. Hand off nested-sharing and direct-project-share scenarios for browser
verification.

The permission test matrix covers direct grants, inherited grants, private
boundaries, revocation, events, uploads, list/detail views, and the direct
membership-only owner and automation paths.

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
