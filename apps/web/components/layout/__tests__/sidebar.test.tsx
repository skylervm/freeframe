import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setViewportWidth } from '../../../test/setup'
import { Sidebar } from '../sidebar'

const uploadStore = {
  files: [],
  togglePanel: vi.fn(),
  panelOpen: false,
}
const notificationStore = {
  unreadCount: 0,
  fetchNotifications: vi.fn(),
}

vi.mock('next/navigation', () => ({ usePathname: () => '/projects' }))
vi.mock('swr', () => ({ default: () => ({ data: null }) }))
vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({ user: null, logout: vi.fn(), isSuperAdmin: false }),
}))
vi.mock('@/stores/upload-store', () => ({ useUploadStore: () => uploadStore }))
vi.mock('@/stores/notification-store', () => ({ useNotificationStore: () => notificationStore }))
vi.mock('@/stores/branding-store', () => ({
  useBrandingStore: () => ({ orgName: 'FreeFrame', orgLogoDark: null, orgLogoLight: null }),
}))
vi.mock('@/stores/theme-store', () => ({ useThemeStore: () => ({ theme: 'dark' }) }))
vi.mock('@/components/shared/storage-usage', () => ({
  StorageUsage: () => null,
  StorageRing: () => null,
}))
vi.mock('../notification-drawer', () => ({ NotificationDrawer: () => null }))
vi.mock('@/components/shared/avatar', () => ({ Avatar: () => <span>Avatar</span> }))

function renderSidebar(mobileOpen: boolean, onMobileClose = vi.fn()) {
  return {
    onMobileClose,
    ...render(
      <Sidebar
        collapsed
        mobileOpen={mobileOpen}
        onMobileClose={onMobileClose}
        onToggle={vi.fn()}
      />,
    ),
  }
}

describe('mobile navigation drawer', () => {
  beforeEach(() => {
    setViewportWidth(390)
    vi.clearAllMocks()
  })

  it('is inert and hidden from assistive technology while closed', () => {
    renderSidebar(false)

    const navigation = screen.getByRole('complementary', { hidden: true })
    expect(navigation).toHaveAttribute('inert')
    expect(navigation).toHaveAttribute('aria-hidden', 'true')
  })

  it('moves focus into the open drawer and keeps Tab navigation inside it', async () => {
    renderSidebar(true)

    const projects = screen.getByRole('link', { name: 'Projects' })
    await waitFor(() => expect(projects).toHaveFocus())
    expect(screen.getByTitle('Collapse sidebar')).toBeDisabled()

    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    fireEvent.keyDown(document, { key: 'Tab' })

    expect(projects).toHaveFocus()

    const navigation = document.getElementById('dashboard-navigation')!
    const focusable = Array.from(
      navigation.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
    )
    const last = focusable[focusable.length - 1]
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(projects).toHaveFocus()

    projects.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()
    outside.remove()
  })

  it('requests a focus-restoring close when Escape dismisses the drawer', () => {
    const { onMobileClose } = renderSidebar(true)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onMobileClose).toHaveBeenCalledWith()
  })

  it('closes the drawer before opening notifications or uploads', () => {
    const notification = renderSidebar(true)
    fireEvent.click(screen.getByText('Notifications'))
    expect(notification.onMobileClose).toHaveBeenCalledWith(false)

    notification.unmount()
    const upload = renderSidebar(true)
    fireEvent.click(screen.getByText('Uploads'))
    expect(upload.onMobileClose).toHaveBeenCalledWith(false)
    expect(uploadStore.togglePanel).toHaveBeenCalledOnce()
  })
})
