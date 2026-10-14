import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'

// CommentInput calls useReview() unconditionally; mirror the minimal shape
// used by compare-overlay.test.tsx (only pauseVideo is read on submit path).
vi.mock('../review-provider', () => ({
  useReview: () => ({ pauseVideo: vi.fn(), registerPauseHandler: vi.fn() }),
}))

import { CommentInput } from '../comment-input'

beforeEach(() => {
  useReviewStore.getState().reset()
})

async function typeAndSubmit(text: string) {
  const textarea = screen.getByPlaceholderText('Leave your comment...')
  fireEvent.change(textarea, { target: { value: text } })
  fireEvent.keyDown(textarea, { key: 'Enter' })
  await waitFor(() => expect(textarea).toHaveValue(''))
}

describe('CommentInput timecode at playhead 0', () => {
  it('submits timecode 0 (not undefined) when attached and the playhead is at 0:00', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <CommentInput
        assetId="a1"
        projectId="p1"
        assetType="video"
        playheadTimeOverride={0}
        onSubmit={onSubmit}
      />,
    )
    // Badge shows the promised timecode while composing.
    expect(screen.getByText('00:00:00:00')).toBeInTheDocument()

    await typeAndSubmit('remove kite')

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const [body, timecodeStart] = onSubmit.mock.calls[0]
    expect(body).toBe('remove kite')
    expect(timecodeStart).toBe(0)
    expect(timecodeStart).not.toBeUndefined()
  })

  it('submits the real timecode when attached and the playhead is non-zero', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <CommentInput
        assetId="a1"
        projectId="p1"
        assetType="video"
        playheadTimeOverride={26}
        onSubmit={onSubmit}
      />,
    )
    await typeAndSubmit('looks good')
    expect(onSubmit.mock.calls[0][1]).toBe(26)
  })

  it('omits the timecode when detached (no drawing)', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <CommentInput
        assetId="a1"
        projectId="p1"
        assetType="video"
        playheadTimeOverride={12}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.click(screen.getByTitle('Detach timecode'))
    await typeAndSubmit('no timecode please')
    expect(onSubmit.mock.calls[0][1]).toBeUndefined()
  })

  it('reads the playhead from the store when playheadTimeOverride is omitted (normal reviewer path)', async () => {
    useReviewStore.getState().setPlayheadTime(26)
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <CommentInput assetId="a1" projectId="p1" assetType="video" onSubmit={onSubmit} />,
    )
    await typeAndSubmit('from store playhead')
    expect(onSubmit.mock.calls[0][1]).toBe(26)
  })

  it('never attaches a timecode for image assets, even at a non-zero playhead', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <CommentInput
        assetId="a1"
        projectId="p1"
        assetType="image"
        playheadTimeOverride={5}
        onSubmit={onSubmit}
      />,
    )
    await typeAndSubmit('nice crop')
    expect(onSubmit.mock.calls[0][1]).toBeUndefined()
  })
})

describe('CommentInput compare drawing props (annotationActive / onToggleAnnotation)', () => {
  it('routes the pencil through onToggleAnnotation, not the global drawing toggle', () => {
    const onToggle = vi.fn()
    render(
      <CommentInput
        assetId="a1"
        projectId="p1"
        assetType="video"
        onSubmit={vi.fn()}
        annotationActive={false}
        onToggleAnnotation={onToggle}
      />,
    )
    fireEvent.click(screen.getByTitle('Draw annotation'))
    expect(onToggle).toHaveBeenCalledTimes(1)
    // The global store flag is left untouched — the parent owns drawing state.
    expect(useReviewStore.getState().isDrawingMode).toBe(false)
  })

  it('shows the drawing toolbar (not the pencil) when annotationActive is true', () => {
    render(
      <CommentInput
        assetId="a1"
        projectId="p1"
        assetType="video"
        onSubmit={vi.fn()}
        annotationActive
        onToggleAnnotation={vi.fn()}
      />,
    )
    expect(screen.getByTitle('Exit drawing')).toBeInTheDocument()
    expect(screen.queryByTitle('Draw annotation')).not.toBeInTheDocument()
  })

  it('an INACTIVE pane never attaches the shared pending drawing (no cross-pane leak)', async () => {
    // A drawing from the other pane sits in the shared store...
    useReviewStore.getState().setPendingAnnotation({ objects: [{ type: 'path' }] })
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <CommentInput
        assetId="a1"
        projectId="p1"
        assetType="video"
        playheadTimeOverride={4}
        onSubmit={onSubmit}
        annotationActive={false}
        onToggleAnnotation={vi.fn()}
      />,
    )
    await typeAndSubmit('just text on this side')
    // ...but this inactive pane must not pick it up: annotationData stays undefined.
    expect(onSubmit.mock.calls[0][3]).toBeUndefined()
  })

  it('the ACTIVE pane attaches the pending drawing on submit', async () => {
    const drawing = { objects: [{ type: 'path' }] }
    useReviewStore.getState().setPendingAnnotation(drawing)
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <CommentInput
        assetId="a1"
        projectId="p1"
        assetType="video"
        playheadTimeOverride={4}
        onSubmit={onSubmit}
        annotationActive
        onToggleAnnotation={vi.fn()}
      />,
    )
    await typeAndSubmit('see my markup')
    expect(onSubmit.mock.calls[0][3]).toEqual(drawing)
  })

  it('an INACTIVE pane submit leaves the shared drawing state intact (other pane keeps drawing)', async () => {
    // The other pane is mid-draw: global drawing mode on, a drawing pending.
    useReviewStore.getState().setIsDrawingMode(true)
    useReviewStore.getState().setPendingAnnotation({ objects: [{ type: 'path' }] })
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <CommentInput
        assetId="a1"
        projectId="p1"
        assetType="video"
        playheadTimeOverride={4}
        onSubmit={onSubmit}
        annotationActive={false}
        onToggleAnnotation={vi.fn()}
      />,
    )
    await typeAndSubmit('text on the other side')
    // Submitting on the inactive pane must NOT wipe the active pane's drawing/state.
    expect(useReviewStore.getState().isDrawingMode).toBe(true)
    expect(useReviewStore.getState().pendingAnnotation).toEqual({ objects: [{ type: 'path' }] })
  })

  it('an INACTIVE pane does not highlight its pencil from the other pane’s pending drawing', () => {
    useReviewStore.getState().setPendingAnnotation({ objects: [{ type: 'path' }] })
    render(
      <CommentInput
        assetId="a1"
        projectId="p1"
        assetType="video"
        onSubmit={vi.fn()}
        annotationActive={false}
        onToggleAnnotation={vi.fn()}
      />,
    )
    expect(screen.getByTitle('Draw annotation').className).not.toContain('text-accent')
  })
})

describe('CommentInput range', () => {
  function renderVideoInput(onSubmit = vi.fn().mockResolvedValue(undefined), extra = {}) {
    render(<CommentInput assetId="a1" projectId="p1" assetType="video" onSubmit={onSubmit} {...extra} />)
    return onSubmit
  }

  it('cannot start a range until the video duration is known', () => {
    renderVideoInput()
    expect(screen.getByTitle('Select a range')).toBeDisabled()
  })

  it('drafts a range at the playhead and posts both ends in one comment', async () => {
    useReviewStore.setState({ mediaDuration: 3000, playheadTime: 320 })
    const onSubmit = renderVideoInput()

    fireEvent.click(screen.getByTitle('Select a range'))
    expect(useReviewStore.getState().pendingRange).toEqual({ start: 320, end: 325 })

    await typeAndSubmit('Clip 1')

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const [body, timecodeStart, timecodeEnd] = onSubmit.mock.calls[0]
    expect(body).toBe('Clip 1')
    expect(timecodeStart).toBe(320)
    expect(timecodeEnd).toBe(325)
    expect(useReviewStore.getState().pendingRange).toBeNull()
  })

  it('posts the range the handles were dragged to, not the playhead', async () => {
    useReviewStore.setState({ mediaDuration: 3000, playheadTime: 320 })
    const onSubmit = renderVideoInput()
    fireEvent.click(screen.getByTitle('Select a range'))
    useReviewStore.getState().setPendingRange({ start: 322.5, end: 340.25 })

    await typeAndSubmit('Clip 1')

    expect(onSubmit.mock.calls[0][1]).toBe(322.5)
    expect(onSubmit.mock.calls[0][2]).toBe(340.25)
  })

  it('removing the range sends a plain point comment again', async () => {
    useReviewStore.setState({ mediaDuration: 3000, playheadTime: 12 })
    const onSubmit = renderVideoInput()
    fireEvent.click(screen.getByTitle('Select a range'))
    fireEvent.click(screen.getByTitle('Remove range'))

    await typeAndSubmit('just a note')

    expect(onSubmit.mock.calls[0][1]).toBe(12)
    expect(onSubmit.mock.calls[0][2]).toBeUndefined()
  })

  it('the loop button flips loopRange and only shows while a range exists', () => {
    useReviewStore.setState({ mediaDuration: 3000, playheadTime: 12 })
    renderVideoInput()
    expect(screen.queryByTitle('Loop range')).toBeNull()

    fireEvent.click(screen.getByTitle('Select a range'))
    fireEvent.click(screen.getByTitle('Loop range'))
    expect(useReviewStore.getState().loopRange).toBe(true)
  })

  it('offers no range on audio, in compare panes, or on replies', () => {
    useReviewStore.setState({ mediaDuration: 3000 })
    const { unmount } = render(<CommentInput assetId="a1" projectId="p1" assetType="audio" onSubmit={vi.fn()} />)
    expect(screen.queryByTitle('Select a range')).toBeNull()
    unmount()

    const compare = render(<CommentInput assetId="a1" projectId="p1" assetType="video" playheadTimeOverride={5} onSubmit={vi.fn()} />)
    expect(screen.queryByTitle('Select a range')).toBeNull()
    compare.unmount()

    render(<CommentInput assetId="a1" projectId="p1" assetType="video" replyToId="c1" onSubmit={vi.fn()} />)
    expect(screen.queryByTitle('Select a range')).toBeNull()
  })
})

describe('CommentInput range: slow submissions', () => {
  it('a submit that finishes late does not clear a range drafted in the meantime', async () => {
    useReviewStore.setState({ mediaDuration: 3000, playheadTime: 320 })
    let finishSubmit: () => void = () => {}
    const onSubmit = vi.fn().mockReturnValue(new Promise<void>((resolve) => { finishSubmit = resolve }))
    render(<CommentInput assetId="a1" projectId="p1" assetType="video" onSubmit={onSubmit} />)

    fireEvent.click(screen.getByTitle('Select a range'))
    const textarea = screen.getByPlaceholderText('Leave your comment...')
    fireEvent.change(textarea, { target: { value: 'Clip 1' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))

    // while the post is in flight the reviewer drafts the next clip
    act(() => { useReviewStore.getState().setPendingRange({ start: 500, end: 520 }) })
    finishSubmit()
    await waitFor(() => expect(textarea).toHaveValue(''))

    expect(useReviewStore.getState().pendingRange).toEqual({ start: 500, end: 520 })
  })

  it('still clears the draft that was actually submitted', async () => {
    useReviewStore.setState({ mediaDuration: 3000, playheadTime: 320 })
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<CommentInput assetId="a1" projectId="p1" assetType="video" onSubmit={onSubmit} />)
    fireEvent.click(screen.getByTitle('Select a range'))

    await typeAndSubmit('Clip 1')

    expect(useReviewStore.getState().pendingRange).toBeNull()
  })
})

