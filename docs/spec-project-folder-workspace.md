# Project Folder Workspace

## Intent

Let people organize projects in nested folders, then share a folder as a bundle
of projects without losing the ability to share one project independently.

## Folder types

- **Personal:** visible only to its creator. A person can organize a shared
  project differently from other people.
- **Shared:** visible to explicitly invited people. Viewer is the default;
  an owner may deliberately grant Editor.
- **Workspace-wide:** visible to all members of a workspace. The definition
  of workspace membership is still open.

Folders may be nested to ten levels, matching the existing asset-folder limit.
Projects have one placement per person's workspace view. Moving a project to a
different folder removes its inherited access from its previous ancestors.

## Access rules

Project access is a union of grants:

1. Project ownership, direct membership, direct project shares, or public
   visibility.
2. Any active share on the project's containing project folder or its ancestor
   folders.

A shared project folder therefore grants its Viewer or Editor role to every
project below it. Folder sharing never grants project ownership.

A direct project share is independent. Someone directly shared project Z can
open Z without seeing the parent folder or sibling projects.

## Private folder boundary

Marking a project folder private stops inherited shares from parent folders at
that folder. It does not revoke its owner's access, its explicit folder shares,
or direct project shares. A private project inside a shared folder remains
available to the folder's members because the folder is an explicit grant.

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

## Open decision

FreeFrame currently has no workspace or team membership model. Choose one
before implementation:

- **Instance-wide:** every active FreeFrame account belongs to the one initial
  workspace.
- **Named workspaces:** add workspace records, member administration, and
  workspace selection before workspace-wide folders are enabled.

## Verification criteria

- A folder Viewer can browse and open every nested project, including a private
  project; a non-member cannot.
- A direct project Viewer can open that project but cannot browse its parent or
  siblings.
- A private nested folder blocks a parent-folder share while keeping direct
  grants valid.
- Moving a project changes inherited access immediately.
- Personal folders remain invisible to every other user.
