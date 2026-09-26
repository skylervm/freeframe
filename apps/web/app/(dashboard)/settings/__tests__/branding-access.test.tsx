import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SettingsLayout from '../layout'

const state = vi.hoisted(() => ({
  isSuperAdmin: false,
  role: 'owner' as string | undefined,
}))

vi.mock('next/navigation', () => ({ usePathname: () => '/settings/profile' }))
vi.mock('swr', () => ({
  default: (key: string | null) => ({ data: key === '/workspace' && state.role ? { role: state.role } : undefined }),
}))
vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({ user: { id: 'u1' }, isSuperAdmin: state.isSuperAdmin }),
}))

describe('settings nav: Branding access', () => {
  afterEach(() => { cleanup(); state.isSuperAdmin = false; state.role = 'owner' })

  it('shows Branding to a workspace owner who is not a superadmin', () => {
    render(<SettingsLayout><div /></SettingsLayout>)
    expect(screen.getByText('Branding')).toBeInTheDocument()
    expect(screen.queryByText('Admin')).not.toBeInTheDocument()
  })

  it('shows Branding to a superadmin who is not an owner', () => {
    state.isSuperAdmin = true
    state.role = 'viewer'
    render(<SettingsLayout><div /></SettingsLayout>)
    expect(screen.getByText('Branding')).toBeInTheDocument()
  })

  it('hides Branding from other workspace members', () => {
    state.role = 'editor'
    render(<SettingsLayout><div /></SettingsLayout>)
    expect(screen.queryByText('Branding')).not.toBeInTheDocument()
  })
})
