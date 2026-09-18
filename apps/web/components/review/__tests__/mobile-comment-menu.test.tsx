import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { MobileCommentMenuItems } from '../mobile-comment-menu'
import type { CommentView } from '../comment-panel'

function makeView(over: Partial<CommentView> = {}): CommentView {
  return {
    visibility: 'all',
    setVisibility: vi.fn(),
    sortMode: 'timecode',
    setSortMode: vi.fn(),
    filters: {
      annotations: false, attachments: false, completed: false,
      incomplete: false, unread: false, mentionsReactions: false,
    },
    toggleFilter: vi.fn(),
    clearFilters: vi.fn(),
    searchOpen: false,
    setSearchOpen: vi.fn(),
    searchQuery: '',
    setSearchQuery: vi.fn(),
    fpsPromptFormat: null,
    setFpsPromptFormat: vi.fn(),
    exportAs: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
    ...over,
  }
}

const comments = [
  { id: 'p1', parent_id: null, visibility: 'public' },
  { id: 'p2', parent_id: null, visibility: 'public' },
  { id: 'i1', parent_id: null, visibility: 'internal' },
  { id: 'r1', parent_id: 'p1', visibility: 'public' },
] as never

function renderMenu(view: CommentView, assetType = 'video') {
  render(
    <DropdownMenu.Root open>
      <DropdownMenu.Content>
        <MobileCommentMenuItems view={view} comments={comments} assetType={assetType} />
      </DropdownMenu.Content>
    </DropdownMenu.Root>,
  )
}

// jsdom has no layout, so Radix's pointer "grace area" between a submenu trigger
// and its content can't be computed: a simulated pointer move closes the
// submenu before the click lands. Plain click events open and select directly.
const click = (element: HTMLElement) => fireEvent.click(element)

beforeEach(() => {
  // Radix positions submenus with ResizeObserver, which jsdom lacks.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never
})

describe('MobileCommentMenuItems', () => {
  it('lists every comment control under a Comments heading', () => {
    renderMenu(makeView())

    expect(screen.getByText('Comments')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Show: All comments' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Sort: Timecode' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Filter' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Search comments' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Download comments' })).toBeInTheDocument()
  })

  it('names the current view and filter count on the triggers', () => {
    renderMenu(
      makeView({
        visibility: 'internal',
        sortMode: 'newest',
        filters: {
          annotations: true, attachments: false, completed: true,
          incomplete: false, unread: false, mentionsReactions: false,
        },
      }),
    )

    expect(screen.getByRole('menuitem', { name: 'Show: Internal comments' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Sort: Newest' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Filter (2)' })).toBeInTheDocument()
  })

  it('switches visibility, with top-level counts that ignore replies', () => {
    const view = makeView()
    renderMenu(view)

    click(screen.getByRole('menuitem', { name: 'Show: All comments' }))
    const count = (label: RegExp) =>
      within(screen.getByRole('menuitemradio', { name: label })).getByText(/^\d+$/).textContent
    expect(count(/^All comments/)).toBe('3')
    expect(count(/^Public comments/)).toBe('2')
    expect(count(/^Internal comments/)).toBe('1')
    click(screen.getByRole('menuitemradio', { name: /^Internal comments/ }))

    expect(view.setVisibility).toHaveBeenCalledWith('internal')
  })

  it('changes the sort', () => {
    const view = makeView()
    renderMenu(view)

    click(screen.getByRole('menuitem', { name: 'Sort: Timecode' }))
    click(screen.getByRole('menuitemradio', { name: 'Oldest' }))

    expect(view.setSortMode).toHaveBeenCalledWith('oldest')
  })

  it('toggles a filter and offers Clear only once one is on', () => {
    const view = makeView()
    renderMenu(view)

    click(screen.getByRole('menuitem', { name: 'Filter' }))
    expect(screen.queryByRole('menuitem', { name: 'Clear filters' })).toBeNull()
    click(screen.getByRole('menuitemcheckbox', { name: 'Annotations' }))

    expect(view.toggleFilter).toHaveBeenCalledWith('annotations')
  })

  it('clears filters', () => {
    const view = makeView({
      filters: {
        annotations: true, attachments: false, completed: false,
        incomplete: false, unread: false, mentionsReactions: false,
      },
    })
    renderMenu(view)

    click(screen.getByRole('menuitem', { name: 'Filter (1)' }))
    click(screen.getByRole('menuitem', { name: 'Clear filters' }))

    expect(view.clearFilters).toHaveBeenCalled()
  })

  it('starts a search and tells the host menu it was picked', () => {
    const view = makeView()
    const onSearch = vi.fn()
    render(
      <DropdownMenu.Root open>
        <DropdownMenu.Content>
          <MobileCommentMenuItems view={view} comments={comments} assetType="video" onSearch={onSearch} />
        </DropdownMenu.Content>
      </DropdownMenu.Root>,
    )

    click(screen.getByRole('menuitem', { name: 'Search comments' }))

    expect(view.setSearchOpen).toHaveBeenCalledWith(true)
    expect(onSearch).toHaveBeenCalledTimes(1)
  })

  it('marks the current Show choice with a check, like Sort and Filter', () => {
    renderMenu(makeView({ visibility: 'public' }))

    click(screen.getByRole('menuitem', { name: 'Show: Public comments' }))

    const checked = screen.getByRole('menuitemradio', { checked: true })
    expect(checked).toHaveTextContent(/^Public comments/)
    expect(checked.querySelector('svg')).not.toBeNull()
    expect(
      screen.getByRole('menuitemradio', { name: /^All comments/ }).querySelector('svg'),
    ).toBeNull()
  })

  it('offers editor exports for video and CSV for everything', () => {
    const view = makeView()
    renderMenu(view)

    click(screen.getByRole('menuitem', { name: 'Download comments' }))
    expect(screen.getByRole('menuitem', { name: 'DaVinci Resolve (EDL)' })).toBeInTheDocument()
    click(screen.getByRole('menuitem', { name: 'CSV' }))

    expect(view.exportAs).toHaveBeenCalledWith('csv')
  })

  it('offers only CSV for non-video assets', () => {
    renderMenu(makeView(), 'image')

    click(screen.getByRole('menuitem', { name: 'Download comments' }))

    expect(screen.queryByRole('menuitem', { name: 'DaVinci Resolve (EDL)' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'CSV' })).toBeInTheDocument()
  })
})
