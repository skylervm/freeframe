"use client";

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import useSWR from "swr";
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Globe,
  Lock,
  Plus,
  Share2,
  Trash2,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProjectCard } from "@/components/projects/project-card";
import type {
  PersonalProjectPlacement,
  Project,
  ProjectFolder,
  ProjectFolderScope,
  ProjectFolderShare,
  User,
} from "@/types";

type FolderDialogMode = "create" | "manage" | "move";

const scopeCopy: Record<ProjectFolderScope, { label: string; description: string; icon: typeof UserRound }> = {
  personal: { label: "Personal", description: "Only you can organize projects here.", icon: UserRound },
  shared: { label: "Shared", description: "Invite specific people. New members can view by default.", icon: Share2 },
  workspace: { label: "Workspace-wide", description: "Available to every workspace member.", icon: Globe },
};

function scopeLabel(scope: ProjectFolderScope) {
  return scopeCopy[scope].label;
}

function folderPath(folder: ProjectFolder, folders: ProjectFolder[]) {
  const byId = new Map(folders.map((item) => [item.id, item]));
  const parts = [folder.name];
  let parent = folder.parent_id ? byId.get(folder.parent_id) : undefined;
  while (parent) {
    parts.unshift(parent.name);
    parent = parent.parent_id ? byId.get(parent.parent_id) : undefined;
  }
  return parts.join(" / ");
}

function FolderDialog({
  mode,
  folder,
  project,
  folders,
  userId,
  open,
  onOpenChange,
  onUpdated,
}: {
  mode: FolderDialogMode;
  folder?: ProjectFolder;
  project?: Project;
  folders: ProjectFolder[];
  userId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => void;
}) {
  const [name, setName] = React.useState("");
  const [scope, setScope] = React.useState<ProjectFolderScope>("personal");
  const [isPrivate, setIsPrivate] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const [shares, setShares] = React.useState<ProjectFolderShare[]>([]);
  const [people, setPeople] = React.useState<Record<string, User>>({});
  const [personQuery, setPersonQuery] = React.useState("");
  const [suggestions, setSuggestions] = React.useState<User[]>([]);
  const [selectedUser, setSelectedUser] = React.useState<User | null>(null);
  const [shareRole, setShareRole] = React.useState<"viewer" | "editor">("viewer");
  const [expanded, setExpanded] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setName(mode === "manage" ? folder?.name ?? "" : "");
    setScope(folder?.scope ?? "personal");
    setIsPrivate(folder?.is_private ?? false);
    setError("");
    setPersonQuery("");
    setSelectedUser(null);
    setSuggestions([]);
    setExpanded(false);
  }, [open, mode, folder]);

  React.useEffect(() => {
    if (!open || mode !== "manage" || !folder || folder.owner_id !== userId) return;
    let active = true;
    api.get<ProjectFolderShare[]>(`/project-folders/${folder.id}/shares`).then(async (items) => {
      if (!active) return;
      setShares(items);
      if (!items.length) return;
      const users = await api.get<User[]>(`/users?ids=${items.map((item) => item.user_id).join(",")}`);
      if (active) setPeople(Object.fromEntries(users.map((person) => [person.id, person])));
    }).catch(() => active && setShares([]));
    return () => { active = false; };
  }, [open, mode, folder, userId]);

  React.useEffect(() => {
    if (!personQuery.trim() || mode !== "manage") {
      setSuggestions([]);
      return;
    }
    const timer = window.setTimeout(async () => {
      try {
        const users = await api.get<User[]>(`/users/search?q=${encodeURIComponent(personQuery.trim())}`);
        setSuggestions(users.filter((person) => !shares.some((share) => share.user_id === person.id)));
      } catch {
        setSuggestions([]);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [personQuery, mode, shares]);

  const ownedFolders = folders.filter((item) => item.owner_id === userId);
  const nestedFolders = folder
    ? ownedFolders.filter((item) => item.id !== folder.id && item.scope === folder.scope)
    : [];
  const canMoveSharedProject = project?.role === "owner";
  const folderChoices = project && canMoveSharedProject
    ? folders.filter((item) => item.scope !== "personal" && item.role === "editor")
    : [];
  const personalChoices = folders.filter((item) => item.scope === "personal" && item.owner_id === userId);

  async function saveFolder(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError("Folder name is required.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      if (mode === "manage" && folder) {
        await api.patch(`/project-folders/${folder.id}`, {
          name: name.trim(),
          ...(folder.owner_id === userId ? { is_private: isPrivate } : {}),
        });
      } else {
        await api.post("/project-folders", { name: name.trim(), scope, is_private: isPrivate });
      }
      onUpdated();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save folder.");
    } finally {
      setSaving(false);
    }
  }

  async function addFolderMember() {
    if (!folder || !selectedUser) return;
    setSaving(true);
    setError("");
    try {
      const share = await api.post<ProjectFolderShare>(`/project-folders/${folder.id}/shares`, { user_id: selectedUser.id, role: shareRole });
      setShares((current) => [...current.filter((item) => item.user_id !== share.user_id), share]);
      setPeople((current) => ({ ...current, [selectedUser.id]: selectedUser }));
      setSelectedUser(null);
      setPersonQuery("");
      setSuggestions([]);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not share folder.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteFolder() {
    if (!folder || !window.confirm(`Move "${folder.name}" to Trash? Projects remain, but folder-based access is removed until you restore it.`)) return;
    setSaving(true);
    setError("");
    try {
      await api.delete(`/project-folders/${folder.id}`);
      onUpdated();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not move folder to Trash.");
    } finally {
      setSaving(false);
    }
  }

  async function removeFolderMember(userIdToRemove: string) {
    if (!folder) return;
    setSaving(true);
    try {
      await api.delete(`/project-folders/${folder.id}/shares/${userIdToRemove}`);
      setShares((current) => current.filter((item) => item.user_id !== userIdToRemove));
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove member.");
    } finally {
      setSaving(false);
    }
  }

  async function moveProject(folderId: string | null, personal = false) {
    if (!project) return;
    setSaving(true);
    setError("");
    try {
      await api.put(`/projects/${project.id}/${personal ? "personal-placement" : "project-folder"}`, { folder_id: folderId });
      onUpdated();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not move project.");
    } finally {
      setSaving(false);
    }
  }

  const title = mode === "create" ? "New folder" : mode === "move" ? `Move ${project?.name ?? "project"}` : `Manage ${folder?.name ?? "folder"}`;
  const canManageShares = mode === "manage" && folder && folder.scope !== "personal" && folder.owner_id === userId;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-bg-secondary p-6 shadow-xl">
          <Dialog.Close className="absolute right-4 top-4 text-text-tertiary hover:text-text-primary"><X className="h-4 w-4" /></Dialog.Close>
          <Dialog.Title className="text-base font-semibold text-text-primary">{title}</Dialog.Title>

          {mode === "move" ? (
            <div className="mt-5 space-y-5">
              {canMoveSharedProject && <div>
                <p className="text-sm font-medium text-text-primary">Shared location</p>
                <p className="mt-1 text-xs text-text-tertiary">This changes access for projects you own.</p>
                <div className="mt-2 space-y-1">
                  <button onClick={() => moveProject(null)} disabled={saving} className="w-full rounded-lg px-3 py-2 text-left text-sm text-text-secondary hover:bg-bg-hover">No shared folder</button>
                  {folderChoices.map((item) => <button key={item.id} onClick={() => moveProject(item.id)} disabled={saving} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-hover"><FolderOpen className="h-4 w-4 shrink-0 text-text-tertiary" /><span className="min-w-0 flex-1 truncate">{folderPath(item, folders)}</span><span className="text-xs text-text-tertiary">{scopeLabel(item.scope)}</span></button>)}
                </div>
              </div>}
              <div>
                <p className="text-sm font-medium text-text-primary">Your personal view</p>
                <p className="mt-1 text-xs text-text-tertiary">This only organizes what you see. It never changes project access.</p>
                <div className="mt-2 space-y-1">
                  <button onClick={() => moveProject(null, true)} disabled={saving} className="w-full rounded-lg px-3 py-2 text-left text-sm text-text-secondary hover:bg-bg-hover">No personal folder</button>
                  {personalChoices.map((item) => <button key={item.id} onClick={() => moveProject(item.id, true)} disabled={saving} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-hover"><FolderOpen className="h-4 w-4 shrink-0 text-text-tertiary" /><span className="truncate">{folderPath(item, folders)}</span></button>)}
                </div>
              </div>
              {error && <p className="text-sm text-status-error">{error}</p>}
            </div>
          ) : (
            <form onSubmit={saveFolder} className="mt-5 space-y-4">
              <Input label="Folder name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Fall campaign" required />
              {mode === "create" && (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-text-secondary">Folder type</p>
                  <div className="space-y-2">
                    {(Object.keys(scopeCopy) as ProjectFolderScope[]).map((item) => {
                      const ItemIcon = scopeCopy[item].icon;
                      return <label key={item} className={cn("flex cursor-pointer gap-3 rounded-lg border p-3", scope === item ? "border-accent bg-accent-muted" : "border-border hover:bg-bg-hover")}><input className="mt-1" type="radio" checked={scope === item} onChange={() => setScope(item)} /><ItemIcon className="mt-0.5 h-4 w-4 text-text-tertiary" /><span><span className="block text-sm font-medium text-text-primary">{scopeCopy[item].label}</span><span className="block text-xs text-text-tertiary">{scopeCopy[item].description}</span></span></label>;
                    })}
                  </div>
                </div>
              )}
              {scope !== "personal" && (mode === "create" || folder?.owner_id === userId) && (
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 hover:bg-bg-hover"><input className="mt-1" type="checkbox" checked={isPrivate} onChange={(event) => setIsPrivate(event.target.checked)} /><Lock className="mt-0.5 h-4 w-4 text-text-tertiary" /><span><span className="block text-sm font-medium text-text-primary">Private folder</span><span className="block text-xs text-text-tertiary">Folder members lose inherited access. Directly shared projects stay visible.</span></span></label>
              )}
              {error && <p className="text-sm text-status-error">{error}</p>}
              <div className="flex items-center justify-between gap-2"><div>{mode === "manage" && folder?.owner_id === userId && <Button type="button" variant="ghost" size="sm" onClick={deleteFolder} disabled={saving} className="text-status-error hover:bg-status-error/10 hover:text-status-error"><Trash2 className="h-4 w-4" />Move to Trash</Button>}</div><div className="flex gap-2"><Dialog.Close asChild><Button type="button" variant="secondary" size="sm">Cancel</Button></Dialog.Close><Button type="submit" size="sm" loading={saving}>{mode === "create" ? "Create folder" : "Save changes"}</Button></div></div>
            </form>
          )}

          {canManageShares && (
            <div className="mt-6 border-t border-border pt-5">
              <button type="button" onClick={() => setExpanded((value) => !value)} className="flex w-full items-center justify-between text-left"><span><span className="block text-sm font-medium text-text-primary">Folder members</span><span className="mt-0.5 block text-xs text-text-tertiary">Members can see every project in this folder.</span></span>{expanded ? <ChevronDown className="h-4 w-4 text-text-tertiary" /> : <ChevronRight className="h-4 w-4 text-text-tertiary" />}</button>
              {expanded && <div className="mt-4 space-y-3"><div className="relative flex gap-2"><input value={personQuery} onChange={(event) => { setPersonQuery(event.target.value); setSelectedUser(null); }} placeholder="Search people" className="min-w-0 flex-1 rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-border-focus" /><select value={shareRole} onChange={(event) => setShareRole(event.target.value as "viewer" | "editor")} className="rounded-md border border-border bg-bg-secondary px-2 text-sm text-text-primary"><option value="viewer">Viewer</option><option value="editor">Editor</option></select><Button type="button" size="sm" onClick={addFolderMember} disabled={!selectedUser} loading={saving}>Add</Button>{suggestions.length > 0 && <div className="absolute left-0 top-11 z-10 w-full rounded-lg border border-border bg-bg-secondary p-1 shadow-xl">{suggestions.map((person) => <button key={person.id} type="button" onClick={() => { setSelectedUser(person); setPersonQuery(person.name || person.email); setSuggestions([]); }} className="block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-bg-hover"><span className="text-text-primary">{person.name}</span><span className="ml-2 text-text-tertiary">{person.email}</span></button>)}</div>}</div><div className="space-y-1">{shares.length === 0 ? <p className="text-xs text-text-tertiary">No one has been added. Viewer is the default role.</p> : shares.map((share) => <div key={share.id} className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm"><Users className="h-4 w-4 text-text-tertiary" /><span className="min-w-0 flex-1 truncate text-text-primary">{people[share.user_id]?.name ?? "Member"}</span><span className="text-xs text-text-tertiary capitalize">{share.role}</span><button type="button" onClick={() => removeFolderMember(share.user_id)} disabled={saving} className="rounded p-1 text-text-tertiary hover:bg-bg-hover hover:text-status-error" aria-label="Remove member"><X className="h-3.5 w-3.5" /></button></div>)}</div></div>}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function FolderNode({ folder, folders, projects, placements, userId, onManage, onMoveProject, onUpdated }: { folder: ProjectFolder; folders: ProjectFolder[]; projects: Project[]; placements: PersonalProjectPlacement[]; userId?: string; onManage: (folder: ProjectFolder) => void; onMoveProject: (project: Project) => void; onUpdated: () => void; }) {
  const [open, setOpen] = React.useState(true);
  const [creating, setCreating] = React.useState(false);
  const [childName, setChildName] = React.useState("");
  const [childError, setChildError] = React.useState("");
  const [creatingChild, setCreatingChild] = React.useState(false);
  const children = folders.filter((item) => item.parent_id === folder.id);
  const placed = folder.scope === "personal" ? projects.filter((project) => placements.some((placement) => placement.project_id === project.id && placement.folder_id === folder.id)) : projects.filter((project) => project.project_folder_id === folder.id);
  const canEdit = folder.role === "editor";
  const FolderIcon = folder.scope === "workspace" ? Globe : folder.scope === "shared" ? Share2 : FolderOpen;

  async function createChild(event: React.FormEvent) {
    event.preventDefault();
    if (!childName.trim()) return;
    setCreatingChild(true);
    setChildError("");
    try {
      await api.post("/project-folders", { name: childName.trim(), parent_id: folder.id });
      setChildName("");
      setCreating(false);
      onUpdated();
    } catch (err) {
      setChildError(err instanceof Error ? err.message : "Could not create subfolder.");
    } finally {
      setCreatingChild(false);
    }
  }

  return <div className="rounded-xl border border-border bg-bg-secondary"><div className="flex items-center gap-2 px-3 py-2.5"><button type="button" onClick={() => setOpen((value) => !value)} className="rounded p-1 text-text-tertiary hover:bg-bg-hover">{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button><FolderIcon className="h-4 w-4 text-accent" />{canEdit ? <button type="button" onClick={() => onManage(folder)} className="min-w-0 flex-1 truncate text-left text-sm font-medium text-text-primary hover:text-accent">{folder.name}</button> : <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{folder.name}</span>}<span className="hidden text-xs text-text-tertiary sm:inline">{scopeLabel(folder.scope)}</span>{folder.is_private && <Lock className="h-3.5 w-3.5 text-text-tertiary" aria-label="Private folder" />}{canEdit && <button type="button" onClick={() => { setCreating((value) => !value); setChildError(""); }} className="rounded p-1.5 text-text-tertiary hover:bg-bg-hover hover:text-text-primary" aria-label="New subfolder"><Plus className="h-4 w-4" /></button>}</div>{open && <div className="border-t border-border p-3"><div className="space-y-3">{children.map((child) => <FolderNode key={child.id} folder={child} folders={folders} projects={projects} placements={placements} userId={userId} onManage={onManage} onMoveProject={onMoveProject} onUpdated={onUpdated} />)}{creating && <form onSubmit={createChild} className="space-y-2"><div className="flex gap-2"><input autoFocus value={childName} onChange={(event) => setChildName(event.target.value)} placeholder="Subfolder name" className="min-w-0 flex-1 rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-border-focus" /><Button type="submit" size="sm" loading={creatingChild}>Add</Button></div>{childError && <p className="text-xs text-status-error">{childError}</p>}</form>}{placed.length > 0 && <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{placed.map((project) => <ProjectCard key={project.id} project={project} isOwner={project.created_by === userId} onMutate={onUpdated} onMoveToFolder={onMoveProject} />)}</div>}{children.length === 0 && placed.length === 0 && !creating && <p className="px-1 py-3 text-xs text-text-tertiary">No projects in this folder.</p>}</div></div>}</div>;
}

export function ProjectFolderControls({ projects, userId, onMutate, moveProject, onMoveProjectHandled }: { projects: Project[]; userId?: string; onMutate: () => void; moveProject?: Project | null; onMoveProjectHandled?: () => void; }) {
  const { data: folders = [], mutate: mutateFolders } = useSWRFolders();
  const { data: placements = [], mutate: mutatePlacements } = useSWRPlacements();
  const [dialog, setDialog] = React.useState<{ mode: FolderDialogMode; folder?: ProjectFolder; project?: Project } | null>(null);
  const visibleFolderIds = new Set(folders.map((folder) => folder.id));
  const rootFolders = folders.filter((folder) => (!folder.parent_id || !visibleFolderIds.has(folder.parent_id)) && (folder.scope !== "personal" || folder.owner_id === userId));
  const refresh = () => { mutateFolders(); mutatePlacements(); onMutate(); };

  React.useEffect(() => {
    if (moveProject) setDialog({ mode: "move", project: moveProject });
  }, [moveProject]);

  return <><div className="flex items-center justify-between"><div><h2 className="text-sm font-medium text-text-secondary">Folders</h2><p className="mt-0.5 text-xs text-text-tertiary">Personal folders organize your view. Shared and workspace folders control access.</p></div><Button size="sm" variant="secondary" onClick={() => setDialog({ mode: "create" })}><Plus className="h-4 w-4" />New folder</Button></div><div className="space-y-3">{rootFolders.map((folder) => <FolderNode key={folder.id} folder={folder} folders={folders} projects={projects} placements={placements} userId={userId} onManage={(selected) => setDialog({ mode: "manage", folder: selected })} onMoveProject={(project) => setDialog({ mode: "move", project })} onUpdated={refresh} />)}{rootFolders.length === 0 && <button type="button" onClick={() => setDialog({ mode: "create" })} className="flex w-full items-center gap-3 rounded-xl border border-dashed border-border px-4 py-5 text-left hover:border-accent/40 hover:bg-bg-secondary"><FolderOpen className="h-5 w-5 text-text-tertiary" /><span><span className="block text-sm font-medium text-text-primary">Create a folder</span><span className="block text-xs text-text-tertiary">Choose personal, shared, or workspace-wide.</span></span></button>}</div>{dialog && <FolderDialog mode={dialog.mode} folder={dialog.folder} project={dialog.project} folders={folders} userId={userId} open onOpenChange={(open) => { if (!open) { setDialog(null); onMoveProjectHandled?.(); } }} onUpdated={refresh} />}</>;
}

function useSWRFolders() {
  return useSWR<ProjectFolder[]>("/project-folders", () => api.get<ProjectFolder[]>("/project-folders"));
}

function useSWRPlacements() {
  return useSWR<PersonalProjectPlacement[]>("/personal-project-placements", () => api.get<PersonalProjectPlacement[]>("/personal-project-placements"));
}
