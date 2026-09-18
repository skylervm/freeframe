import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'
import { CommentPanel, useCommentView, type CommentView } from '../comment-panel'

beforeEach(() => {
  useReviewStore.getState().reset()
  Element.prototype.scrollIntoView = vi.fn()
})

const noop = async () => {}

function makeComment(over: Record<string, unknown>) {
  return {
    asset_id: 'a1', version_id: 'v1', parent_id: null,
    author: { id: 'u1', name: 'Maya Chen', avatar_url: null },
    timecode_start: null, timecode_end: null, resolved: false, visibility: 'public',
    annotation: null, created_at: '2026-01-01T10:00:00.000Z',
    updated_at: '2026-01-01T10:00:00.000Z',
    replies: [], reactions: [], attachments: [],
    ...over,
  } as never
}

const comments = [
  makeComment({ id: 'p1', body: 'Comment public one' }),
  makeComment({ id: 'i1', body: 'Comment internal one', visibility: 'internal' }),
]

// Owns the view the way the review page does, and hands it out so a test can
// drive it from "outside" — the role the phone More menu plays.
function renderWithSharedView() {
  let shared: CommentView | undefined
  function Harness() {
    const view = useCommentView()
    shared = view
    return (
      <CommentPanel
        comments={comments}
        onResolve={noop} onDelete={noop}
        onAddReaction={noop} onRemoveReaction={noop}
        onReply={() => {}}
        view={view}
        compactToolbar
      />
    )
  }
  render(<Harness />)
  return () => shared as CommentView
}

const bodies = () => screen.getAllByText(/^Comment /).map((el) => el.textContent)

describe('CommentPanel with a shared view on phones', () => {
  it('hides its inline toolbar below md but keeps it for desktop', () => {
    renderWithSharedView()

    const toolbar = screen.getByTitle('Sort').closest('.shrink-0.justify-between')
    expect(toolbar).toHaveClass('hidden', 'md:flex')
  })

  it('keeps the toolbar visible everywhere when not compact', () => {
    render(
      <CommentPanel
        comments={comments}
        onResolve={noop} onDelete={noop}
        onAddReaction={noop} onRemoveReaction={noop}
        onReply={() => {}}
      />,
    )

    const toolbar = screen.getByTitle('Sort').closest('.shrink-0.justify-between')
    expect(toolbar).not.toHaveClass('hidden')
  })

  it('narrows the list when the view is changed from outside the panel', () => {
    const view = renderWithSharedView()
    expect(bodies()).toEqual(['Comment public one', 'Comment internal one'])

    act(() => view().setVisibility('internal'))

    expect(bodies()).toEqual(['Comment internal one'])
  })

  it('opens the search field when search is started from outside the panel', () => {
    const view = renderWithSharedView()
    expect(screen.queryByPlaceholderText('Search...')).toBeNull()

    act(() => view().setSearchOpen(true))
    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'internal' } })

    expect(bodies()).toEqual(['Comment internal one'])
  })

  it('shows what the list is narrowed to, because the toolbar that would say so is hidden', () => {
    const view = renderWithSharedView()
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()

    act(() => {
      view().setVisibility('public')
      view().toggleFilter('annotations')
    })

    const chip = screen.getByRole('button', { name: 'Clear' }).parentElement
    expect(chip).toHaveClass('md:hidden')
    expect(chip).toHaveTextContent('Public comments · 1 filter')

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))

    expect(view().visibility).toBe('all')
    expect(Object.values(view().filters).some(Boolean)).toBe(false)
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
  })

  it('reset returns the view to its defaults', () => {
    const view = renderWithSharedView()
    act(() => {
      view().setVisibility('internal')
      view().setSortMode('newest')
      view().toggleFilter('annotations')
      view().setSearchOpen(true)
      view().setSearchQuery('x')
    })

    act(() => view().reset())

    expect(view().visibility).toBe('all')
    expect(view().sortMode).toBe('timecode')
    expect(Object.values(view().filters).some(Boolean)).toBe(false)
    expect(view().searchOpen).toBe(false)
    expect(view().searchQuery).toBe('')
  })
})
