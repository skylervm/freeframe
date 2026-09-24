import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WorkspaceSettingsPage from '../page'

const state = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  mutate: vi.fn(),
  workspace: { id: 'workspace-1', name: 'Workspace', role: 'owner' },
  members: [{ id: 'owner-membership', user_id: 'owner-1', role: 'owner' }],
  membersLoading: false,
  membersError: undefined as Error | undefined,
  memberUsersLoading: false,
  memberUsersError: undefined as Error | undefined,
  memberUsers: [{ id: 'owner-1', name: 'Owner', email: 'owner@example.test' }],
}))

vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/workspace') return { data: state.workspace, isLoading: false }
    if (key === '/workspace/members') return { data: state.members, isLoading: state.membersLoading, error: state.membersError }
    if (key?.startsWith('/users?ids=')) return {
      data: state.memberUsers,
      isLoading: state.memberUsersLoading,
      error: state.memberUsersError,
    }
    return { data: undefined, isLoading: false }
  },
  mutate: state.mutate,
}))
vi.mock('@/lib/api', () => ({ api: state.api }))
vi.mock('@/stores/auth-store', () => ({ useAuthStore: () => ({ user: { id: 'owner-1' } }) }))

describe('WorkspaceSettingsPage', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    state.members = [{ id: 'owner-membership', user_id: 'owner-1', role: 'owner' }]
    state.membersLoading = false
    state.membersError = undefined
    state.memberUsersLoading = false
    state.memberUsersError = undefined
    state.memberUsers = [{ id: 'owner-1', name: 'Owner', email: 'owner@example.test' }]
    state.workspace = { id: 'workspace-1', name: 'Workspace', role: 'owner' }
  })

  it('adds a searched user as a workspace member', async () => {
    state.api.get.mockResolvedValue([{ id: 'user-1', name: 'Japeth', email: 'japeth@example.test' }])
    render(<WorkspaceSettingsPage />)

    fireEvent.change(screen.getByPlaceholderText('Search by name or email'), { target: { value: 'Japeth' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }))

    await waitFor(() => expect(state.api.post).toHaveBeenCalledWith('/workspace/members', { user_id: 'user-1', role: 'viewer' }))
    expect(state.mutate).toHaveBeenCalledWith('/workspace/members')
  })

  it('waits for the roster before showing member controls or search', () => {
    state.membersLoading = true
    render(<WorkspaceSettingsPage />)

    expect(screen.getByText('Loading members…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled()
  })

  it('ignores form submits while the roster is loading', () => {
    state.membersLoading = true
    render(<WorkspaceSettingsPage />)

    const searchButton = screen.getByRole('button', { name: 'Search' })
    fireEvent.submit(searchButton.closest('form')!)

    expect(state.api.get).not.toHaveBeenCalled()
  })

  it('shows a roster error instead of incorrect member actions', () => {
    state.membersError = new Error('Request failed')
    render(<WorkspaceSettingsPage />)

    expect(screen.getAllByText('Could not load workspace members.')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled()
  })

  it('withholds member removal until identities load', () => {
    state.memberUsersLoading = true
    render(<WorkspaceSettingsPage />)

    expect(screen.getByText('Loading member identities…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
  })

  it('keeps deleted-user memberships removable', () => {
    state.members = [
      { id: 'owner-membership', user_id: 'owner-1', role: 'owner' },
      { id: 'deleted-membership', user_id: 'deleted-user', role: 'viewer' },
    ]
    render(<WorkspaceSettingsPage />)

    expect(screen.getByText('Deleted user')).toBeInTheDocument()
    expect(screen.getByText('User no longer exists')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument()
  })

  it('keeps deleted workspace owners removable', () => {
    state.members = [
      { id: 'deleted-owner-membership', user_id: 'deleted-owner', role: 'owner' },
    ]
    render(<WorkspaceSettingsPage />)

    expect(screen.getByText('Deleted user')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument()
  })

  it('rejects users who are not workspace owners', () => {
    state.workspace = { id: 'workspace-1', name: 'Workspace', role: 'viewer' }
    render(<WorkspaceSettingsPage />)

    expect(screen.getByText('Workspace owner access is required.')).toBeInTheDocument()
  })

  it('does not offer a remove action for workspace owners', () => {
    render(<WorkspaceSettingsPage />)

    expect(screen.getByRole('combobox', { name: 'Owner role' })).toHaveValue('owner')
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
  })

  it('adds a member with the selected workspace role', async () => {
    state.api.get.mockResolvedValue([{ id: 'user-1', name: 'Japeth', email: 'japeth@example.test' }])
    render(<WorkspaceSettingsPage />)

    fireEvent.change(screen.getByRole('combobox', { name: 'New member role' }), { target: { value: 'reviewer' } })
    fireEvent.change(screen.getByPlaceholderText('Search by name or email'), { target: { value: 'Japeth' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }))

    await waitFor(() => expect(state.api.post).toHaveBeenCalledWith('/workspace/members', { user_id: 'user-1', role: 'reviewer' }))
  })

  it('updates an existing member role', async () => {
    state.members = [
      { id: 'owner-membership', user_id: 'owner-1', role: 'owner' },
      { id: 'member-membership', user_id: 'member-1', role: 'viewer' },
    ]
    state.memberUsers = [
      { id: 'owner-1', name: 'Owner', email: 'owner@example.test' },
      { id: 'member-1', name: 'Member', email: 'member@example.test' },
    ]
    render(<WorkspaceSettingsPage />)

    fireEvent.change(screen.getByRole('combobox', { name: 'Member role' }), { target: { value: 'reviewer' } })

    await waitFor(() => expect(state.api.patch).toHaveBeenCalledWith('/workspace/members/member-membership', { role: 'reviewer' }))
  })

  it('clears an old search result when the query changes', async () => {
    state.api.get.mockResolvedValue([{ id: 'user-1', name: 'Japeth', email: 'japeth@example.test' }])
    render(<WorkspaceSettingsPage />)

    fireEvent.change(screen.getByPlaceholderText('Search by name or email'), { target: { value: 'Japeth' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(await screen.findByRole('button', { name: 'Add' })).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('Search by name or email'), { target: { value: 'Someone else' } })
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument()
  })

  it('ignores a search response that finishes after the query changes', async () => {
    let resolveSearch: (users: Array<{ id: string; name: string; email: string }>) => void = () => {}
    state.api.get.mockImplementation(() => new Promise((resolve) => {
      resolveSearch = resolve
    }))
    render(<WorkspaceSettingsPage />)

    fireEvent.change(screen.getByPlaceholderText('Search by name or email'), { target: { value: 'Japeth' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.change(screen.getByPlaceholderText('Search by name or email'), { target: { value: 'Someone else' } })
    await act(async () => resolveSearch([{ id: 'user-1', name: 'Japeth', email: 'japeth@example.test' }]))

    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument()
  })

  it('disables every add action while a membership change is pending', async () => {
    state.api.get.mockResolvedValue([
      { id: 'user-1', name: 'Japeth', email: 'japeth@example.test' },
      { id: 'user-2', name: 'Another user', email: 'another@example.test' },
    ])
    state.api.post.mockImplementation(() => new Promise(() => {}))
    render(<WorkspaceSettingsPage />)

    fireEvent.change(screen.getByPlaceholderText('Search by name or email'), { target: { value: 'user' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    const addButtons = await screen.findAllByRole('button', { name: 'Add' })
    fireEvent.click(addButtons[0])

    await waitFor(() => expect(addButtons.every((button) => button.hasAttribute('disabled'))).toBe(true))

    fireEvent.submit(screen.getByRole('button', { name: 'Search' }).closest('form')!)
    expect(state.api.get).toHaveBeenCalledTimes(1)
  })
})
