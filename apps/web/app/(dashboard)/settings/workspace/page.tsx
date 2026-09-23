'use client'

import * as React from 'react'
import useSWR, { mutate } from 'swr'
import { Loader2, Search, UserPlus, Users } from 'lucide-react'
import { api } from '@/lib/api'
import { Avatar } from '@/components/shared/avatar'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/auth-store'
import type { User, WorkspaceRole } from '@/types'

type Workspace = {
  id: string
  name: string
  role: WorkspaceRole
}

type WorkspaceMember = {
  id: string
  user_id: string
  role: WorkspaceRole
}

const workspaceRoles: Array<{ value: WorkspaceRole; label: string }> = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'reviewer', label: 'Reviewer' },
  { value: 'editor', label: 'Editor' },
  { value: 'owner', label: 'Owner' },
]

export default function WorkspaceSettingsPage() {
  const [query, setQuery] = React.useState('')
  const [results, setResults] = React.useState<User[]>([])
  const [hasSearched, setHasSearched] = React.useState(false)
  const [searching, setSearching] = React.useState(false)
  const [error, setError] = React.useState('')
  const [pendingMemberId, setPendingMemberId] = React.useState<string | null>(null)
  const [pendingUserId, setPendingUserId] = React.useState<string | null>(null)
  const [newMemberRole, setNewMemberRole] = React.useState<WorkspaceRole>('viewer')
  const searchRevision = React.useRef(0)
  const { user } = useAuthStore()

  const { data: workspace, error: workspaceError, isLoading: loadingWorkspace } = useSWR<Workspace>(
    user ? '/workspace' : null,
    () => api.get<Workspace>('/workspace'),
  )
  const isOwner = workspace?.role === 'owner'
  const { data: members, error: membersError, isLoading: loadingMembers } = useSWR<WorkspaceMember[]>(
    isOwner ? '/workspace/members' : null,
    () => api.get<WorkspaceMember[]>('/workspace/members'),
  )
  const memberUserIds = members?.map((member) => member.user_id) ?? []
  const memberUsersKey = memberUserIds.length > 0 ? `/users?ids=${memberUserIds.join(',')}` : null
  const { data: memberUsers = [], error: memberUsersError, isLoading: loadingMemberUsers } = useSWR<User[]>(
    memberUsersKey,
    () => api.get<User[]>(memberUsersKey!),
  )
  const people = React.useMemo(
    () => new Map(memberUsers.map((person) => [person.id, person])),
    [memberUsers],
  )
  const rosterReady = !loadingMembers && !membersError && members !== undefined
  const memberIdentitiesReady = rosterReady
    && !loadingMemberUsers
    && !memberUsersError
  const mutationPending = pendingMemberId !== null || pendingUserId !== null

  const searchUsers = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!rosterReady || searching || mutationPending || !query.trim()) return
    const requestRevision = ++searchRevision.current
    setSearching(true)
    setHasSearched(true)
    setError('')
    try {
      const users = await api.get<User[]>(`/users/search?q=${encodeURIComponent(query.trim())}`)
      if (requestRevision !== searchRevision.current) return
      setResults(users.filter((person) => !memberUserIds.includes(person.id)))
    } catch (err: unknown) {
      if (requestRevision !== searchRevision.current) return
      setError(err instanceof Error ? err.message : 'Could not search users')
    } finally {
      if (requestRevision === searchRevision.current) setSearching(false)
    }
  }

  const addMember = async (userId: string) => {
    setPendingUserId(userId)
    setError('')
    try {
      await api.post('/workspace/members', { user_id: userId, role: newMemberRole })
      await mutate('/workspace/members')
      setResults((current) => current.filter((person) => person.id !== userId))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not add workspace member')
    } finally {
      setPendingUserId(null)
    }
  }

  const updateMemberRole = async (memberId: string, role: WorkspaceRole) => {
    setPendingMemberId(memberId)
    setError('')
    try {
      await api.patch(`/workspace/members/${memberId}`, { role })
      await Promise.all([mutate('/workspace'), mutate('/workspace/members')])
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not update workspace role')
    } finally {
      setPendingMemberId(null)
    }
  }

  const removeMember = async (memberId: string) => {
    setPendingMemberId(memberId)
    setError('')
    try {
      await api.delete(`/workspace/members/${memberId}`)
      await Promise.all([mutate('/workspace'), mutate('/workspace/members')])
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not remove workspace member')
    } finally {
      setPendingMemberId(null)
    }
  }

  if (loadingWorkspace) {
    return <div className="p-6 text-sm text-text-secondary">Loading workspace…</div>
  }

  if (!user) {
    return <div className="p-6 text-sm text-text-secondary">Loading workspace…</div>
  }

  if (workspaceError || !workspace) {
    return <div className="p-6 text-sm text-status-error">Could not load workspace access.</div>
  }

  if (!isOwner) {
    return <div className="p-6 text-sm text-text-secondary">Workspace owner access is required.</div>
  }

  return (
    <div className="max-w-3xl space-y-8 p-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-muted">
          <Users className="h-5 w-5 text-accent" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Workspace access</h1>
          <p className="text-sm text-text-secondary">Roles apply to every workspace-wide project.</p>
        </div>
      </div>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">Add member</h2>
          <p className="mt-1 text-sm text-text-secondary">Search active platform users to give them workspace access.</p>
        </div>
        <form className="flex gap-2" onSubmit={searchUsers}>
          <input
            value={query}
            onChange={(event) => {
              searchRevision.current += 1
              setQuery(event.target.value)
              setHasSearched(false)
              setResults([])
              setSearching(false)
            }}
            placeholder="Search by name or email"
            className="min-w-0 flex-1 rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-border-focus"
          />
          <select value={newMemberRole} onChange={(event) => setNewMemberRole(event.target.value as WorkspaceRole)} className="rounded-md border border-border bg-bg-secondary px-2 text-sm text-text-primary" aria-label="New member role">
            {workspaceRoles.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
          </select>
          <Button type="submit" variant="secondary" disabled={!rosterReady || searching || mutationPending || !query.trim()}>
            {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Search
          </Button>
        </form>
        {!rosterReady && !membersError && <p className="text-sm text-text-tertiary">Loading workspace members before you can add anyone.</p>}
        {membersError && <p className="text-sm text-status-error">Could not load workspace members.</p>}
        {rosterReady && results.length > 0 && (
          <div className="rounded-lg border border-border bg-bg-secondary">
            {results.map((person) => (
              <div key={person.id} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-0">
                <Avatar src={person.avatar_url} name={person.name} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-text-primary">{person.name}</p>
                  <p className="truncate text-xs text-text-tertiary">{person.email}</p>
                </div>
                <Button size="sm" onClick={() => addMember(person.id)} disabled={mutationPending}>
                  {pendingUserId === person.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                  Add
                </Button>
              </div>
            ))}
          </div>
        )}
        {rosterReady && hasSearched && !searching && results.length === 0 && <p className="text-sm text-text-tertiary">No eligible users found.</p>}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">Members</h2>
          <p className="mt-1 text-sm text-text-secondary">Workspace members can see every folder marked workspace-wide.</p>
        </div>
        {loadingMembers ? (
          <div className="rounded-lg border border-border bg-bg-secondary px-4 py-3 text-sm text-text-secondary">Loading members…</div>
        ) : membersError ? (
          <div className="rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-3 text-sm text-status-error">Could not load workspace members.</div>
        ) : loadingMemberUsers ? (
          <div className="rounded-lg border border-border bg-bg-secondary px-4 py-3 text-sm text-text-secondary">Loading member identities…</div>
        ) : !memberIdentitiesReady ? (
          <div className="rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-3 text-sm text-status-error">Could not load member identities.</div>
        ) : (
          <div className="rounded-lg border border-border bg-bg-secondary">
            {members?.map((member) => {
              const person = people.get(member.user_id)
              return (
                <div key={member.id} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-0">
                  <Avatar src={person?.avatar_url} name={person?.name ?? 'Deleted user'} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text-primary">{person?.name ?? 'Deleted user'}</p>
                    <p className="truncate text-xs text-text-tertiary">{person?.email ?? 'User no longer exists'}</p>
                  </div>
                  {person && (
                    <select value={member.role} onChange={(event) => updateMemberRole(member.id, event.target.value as WorkspaceRole)} disabled={mutationPending} aria-label={`${person.name} role`} className="rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary">
                      {workspaceRoles.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
                    </select>
                  )}
                  {(!person || member.role !== 'owner') && (
                    <Button variant="ghost" size="sm" onClick={() => removeMember(member.id)} disabled={mutationPending} className="text-status-error hover:text-status-error">
                      {pendingMemberId === member.id && <Loader2 className="h-4 w-4 animate-spin" />}
                      Remove
                    </Button>
                  )}
                </div>
              )
            })}
            {members?.length === 0 && <p className="px-4 py-3 text-sm text-text-tertiary">No workspace members yet.</p>}
          </div>
        )}
      </section>

      {error && <p className="text-sm text-status-error">{error}</p>}
    </div>
  )
}
