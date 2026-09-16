'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  Layers,
  Bell,
  Upload,
  Settings,
  LogOut,
  User,
  ChevronsLeft,
  Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'
import { useUploadStore } from '@/stores/upload-store'
import { useNotificationStore } from '@/stores/notification-store'
import { useBrandingStore } from '@/stores/branding-store'
import { useThemeStore } from '@/stores/theme-store'
import { Avatar } from '@/components/shared/avatar'
import { NotificationDrawer } from './notification-drawer'
import useSWR from 'swr'
import { api } from '@/lib/api'
import { StorageUsage, StorageRing } from '@/components/shared/storage-usage'
import type { InstanceSettings } from '@/types'

interface NavItem {
  href: string
  label: string
  icon: React.ElementType
}

const navItems: NavItem[] = [
  { href: '/projects', label: 'Projects', icon: Layers },
  { href: '/trash', label: 'Trash', icon: Trash2 },
]

interface SidebarProps {
  collapsed: boolean
  mobileOpen: boolean
  onToggle: () => void
  onMobileClose: (restoreFocus?: boolean) => void
}

export function Sidebar({ collapsed, mobileOpen, onToggle, onMobileClose }: SidebarProps) {
  const sidebarRef = React.useRef<HTMLElement>(null)
  const pathname = usePathname()
  const { user, logout, isSuperAdmin } = useAuthStore()
  const { files: uploadFiles, togglePanel, panelOpen } = useUploadStore()
  const { unreadCount, fetchNotifications } = useNotificationStore()
  const { orgName, orgLogoDark, orgLogoLight } = useBrandingStore()
  const { theme } = useThemeStore()
  const compact = collapsed && !mobileOpen
  // Pick logo based on resolved theme; fall back to the other if only one is set
  const customLogo = theme === 'light'
    ? (orgLogoLight ?? orgLogoDark)
    : (orgLogoDark ?? orgLogoLight)
  const [notifOpen, setNotifOpen] = React.useState(false)
  const activeUploads = uploadFiles.filter((f) => f.status === 'uploading' || f.status === 'pending' || f.status === 'processing').length
  const { data: instance } = useSWR<InstanceSettings>(
    '/instance/settings',
    () => api.get<InstanceSettings>('/instance/settings'),
  )

  // Fetch notifications on mount
  React.useEffect(() => { fetchNotifications() }, [fetchNotifications])

  React.useEffect(() => {
    if (!mobileOpen) return
    const frame = requestAnimationFrame(() => {
      sidebarRef.current
        ?.querySelector<HTMLElement>('[data-mobile-navigation-initial-focus]')
        ?.focus()
    })
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onMobileClose()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = Array.from(
        sidebarRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => !element.hasAttribute('inert'))
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      } else if (!sidebarRef.current?.contains(document.activeElement)) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [mobileOpen, onMobileClose])

  React.useEffect(() => {
    const sidebar = sidebarRef.current
    if (!sidebar) return
    const mobile = window.matchMedia('(max-width: 767px)')
    const updateAccessibility = () => {
      const isClosedMobileDrawer = mobile.matches && !mobileOpen
      sidebar.toggleAttribute('inert', isClosedMobileDrawer)
      sidebar.setAttribute('aria-hidden', String(isClosedMobileDrawer))
    }
    updateAccessibility()
    mobile.addEventListener('change', updateAccessibility)
    return () => mobile.removeEventListener('change', updateAccessibility)
  }, [mobileOpen])

  return (
    <>
    {mobileOpen && (
      <button
        type="button"
        aria-label="Close navigation"
        className="fixed inset-0 z-20 bg-black/45 md:hidden"
        onClick={() => onMobileClose()}
      />
    )}
    <aside
      id="dashboard-navigation"
      ref={sidebarRef}
      role={mobileOpen ? 'dialog' : undefined}
      aria-label={mobileOpen ? 'Navigation' : undefined}
      aria-modal={mobileOpen || undefined}
      className={cn(
        'fixed left-0 top-0 z-30 flex h-screen w-[280px] flex-col border-r border-border',
        'bg-bg-secondary overflow-hidden transition-[transform,width] duration-200',
        mobileOpen ? 'translate-x-0' : '-translate-x-full',
        'md:translate-x-0',
        collapsed ? 'md:w-[52px]' : 'md:w-[220px]',
      )}
    >
      {/* Logo */}
      <div
        className={cn(
          'flex h-12 items-center shrink-0 border-b border-border',
          compact ? 'justify-center px-0' : 'px-4 gap-2.5',
        )}
      >
        {/* Logo: theme-aware custom logo, or default FreeFrame icons */}
        {customLogo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={customLogo}
            alt={orgName}
            className="h-7 w-7 shrink-0 object-contain rounded"
          />
        ) : (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo-icon.png"
              alt={orgName}
              className="h-7 w-7 shrink-0 object-contain logo-dark"
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo-icon-dark.png"
              alt={orgName}
              className="h-7 w-7 shrink-0 object-contain logo-light"
            />
          </>
        )}
        {!compact && (
          <span className="text-sm font-semibold text-text-primary tracking-tight">
            {orgName}
          </span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden py-2 px-2 space-y-0.5">
        {navItems.map((item) => {
          const isActive =
            item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => {
                setNotifOpen(false)
                onMobileClose()
              }}
              className={cn(
                'group relative flex items-center rounded-md transition-colors duration-100',
                compact ? 'justify-center h-9 w-9 mx-auto' : 'gap-2.5 px-2.5 h-9',
                isActive
                  ? 'bg-bg-hover text-text-primary'
                  : 'text-text-secondary hover:bg-bg-hover/60 hover:text-text-primary',
              )}
              title={compact ? item.label : undefined}
              data-mobile-navigation-initial-focus={item.href === '/projects' || undefined}
            >
              <Icon className="h-[18px] w-[18px] shrink-0" strokeWidth={isActive ? 2 : 1.5} />
              {!compact && (
                <span className={cn('text-[13px]', isActive && 'font-medium')}>
                  {item.label}
                </span>
              )}
            </Link>
          )
        })}

        {/* Notifications button */}
        <button
          onClick={() => {
            onMobileClose(false)
            setNotifOpen((v) => !v)
          }}
          className={cn(
            'group relative flex w-full items-center rounded-md transition-colors duration-100',
            compact ? 'justify-center h-9 w-9 mx-auto' : 'gap-2.5 px-2.5 h-9',
            notifOpen
              ? 'bg-bg-hover text-text-primary'
              : 'text-text-secondary hover:bg-bg-hover/60 hover:text-text-primary',
          )}
          title={compact ? 'Notifications' : undefined}
        >
          <div className="relative shrink-0">
            <Bell className="h-[18px] w-[18px]" strokeWidth={notifOpen ? 2 : 1.5} />
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-status-error px-0.5 text-[9px] font-bold text-white">
                {unreadCount}
              </span>
            )}
          </div>
          {!compact && (
            <span className={cn('text-[13px]', notifOpen && 'font-medium')}>
              Notifications
            </span>
          )}
        </button>

        {/* Uploads button */}
        <button
          onClick={() => {
            onMobileClose(false)
            setNotifOpen(false)
            togglePanel()
          }}
          className={cn(
            'group relative flex w-full items-center rounded-md transition-colors duration-100',
            compact ? 'justify-center h-9 w-9 mx-auto' : 'gap-2.5 px-2.5 h-9',
            panelOpen
              ? 'bg-bg-hover text-text-primary'
              : 'text-text-secondary hover:bg-bg-hover/60 hover:text-text-primary',
          )}
          title={compact ? 'Uploads' : undefined}
        >
          <div className="relative shrink-0">
            <Upload className="h-[18px] w-[18px]" strokeWidth={panelOpen ? 2 : 1.5} />
            {activeUploads > 0 && (
              <span className="absolute -top-1 -right-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[9px] font-bold text-white">
                {activeUploads}
              </span>
            )}
          </div>
          {!compact && (
            <span className={cn('text-[13px]', panelOpen && 'font-medium')}>
              Uploads
            </span>
          )}
        </button>
      </nav>

      {/* Bottom section */}
      <div className="border-t border-border p-2 space-y-1 shrink-0">
        {/* Instance storage indicator — ring when collapsed, used/limit bar when expanded */}
        {instance && (
          <div className={cn(compact ? 'flex justify-center py-1' : 'px-2.5 py-1.5')}>
            {compact ? (
              <StorageRing
                used={instance.storage_used_bytes}
                limit={instance.storage_limit_bytes}
              />
            ) : (
              <StorageUsage
                used={instance.storage_used_bytes}
                limit={instance.storage_limit_bytes}
                variant="sidebar"
              />
            )}
          </div>
        )}
        {/* User dropdown */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              className={cn(
                'flex w-full items-center rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors',
                compact ? 'justify-center h-9 w-9 mx-auto' : 'gap-2.5 px-2 py-1.5',
              )}
              title={compact ? (user?.name ?? 'Account') : undefined}
            >
              <Avatar
                src={user?.avatar_url}
                name={user?.name}
                size="sm"
              />
              {!compact && (
                <div className="flex flex-col items-start overflow-hidden min-w-0">
                  <span className="truncate text-[13px] font-medium text-text-primary leading-tight w-full text-left">
                    {user?.name ?? 'User'}
                  </span>
                  <span className="truncate text-[10px] text-text-tertiary leading-tight w-full text-left">
                    {user?.email ?? ''}
                  </span>
                </div>
              )}
            </button>
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="top"
              align={compact ? 'start' : 'end'}
              sideOffset={8}
              className="z-50 min-w-[180px] rounded-lg border border-border bg-bg-elevated p-1 shadow-xl animate-slide-up"
            >
              <DropdownMenu.Item asChild>
                <Link
                  href="/settings/profile"
                  onClick={() => onMobileClose(false)}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-text-secondary hover:bg-bg-hover hover:text-text-primary focus:outline-none"
                >
                  <User className="h-4 w-4" />
                  Profile
                </Link>
              </DropdownMenu.Item>
              <DropdownMenu.Item asChild>
                <Link
                  href={isSuperAdmin ? '/settings/admin' : '/settings/appearance'}
                  onClick={() => onMobileClose(false)}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-text-secondary hover:bg-bg-hover hover:text-text-primary focus:outline-none"
                >
                  <Settings className="h-4 w-4" />
                  Settings
                </Link>
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Item
                onSelect={() => {
                  onMobileClose(false)
                  logout()
                }}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-status-error hover:bg-status-error/10 focus:outline-none"
              >
                <LogOut className="h-4 w-4" />
                Log out
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        {/* Collapse toggle */}
        <button
          onClick={onToggle}
          disabled={mobileOpen}
          tabIndex={mobileOpen ? -1 : undefined}
          className={cn(
            'hidden w-full items-center rounded-md text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary md:flex',
            compact ? 'justify-center h-8 w-8 mx-auto' : 'gap-2 px-2.5 h-8',
          )}
          title={compact ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <ChevronsLeft className={cn('h-4 w-4 transition-transform', compact && 'rotate-180')} />
          {!compact && <span className="text-xs">Collapse</span>}
        </button>
      </div>
    </aside>

    {/* Notification Drawer */}
    <NotificationDrawer open={notifOpen} onClose={() => setNotifOpen(false)} />
  </>
  )
}
