# Project Folder Workspace

## Intent

Let people organize projects in nested folders, then share a folder as a bundle
of projects without losing the ability to share one project independently.

## Folder types

- **Personal:** visible only to its creator. A person can organize a shared
  project differently from other people. Personal placements are private
  shortcuts: they never grant or extend project access and cannot be shared.
- **Shared:** visible to explicitly invited people. Viewer is the default;
  an owner may deliberately grant Editor.
- **Workspace-wide:** visible to all members of a workspace. The definition
  of workspace membership is explicit: it is never inferred from an account
  or a project invitation.

Folders may be nested to ten levels, matching the existing asset-folder limit.
Projects have one placement per person's workspace view. Moving a project to a
different access-granting folder removes its inherited access from its previous
ancestors. A project may additionally have personal shortcuts without changing
access.

## Access rules

Project access is a union of grants:

1. Project ownership, direct membership, direct project shares, or public
   visibility.
2. Any active share on the project's containing project folder or its ancestor
   folders.

A shared project folder therefore grants its Viewer or Editor role to every
project below it. Folder sharing never grants project ownership. Only a
project owner can add or move that project into an access-granting folder;
Viewers cannot mutate folders, and shared-folder Editors can organize existing
folder contents but cannot change shares or privacy.

A direct project share is independent. Someone directly shared project Z can
open Z without seeing the parent folder or sibling projects.

The first release has one explicit-membership workspace. Existing superadmins
are seeded as workspace owners. Workspace owners add and remove members in the
workspace settings area, which is separate from global Admin. Inviting someone
to a project never creates a workspace membership; adding them to the workspace
never grants project access by itself. The last workspace owner cannot be
removed.

Every current project and asset entry point uses an effective-role resolver
rather than relying solely on direct project membership. Direct membership
remains required for ownership changes and automation tokens. An asset creator
does not keep access after losing their only folder-derived grant, and uploads
and resumable uploads re-check current effective access.

## Private folder boundary

Marking a project folder private stops inherited shares from parent folders at
that folder. It does not revoke its owner's access, its explicit folder shares,
or direct project shares. A private project inside a shared folder remains
available to the folder's members because the folder is an explicit grant.

Deleting a project folder deletes its full descendant tree, revokes every share
on that tree, and returns contained projects to root. Folder moves reject cycles,
deleted destinations, and moves across personal owners. Conflicting tree writes
are serialized.

Event subscriptions re-check effective access while open. Already-issued media
URLs remain usable until their existing expiry, because they are bearer URLs.

## What this does not reuse

Existing `folders` are asset folders scoped to a single project. Their secure
share links protect a link; they do not provide normal inherited project access.
Project folders require distinct models, APIs, and permission checks.

## User experience

The existing **My Projects** section becomes the root of the folder browser.
Users can create, rename, move, and delete folders; move projects into folders
or back to root; and share a folder from its menu. Deleting a folder returns
its projects to root. Folder navigation shows nested folders and projects,
while directly shared projects remain in **Shared with Me**.

## Verification criteria

- A folder Viewer can browse and open every nested project, including a private
  project; a non-member cannot.
- A direct project Viewer can open that project but cannot browse its parent or
  siblings.
- A private nested folder blocks a parent-folder share while keeping direct
  grants valid.
- Moving a project changes inherited access immediately.
- Personal folders remain invisible to every other user.
- A former folder Editor cannot browse assets, resume uploads, or receive new
  project events after their last inherited grant is removed.
