import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'
import { ProgressBar } from '../progress-bar'

beforeEach(() => {
  useReviewStore.getState().reset()
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  })
})

/**
 * The pointer handlers live on the large hit area, but seek time is mapped from
 * the inset visual track. Mock the track's rect as inset by 20px on each side
 * of a 240px hit area, which is the shape the phone layout produces.
 */
function renderProgressBar(onSeek: (time: number) => void) {
  const { container } = render(
    <ProgressBar currentTime={0} duration={100} onSeek={onSeek} />,
  )
  const hitArea = container.querySelector(
    '[data-testid="progress-hit-area"]',
  ) as HTMLDivElement
  const track = container.querySelector(
    '[data-testid="progress-track"]',
  ) as HTMLDivElement

  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
    left: 20,
    top: 0,
    right: 220,
    bottom: 4,
    width: 200,
    height: 4,
    x: 20,
    y: 0,
    toJSON: () => ({}),
  })

  return { hitArea, track }
}

describe('ProgressBar touch scrubbing', () => {
  it('seeks as a touch pointer is dragged across the timeline', () => {
    const onSeek = vi.fn()
    const { hitArea } = renderProgressBar(onSeek)

    fireEvent.pointerDown(hitArea, { clientX: 60, pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerMove(hitArea, { clientX: 170, pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerUp(hitArea, { clientX: 170, pointerId: 1, pointerType: 'touch' })

    expect(onSeek).toHaveBeenLastCalledWith(75)
  })

  it('stops dragging when a touch gesture is cancelled', () => {
    const onSeek = vi.fn()
    const { hitArea } = renderProgressBar(onSeek)

    fireEvent.pointerDown(hitArea, { clientX: 60, pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerCancel(hitArea, { pointerId: 1, pointerType: 'touch' })
    const callsAfterCancel = onSeek.mock.calls.length
    fireEvent.pointerMove(hitArea, { clientX: 170, pointerId: 1, pointerType: 'touch' })

    expect(onSeek).toHaveBeenCalledTimes(callsAfterCancel)
  })
})

describe('ProgressBar inset touch target', () => {
  it('gives the pointer target generous height on phones and leaves md+ as-is', () => {
    const onSeek = vi.fn()
    const { hitArea, track } = renderProgressBar(onSeek)

    expect(hitArea).toHaveClass('touch-none', 'px-3', 'py-4', 'md:px-0', 'md:py-0')
    expect(track).toHaveClass('h-1')
    expect(track.parentElement).toBe(hitArea)
  })

  it('seeks to the start when the press lands in the inset gutter before the track', () => {
    const onSeek = vi.fn()
    const { hitArea } = renderProgressBar(onSeek)

    fireEvent.pointerDown(hitArea, { clientX: 4, pointerId: 1, pointerType: 'touch' })

    expect(onSeek).toHaveBeenLastCalledWith(0)
  })

  it('seeks to the end when the press lands in the inset gutter after the track', () => {
    const onSeek = vi.fn()
    const { hitArea } = renderProgressBar(onSeek)

    fireEvent.pointerDown(hitArea, { clientX: 236, pointerId: 1, pointerType: 'touch' })

    expect(onSeek).toHaveBeenLastCalledWith(100)
  })

  it('keeps the comment marker row inset so markers stay aligned to the track', () => {
    const onSeek = vi.fn()
    const { container } = render(
      <ProgressBar
        currentTime={0}
        duration={100}
        onSeek={onSeek}
        comments={[
          {
            id: 'comment-1',
            body: 'Tighten this cut',
            timecode_start: 50,
            timecode_end: null,
            resolved: false,
            author: { id: 'user-1', name: 'Skyler VM' },
          } as never,
        ]}
      />,
    )

    const marker = container.querySelector('.absolute.top-0') as HTMLDivElement
    expect(marker).toBeTruthy()
    expect(marker.parentElement?.parentElement).toHaveClass('px-3', 'md:px-0')
  })
})

describe('ProgressBar range handles', () => {
  // Same geometry as renderProgressBar: track left=20, width=200, duration=100,
  // so clientX = 20 + 2 * seconds.
  const xFor = (seconds: number) => 20 + 2 * seconds

  it('shows no handles until a range is drafted', () => {
    const { container } = render(<ProgressBar currentTime={0} duration={100} onSeek={vi.fn()} />)
    expect(container.querySelector('[data-testid="range-handle-start"]')).toBeNull()
  })

  it('shows both handles at the drafted range, with slider values', () => {
    useReviewStore.getState().setPendingRange({ start: 10, end: 20 })
    const { container } = render(<ProgressBar currentTime={0} duration={100} onSeek={vi.fn()} />)

    const start = container.querySelector('[data-testid="range-handle-start"]') as HTMLElement
    const end = container.querySelector('[data-testid="range-handle-end"]') as HTMLElement
    expect(start).toHaveAttribute('aria-valuenow', '10')
    expect(end).toHaveAttribute('aria-valuenow', '20')
    expect(start.style.left).toBe('10%')
    expect(end.style.left).toBe('20%')
    expect(container.querySelector('[data-testid="pending-range-band"]')).toBeTruthy()
  })

  it('dragging the end handle moves the end and scrubs the video to it', () => {
    useReviewStore.getState().setPendingRange({ start: 10, end: 20 })
    const onSeek = vi.fn()
    const { container } = render(<ProgressBar currentTime={0} duration={100} onSeek={onSeek} />)
    const track = container.querySelector('[data-testid="progress-track"]') as HTMLDivElement
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      left: 20, top: 0, right: 220, bottom: 4, width: 200, height: 4, x: 20, y: 0, toJSON: () => ({}),
    })
    const end = container.querySelector('[data-testid="range-handle-end"]') as HTMLElement

    fireEvent.pointerDown(end, { clientX: xFor(20), pointerId: 1, pointerType: 'touch' })
    expect(onSeek).not.toHaveBeenCalled() // grabbing a handle must not also seek the bar
    fireEvent.pointerMove(end, { clientX: xFor(60), pointerId: 1, pointerType: 'touch' })

    expect(useReviewStore.getState().pendingRange).toEqual({ start: 10, end: 60 })
    expect(onSeek).toHaveBeenLastCalledWith(60)
  })

  it('the start handle cannot be dragged past the end', () => {
    useReviewStore.getState().setPendingRange({ start: 10, end: 20 })
    const onSeek = vi.fn()
    const { container } = render(<ProgressBar currentTime={0} duration={100} onSeek={onSeek} />)
    const track = container.querySelector('[data-testid="progress-track"]') as HTMLDivElement
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      left: 20, top: 0, right: 220, bottom: 4, width: 200, height: 4, x: 20, y: 0, toJSON: () => ({}),
    })
    const start = container.querySelector('[data-testid="range-handle-start"]') as HTMLElement

    fireEvent.pointerDown(start, { clientX: xFor(10), pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerMove(start, { clientX: xFor(50), pointerId: 1, pointerType: 'touch' })

    expect(useReviewStore.getState().pendingRange).toEqual({ start: 19.5, end: 20 })
    expect(onSeek).toHaveBeenLastCalledWith(19.5)
  })

  it('ignores movement before a handle is grabbed and after it is released', () => {
    useReviewStore.getState().setPendingRange({ start: 10, end: 20 })
    const onSeek = vi.fn()
    const { container } = render(<ProgressBar currentTime={0} duration={100} onSeek={onSeek} />)
    const track = container.querySelector('[data-testid="progress-track"]') as HTMLDivElement
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      left: 20, top: 0, right: 220, bottom: 4, width: 200, height: 4, x: 20, y: 0, toJSON: () => ({}),
    })
    const end = container.querySelector('[data-testid="range-handle-end"]') as HTMLElement

    fireEvent.pointerMove(end, { clientX: xFor(40), pointerId: 1 })
    expect(useReviewStore.getState().pendingRange).toEqual({ start: 10, end: 20 })

    fireEvent.pointerDown(end, { clientX: xFor(20), pointerId: 1 })
    fireEvent.pointerUp(end, { clientX: xFor(20), pointerId: 1 })
    fireEvent.pointerMove(end, { clientX: xFor(80), pointerId: 1 })
    expect(useReviewStore.getState().pendingRange).toEqual({ start: 10, end: 20 })
    expect(onSeek).not.toHaveBeenCalled()
  })
})

describe('ProgressBar range drag: grab offset, pointers, keyboard', () => {
  const xFor = (seconds: number) => 20 + 2 * seconds

  function setup(range = { start: 10, end: 20 }) {
    useReviewStore.getState().setPendingRange(range)
    const onSeek = vi.fn()
    const { container } = render(<ProgressBar currentTime={0} duration={100} onSeek={onSeek} />)
    const track = container.querySelector('[data-testid="progress-track"]') as HTMLDivElement
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      left: 20, top: 0, right: 220, bottom: 4, width: 200, height: 4, x: 20, y: 0, toJSON: () => ({}),
    })
    const handle = (edge: 'start' | 'end') =>
      container.querySelector(`[data-testid="range-handle-${edge}"]`) as HTMLElement
    return { onSeek, handle }
  }

  it('does not jump the edge when a handle is grabbed away from its edge line', () => {
    const { handle, onSeek } = setup()
    // the end handle's grab area sits to the right of the edge: press 3s past it, then move 1s
    fireEvent.pointerDown(handle('end'), { clientX: xFor(23), pointerId: 1 })
    fireEvent.pointerMove(handle('end'), { clientX: xFor(24), pointerId: 1 })

    expect(useReviewStore.getState().pendingRange?.end).toBe(21)
    expect(onSeek).toHaveBeenLastCalledWith(21)
  })

  it('keeps the grab offset for the start handle too (grabbed to the left of its edge)', () => {
    const { handle } = setup()
    fireEvent.pointerDown(handle('start'), { clientX: xFor(7), pointerId: 1 })
    fireEvent.pointerMove(handle('start'), { clientX: xFor(8), pointerId: 1 })
    expect(useReviewStore.getState().pendingRange?.start).toBe(11)
  })

  it('a second finger cannot take over or end the first finger\'s drag', () => {
    const { handle } = setup()
    fireEvent.pointerDown(handle('end'), { clientX: xFor(20), pointerId: 1 })

    fireEvent.pointerDown(handle('start'), { clientX: xFor(10), pointerId: 2 })
    fireEvent.pointerMove(handle('start'), { clientX: xFor(15), pointerId: 2 })
    expect(useReviewStore.getState().pendingRange).toEqual({ start: 10, end: 20 })

    fireEvent.pointerUp(handle('start'), { pointerId: 2 })
    fireEvent.pointerMove(handle('end'), { clientX: xFor(30), pointerId: 1 })
    expect(useReviewStore.getState().pendingRange?.end).toBe(30) // finger 1 still owns the drag

    fireEvent.pointerUp(handle('end'), { pointerId: 1 })
    fireEvent.pointerMove(handle('end'), { clientX: xFor(40), pointerId: 1 })
    expect(useReviewStore.getState().pendingRange?.end).toBe(30)
  })

  it('ignores movement from a second finger on the very handle the first finger holds', () => {
    const { handle } = setup()
    fireEvent.pointerDown(handle('end'), { clientX: xFor(20), pointerId: 1 })
    fireEvent.pointerMove(handle('end'), { clientX: xFor(60), pointerId: 2 })
    expect(useReviewStore.getState().pendingRange).toEqual({ start: 10, end: 20 })
  })

  it('flags a range gesture while a handle is held, and clears it on release', () => {
    const { handle } = setup()
    fireEvent.pointerDown(handle('end'), { clientX: xFor(20), pointerId: 1 })
    expect(useReviewStore.getState().rangeGesturePointer).toBe(1)
    fireEvent.pointerUp(handle('end'), { pointerId: 1 })
    expect(useReviewStore.getState().rangeGesturePointer).toBeNull()
  })

  it('nudges a focused handle by a frame with the arrow keys, and by a second with Shift', () => {
    const { handle, onSeek } = setup()
    fireEvent.keyDown(handle('end'), { key: 'ArrowRight' })
    expect(useReviewStore.getState().pendingRange?.end).toBeCloseTo(20 + 1 / 24, 6)
    expect(onSeek).toHaveBeenLastCalledWith(expect.closeTo(20 + 1 / 24, 6))

    fireEvent.keyDown(handle('start'), { key: 'ArrowLeft', shiftKey: true })
    expect(useReviewStore.getState().pendingRange?.start).toBe(9)
  })

  it('keeps the arrow keys away from the player\'s own shortcuts while a handle has focus', () => {
    const { handle } = setup()
    const playerShortcut = vi.fn()
    window.addEventListener('keydown', playerShortcut)
    try {
      fireEvent.keyDown(handle('end'), { key: 'ArrowRight' })
      expect(playerShortcut).not.toHaveBeenCalled()
      fireEvent.keyDown(handle('end'), { key: 'a' }) // other keys are left alone
      expect(playerShortcut).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', playerShortcut)
    }
  })

  it('makes each handle focusable', () => {
    const { handle } = setup()
    expect(handle('start')).toHaveAttribute('tabindex', '0')
    expect(handle('end')).toHaveAttribute('tabindex', '0')
  })
})

describe('ProgressBar range drag: reaching the ends, one gesture, cleanup', () => {
  const xFor = (seconds: number) => 20 + 2 * seconds
  const rect = { left: 20, top: 0, right: 220, bottom: 4, width: 200, height: 4, x: 20, y: 0, toJSON: () => ({}) }

  function setup(range = { start: 10, end: 20 }) {
    useReviewStore.getState().setPendingRange(range)
    const onSeek = vi.fn()
    const view = render(<ProgressBar currentTime={0} duration={100} onSeek={onSeek} />)
    const track = view.container.querySelector('[data-testid="progress-track"]') as HTMLDivElement
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue(rect)
    const handle = (edge: 'start' | 'end') =>
      view.container.querySelector(`[data-testid="range-handle-${edge}"]`) as HTMLElement
    return { ...view, onSeek, handle }
  }

  it('can still drag the start all the way to 0:00 after grabbing it left of its edge', () => {
    const { handle } = setup()
    fireEvent.pointerDown(handle('start'), { clientX: xFor(7), pointerId: 1 }) // 3s left of the edge
    fireEvent.pointerMove(handle('start'), { clientX: xFor(-50), pointerId: 1 }) // pointer well past the track
    expect(useReviewStore.getState().pendingRange?.start).toBe(0)
  })

  it('can still drag the end all the way to the end of the video after grabbing it right of its edge', () => {
    const { handle } = setup()
    fireEvent.pointerDown(handle('end'), { clientX: xFor(23), pointerId: 1 }) // 3s right of the edge
    fireEvent.pointerMove(handle('end'), { clientX: xFor(180), pointerId: 1 })
    expect(useReviewStore.getState().pendingRange?.end).toBe(100)
  })

  it('a gesture on the main bar blocks the zoom strip, and the other way round', () => {
    const { container, handle, onSeek } = setup()
    const stripTrack = container.querySelector('[data-testid="range-zoom-track"]') as HTMLDivElement
    vi.spyOn(stripTrack, 'getBoundingClientRect').mockReturnValue({ ...rect, left: 0, right: 1000, width: 1000, x: 0 })
    const stripHit = container.querySelector('[data-testid="range-zoom-hit-area"]') as HTMLElement
    const stripEnd = stripTrack.querySelector('[data-testid="range-handle-end"]') as HTMLElement

    fireEvent.pointerDown(handle('end'), { clientX: xFor(20), pointerId: 1 })
    fireEvent.pointerDown(stripHit, { clientX: 500, pointerId: 2 })
    fireEvent.pointerDown(stripEnd, { clientX: 700, pointerId: 2 })
    fireEvent.pointerMove(stripEnd, { clientX: 900, pointerId: 2 })
    expect(onSeek).not.toHaveBeenCalled()
    expect(useReviewStore.getState().pendingRange).toEqual({ start: 10, end: 20 })
    expect(useReviewStore.getState().rangeGesturePointer).toBe(1)

    // finger 2 lifting must not release finger 1's gesture
    fireEvent.pointerUp(stripEnd, { pointerId: 2 })
    expect(useReviewStore.getState().rangeGesturePointer).toBe(1)
    fireEvent.pointerUp(handle('end'), { pointerId: 1 })

    // and with the main bar idle, the strip works again
    fireEvent.pointerDown(stripHit, { clientX: 500, pointerId: 2 })
    expect(useReviewStore.getState().rangeGesturePointer).toBe(2)
  })

  it('releases the gesture when the bar unmounts mid-drag', () => {
    const { handle, unmount } = setup()
    fireEvent.pointerDown(handle('end'), { clientX: xFor(20), pointerId: 1 })
    expect(useReviewStore.getState().rangeGesturePointer).toBe(1)
    unmount()
    expect(useReviewStore.getState().rangeGesturePointer).toBeNull()
  })

  it('releases a strip scrub when the bar unmounts mid-scrub', () => {
    const { container, unmount } = setup()
    const stripHit = container.querySelector('[data-testid="range-zoom-hit-area"]') as HTMLElement
    fireEvent.pointerDown(stripHit, { clientX: 500, pointerId: 3 })
    expect(useReviewStore.getState().rangeGesturePointer).toBe(3)
    unmount()
    expect(useReviewStore.getState().rangeGesturePointer).toBeNull()
  })

  it('removing the range mid-drag frees the gesture, so the next range can be dragged', () => {
    const { handle } = setup()
    fireEvent.pointerDown(handle('end'), { clientX: xFor(20), pointerId: 1 })
    act(() => { useReviewStore.getState().setPendingRange(null) })
    expect(useReviewStore.getState().rangeGesturePointer).toBeNull()

    act(() => { useReviewStore.getState().setPendingRange({ start: 30, end: 40 }) })
    fireEvent.pointerDown(handle('end'), { clientX: xFor(40), pointerId: 1 })
    fireEvent.pointerMove(handle('end'), { clientX: xFor(50), pointerId: 1 })
    expect(useReviewStore.getState().pendingRange).toEqual({ start: 30, end: 50 })
  })
})

describe('ProgressBar range drag: pointer capture failing', () => {
  afterEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
  })

  it('does not keep the gesture claimed when capture throws on a handle or on the strip', () => {
    useReviewStore.getState().setPendingRange({ start: 10, end: 20 })
    const { container } = render(<ProgressBar currentTime={0} duration={100} onSeek={vi.fn()} />)
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
      configurable: true,
      value: () => { throw new DOMException('no such pointer', 'NotFoundError') },
    })

    const handle = container.querySelector('[data-testid="range-handle-end"]') as HTMLElement
    fireEvent.pointerDown(handle, { clientX: 40, pointerId: 1 })
    expect(useReviewStore.getState().rangeGesturePointer).toBeNull()

    const stripHit = container.querySelector('[data-testid="range-zoom-hit-area"]') as HTMLElement
    fireEvent.pointerDown(stripHit, { clientX: 500, pointerId: 2 })
    expect(useReviewStore.getState().rangeGesturePointer).toBeNull()
  })
})

