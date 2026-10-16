import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'
import { CommentPanel } from '../comment-panel'

const patch = vi.fn()
vi.mock('@/lib/api', () => ({ api: { patch: (...args: unknown[]) => patch(...args), get: vi.fn() } }))

beforeEach(() => {
  useReviewStore.getState().reset()
  patch.mockReset()
  patch.mockResolvedValue({})
  // jsdom does not implement scrollIntoView; CommentItem calls it when focused.
  Element.prototype.scrollIntoView = vi.fn()
})

const noop = async () => {}

function rangeComment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1', asset_id: 'a1', version_id: 'v1', parent_id: null, author_id: 'u-author',
    author: { id: 'u-author', name: 'Japeth', avatar_url: null },
    body: 'Clip 3', timecode_start: 757, timecode_end: 771.5, locked_at: null,
    resolved: false, visibility: 'public',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    replies: [], reactions: [], attachments: [],
    ...overrides,
  } as never
}

function panel(props: Partial<React.ComponentProps<typeof CommentPanel>> = {}, comment = rangeComment()) {
  return render(
    <CommentPanel
      comments={[comment]}
      currentUserId="u-viewer"
      onResolve={noop} onDelete={noop}
      onAddReaction={noop} onRemoveReaction={noop}
      onReply={() => {}}
      {...props}
    />,
  )
}

describe('playing a range comment as a clip', () => {
  it('clicking the comment plays just that range, looping', () => {
    panel({ clipPlayback: { isProjectOwner: false } })

    fireEvent.click(screen.getByText('Clip 3'))

    const state = useReviewStore.getState()
    expect(state.activeClip).toEqual({ commentId: 'c1', range: { start: 757, end: 771.5 }, editing: false })
    expect(state.loopRange).toBe(true)
    expect(state.seekTarget).toMatchObject({ time: 757, play: true })
  })

  it('clicking the time badge does the same', () => {
    panel({ clipPlayback: { isProjectOwner: false } })

    fireEvent.click(screen.getByTitle('Jump to timecode'))

    expect(useReviewStore.getState().activeClip?.commentId).toBe('c1')
  })

  it('keeps the old seek-and-pause where clip playback is not turned on', () => {
    panel()

    fireEvent.click(screen.getByText('Clip 3'))

    expect(useReviewStore.getState().activeClip).toBeNull()
    expect(useReviewStore.getState().seekTarget).toMatchObject({ time: 757, pause: true })
  })

  it('does not turn a point comment into a clip', () => {
    panel({ clipPlayback: { isProjectOwner: true } }, rangeComment({ timecode_end: null }))

    fireEvent.click(screen.getByText('Clip 3'))

    expect(useReviewStore.getState().activeClip).toBeNull()
  })

  it('does not turn compare-mode seeks into clips', () => {
    const onSeek = vi.fn()
    panel({ clipPlayback: { isProjectOwner: true }, onSeekToTimecode: onSeek })

    fireEvent.click(screen.getByText('Clip 3'))

    expect(useReviewStore.getState().activeClip).toBeNull()
    expect(onSeek).toHaveBeenCalledWith(757, true)
  })

  it('shows the controls only on the clip that is playing', () => {
    panel({ clipPlayback: { isProjectOwner: false } })
    expect(screen.queryByTestId('clip-controls')).toBeNull()

    fireEvent.click(screen.getByText('Clip 3'))

    expect(screen.getByTestId('clip-controls')).toBeTruthy()
  })

  it('the Loop button turns looping off and on', () => {
    panel({ clipPlayback: { isProjectOwner: false } })
    fireEvent.click(screen.getByText('Clip 3'))

    const loop = screen.getByRole('button', { name: /loop/i })
    expect(loop.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(loop)
    expect(useReviewStore.getState().loopRange).toBe(false)
    expect(screen.getByRole('button', { name: /loop/i }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: /loop/i }))
    expect(useReviewStore.getState().loopRange).toBe(true)
  })

  it('the stop button ends the clip', () => {
    panel({ clipPlayback: { isProjectOwner: false } })
    fireEvent.click(screen.getByText('Clip 3'))

    fireEvent.click(screen.getByRole('button', { name: /stop playing/i }))

    expect(useReviewStore.getState().activeClip).toBeNull()
    expect(screen.queryByTestId('clip-controls')).toBeNull()
  })
})

describe('editing a clip range', () => {
  it('another member sees no Edit button', () => {
    panel({ clipPlayback: { isProjectOwner: false } })
    fireEvent.click(screen.getByText('Clip 3'))

    expect(screen.queryByRole('button', { name: /edit range/i })).toBeNull()
  })

  it('the comment author gets one', () => {
    panel({ currentUserId: 'u-author', clipPlayback: { isProjectOwner: false } })
    fireEvent.click(screen.getByText('Clip 3'))

    expect(screen.getByRole('button', { name: /edit range/i })).toBeTruthy()
  })

  it('the project owner gets one on someone else\'s comment', () => {
    panel({ clipPlayback: { isProjectOwner: true } })
    fireEvent.click(screen.getByText('Clip 3'))

    expect(screen.getByRole('button', { name: /edit range/i })).toBeTruthy()
  })

  it('Edit puts the handles out, and clicking the card then does not restart the clip', () => {
    panel({ clipPlayback: { isProjectOwner: true } })
    fireEvent.click(screen.getByText('Clip 3'))
    fireEvent.click(screen.getByRole('button', { name: /edit range/i }))
    expect(useReviewStore.getState().activeClip?.editing).toBe(true)

    const seekBefore = useReviewStore.getState().seekTarget
    fireEvent.click(screen.getByText('Clip 3'))

    expect(useReviewStore.getState().seekTarget).toBe(seekBefore)
  })

  it('Save sends both times and leaves edit mode', async () => {
    const comment = rangeComment()
    panel({ clipPlayback: { isProjectOwner: true } }, comment)
    fireEvent.click(screen.getByText('Clip 3'))
    fireEvent.click(screen.getByRole('button', { name: /edit range/i }))
    useReviewStore.getState().setEditableRange({ start: 758, end: 770 })

    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => expect(useReviewStore.getState().activeClip?.editing).toBe(false))
    expect(patch).toHaveBeenCalledWith('/comments/c1', { timecode_start: 758, timecode_end: 770 })
    expect(useReviewStore.getState().activeClip?.range).toEqual({ start: 758, end: 770 })
    expect((comment as unknown as { timecode_start: number }).timecode_start).toBe(758)
  })

  it('Cancel after a save returns to the saved range, not the one the page first loaded', async () => {
    panel({ clipPlayback: { isProjectOwner: true } })
    fireEvent.click(screen.getByText('Clip 3'))
    fireEvent.click(screen.getByRole('button', { name: /edit range/i }))
    useReviewStore.getState().setEditableRange({ start: 758, end: 770 })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(useReviewStore.getState().activeClip?.editing).toBe(false))

    fireEvent.click(screen.getByRole('button', { name: /edit range/i }))
    useReviewStore.getState().setEditableRange({ start: 700, end: 800 })
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    expect(useReviewStore.getState().activeClip?.range).toEqual({ start: 758, end: 770 })
  })

  it('a save that finishes after another clip started does not touch that clip, but is still recorded', async () => {
    let finishSave: (value?: unknown) => void = () => {}
    patch.mockReturnValue(new Promise((resolve) => { finishSave = resolve }))
    const first = rangeComment()
    const second = rangeComment({ id: 'c2', timecode_start: 900, timecode_end: 910 })
    render(
      <CommentPanel
        comments={[first, second]}
        currentUserId="u-viewer"
        clipPlayback={{ isProjectOwner: true }}
        onResolve={noop} onDelete={noop} onAddReaction={noop} onRemoveReaction={noop}
        onReply={() => {}}
      />,
    )
    fireEvent.click(screen.getAllByText('Clip 3')[0])
    fireEvent.click(screen.getByRole('button', { name: /edit range/i }))
    useReviewStore.getState().setEditableRange({ start: 758, end: 770 })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    act(() => {
      useReviewStore.getState().activateClip('c2', { start: 900, end: 910 })
      useReviewStore.getState().setClipEditing(true)
    })
    await act(async () => { finishSave({}) })

    expect(useReviewStore.getState().activeClip).toMatchObject({ commentId: 'c2', editing: true })
    expect((first as unknown as { timecode_start: number }).timecode_start).toBe(758)
  })

  it('a failed save stays in edit mode and says so', async () => {
    patch.mockRejectedValue(new Error('403'))
    panel({ clipPlayback: { isProjectOwner: true } })
    fireEvent.click(screen.getByText('Clip 3'))
    fireEvent.click(screen.getByRole('button', { name: /edit range/i }))
    useReviewStore.getState().setEditableRange({ start: 758, end: 770 })

    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    await screen.findByText(/couldn't save/i)
    expect(useReviewStore.getState().activeClip?.editing).toBe(true)
  })

  it('Cancel puts the handles back where the comment has them', () => {
    panel({ clipPlayback: { isProjectOwner: true } })
    fireEvent.click(screen.getByText('Clip 3'))
    fireEvent.click(screen.getByRole('button', { name: /edit range/i }))
    useReviewStore.getState().setEditableRange({ start: 760, end: 765 })

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    expect(useReviewStore.getState().activeClip).toMatchObject({
      range: { start: 757, end: 771.5 },
      editing: false,
    })
    expect(patch).not.toHaveBeenCalled()
  })
})

describe('locking a clip range', () => {
  const LOCKED = '2026-10-01T00:00:00Z'

  it('the author can lock an unlocked range, which hides Edit range', async () => {
    const comment = rangeComment()
    panel({ currentUserId: 'u-author', clipPlayback: { isProjectOwner: false } }, comment)
    fireEvent.click(screen.getByText('Clip 3'))

    fireEvent.click(screen.getByRole('button', { name: /^lock$/i }))

    await screen.findByText('Locked')
    expect(patch).toHaveBeenCalledWith('/comments/c1', { locked: true })
    expect((comment as unknown as { locked_at: string | null }).locked_at).toBeTruthy()
    expect(screen.queryByRole('button', { name: /edit range/i })).toBeNull()
    expect(screen.getByRole('button', { name: /unlock/i })).toBeTruthy()
  })

  it('a locked range shows Locked and no Edit range, and the owner can unlock it', async () => {
    const comment = rangeComment({ locked_at: LOCKED })
    panel({ clipPlayback: { isProjectOwner: true } }, comment)
    fireEvent.click(screen.getByText('Clip 3'))

    expect(screen.getByText('Locked')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /edit range/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /unlock/i }))

    await screen.findByRole('button', { name: /edit range/i })
    expect(patch).toHaveBeenCalledWith('/comments/c1', { locked: false })
    expect((comment as unknown as { locked_at: string | null }).locked_at).toBeNull()
    expect(screen.queryByText('Locked')).toBeNull()
  })

  it('another member sees Locked but no Lock or Unlock button', () => {
    panel({ clipPlayback: { isProjectOwner: false } }, rangeComment({ locked_at: LOCKED }))
    fireEvent.click(screen.getByText('Clip 3'))

    expect(screen.getByText('Locked')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /unlock/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /edit range/i })).toBeNull()
  })

  it('another member cannot lock an unlocked range', () => {
    panel({ clipPlayback: { isProjectOwner: false } })
    fireEvent.click(screen.getByText('Clip 3'))

    expect(screen.queryByRole('button', { name: /^lock$/i })).toBeNull()
  })

  it('hides Lock while the handles are out', () => {
    panel({ clipPlayback: { isProjectOwner: true } })
    fireEvent.click(screen.getByText('Clip 3'))
    fireEvent.click(screen.getByRole('button', { name: /edit range/i }))

    expect(screen.queryByRole('button', { name: /^lock$/i })).toBeNull()
  })

  it('a failed lock stays unlocked and says so', async () => {
    patch.mockRejectedValue(new Error('409'))
    const comment = rangeComment()
    panel({ clipPlayback: { isProjectOwner: true } }, comment)
    fireEvent.click(screen.getByText('Clip 3'))

    fireEvent.click(screen.getByRole('button', { name: /^lock$/i }))

    await screen.findByText(/couldn't lock this range/i)
    expect((comment as unknown as { locked_at: string | null }).locked_at).toBeNull()
    expect(screen.getByRole('button', { name: /edit range/i })).toBeTruthy()
  })

  it('a failed unlock stays locked and says so', async () => {
    patch.mockRejectedValue(new Error('403'))
    panel({ clipPlayback: { isProjectOwner: true } }, rangeComment({ locked_at: LOCKED }))
    fireEvent.click(screen.getByText('Clip 3'))

    fireEvent.click(screen.getByRole('button', { name: /unlock/i }))

    await screen.findByText(/couldn't unlock this range/i)
    expect(screen.getByText('Locked')).toBeTruthy()
  })

  it('the comment shows a lock icon even when its clip is not playing', () => {
    panel({ clipPlayback: { isProjectOwner: false } }, rangeComment({ locked_at: LOCKED }))

    expect(screen.getByLabelText('Range locked')).toBeTruthy()
  })

  it('an unlocked range comment shows no lock icon', () => {
    panel({ clipPlayback: { isProjectOwner: false } })

    expect(screen.queryByLabelText('Range locked')).toBeNull()
  })
})
