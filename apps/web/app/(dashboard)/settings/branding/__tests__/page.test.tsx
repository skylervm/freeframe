import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BrandingPage from '../page'

const state = vi.hoisted(() => ({ isSuperadmin: false, role: 'owner' }))

vi.mock('swr', () => ({
  default: (key: string | null) => ({ data: key === '/workspace' ? { role: state.role } : undefined }),
}))
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn() } }))
vi.mock('@/lib/workspace-branding', () => ({ saveWorkspaceBranding: vi.fn() }))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({ user: { id: 'u1', is_superadmin: state.isSuperadmin } }),
}))

const NOT_ALLOWED = 'Only super admins and workspace owners can edit branding settings.'

describe('BrandingPage edit access', () => {
  afterEach(() => { cleanup(); state.isSuperadmin = false; state.role = 'owner' })

  it('lets a workspace owner edit', () => {
    render(<BrandingPage />)
    expect(screen.queryByText(NOT_ALLOWED)).not.toBeInTheDocument()
  })

  it('lets a superadmin edit without being an owner', () => {
    state.isSuperadmin = true
    state.role = 'viewer'
    render(<BrandingPage />)
    expect(screen.queryByText(NOT_ALLOWED)).not.toBeInTheDocument()
  })

  it.each(['editor', 'reviewer', 'viewer'])('keeps a workspace %s read-only', (role) => {
    state.role = role
    render(<BrandingPage />)
    expect(screen.getByText(NOT_ALLOWED)).toBeInTheDocument()
  })
})
