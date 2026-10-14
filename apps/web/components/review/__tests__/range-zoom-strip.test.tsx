import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'
import { ProgressBar } from '../progress-bar'
import { RangeZoomStrip } from '../range-zoom-strip'

beforeEach(() => {
  useReviewStore.getState().reset()
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  })
})

// A 1000px-wide strip track at left=0, so clientX / 1000 is the horizontal ratio.
function renderStrip(onSeek = vi.fn(), currentTime = 330) {
  const view = render(<RangeZoomStrip currentTime={currentTime} duration={3565} onSeek={onSeek} />)
  const track = view.container.querySelector('[data-testid="range-zoom-track"]') as HTMLDivElement | null
  if (track) {
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 1000, bottom: 8, width: 1000, height: 8, x: 0, y: 0, toJSON: () => ({}),
    })
  }
  const handle = (edge: 'start' | 'end') =>
    view.container.querySelector(`[data-testid="range-handle-${edge}"]`) as HTMLElement
  const hitArea = () => view.container.querySelector('[data-testid="range-zoom-hit-area"]') as HTMLElement
  return { ...view, handle, hitArea, onSeek }
}

describe('RangeZoomStrip', () => {
  it('renders nothing until a range is drafted', () => {
    const { container } = render(<RangeZoomStrip currentTime={0} duration={3565} onSeek={vi.fn()} />)
    expect(container.querySelector('[data-testid="range-zoom-strip"]')).toBeNull()
  })

  it('frames the range with context either side: a 20s range sits at 30%..70% of a 50s window', () => {
    useReviewStore.getState().setPendingRange({ start: 320, end: 340 })
    const { handle } = renderStrip()
    expect(handle('start').style.left).toBe('30%')
    expect(handle('end').style.left).toBe('70%')
  })

  it('labels the range with its start, end and length', () => {
    useReviewStore.getState().setPendingRange({ start: 320, end: 340.5 })
    const { container } = renderStrip()
    expect(container.textContent).toContain('20.5s')
    expect(container.textContent).toContain('start 00:05:20:00')
  })

  it('shows the playhead only while it is inside the window', () => {
    useReviewStore.getState().setPendingRange({ start: 320, end: 340 })
    const inside = renderStrip(vi.fn(), 330)
    expect(inside.container.querySelector('[data-testid="range-zoom-playhead"]')).toBeTruthy()
    inside.unmount()
    const outside = renderStrip(vi.fn(), 1000)
    expect(outside.container.querySelector('[data-testid="range-zoom-playhead"]')).toBeNull()
  })

  it('drags the end to a fraction of a second, scrubbing the video to it', () => {
    useReviewStore.getState().setPendingRange({ start: 320, end: 340 })
    const { handle, onSeek } = renderStrip()

    fireEvent.pointerDown(handle('end'), { clientX: 700, pointerId: 1 })
    expect(onSeek).not.toHaveBeenCalled() // grabbing a handle does not scrub
    fireEvent.pointerMove(handle('end'), { clientX: 701, pointerId: 1 }) // one pixel

    // 1px of a 50s window across 1000px is 0.05s, not the ~5s it is on the full bar
    expect(useReviewStore.getState().pendingRange?.end).toBeCloseTo(340.05, 5)
    expect(onSeek).toHaveBeenLastCalledWith(expect.closeTo(340.05, 5))
  })

  it('keeps the window still while dragging, then re-frames around the new range on release', () => {
    useReviewStore.getState().setPendingRange({ start: 320, end: 340 })
    const { handle } = renderStrip()

    fireEvent.pointerDown(handle('end'), { clientX: 700, pointerId: 1 })
    fireEvent.pointerMove(handle('end'), { clientX: 800, pointerId: 1 }) // window is 305..355 → 345s
    expect(useReviewStore.getState().pendingRange?.end).toBe(345)
    expect(handle('end').style.left).toBe('80%') // window did not slide under the pointer

    fireEvent.pointerUp(handle('end'), { pointerId: 1 })
    // re-framed: window is now 305..360, so 345s sits at 72.7%
    expect(parseFloat(handle('end').style.left)).toBeCloseTo(72.727, 2)
  })

  it('cannot drag the start past the end', () => {
    useReviewStore.getState().setPendingRange({ start: 320, end: 340 })
    const { handle } = renderStrip()
    fireEvent.pointerDown(handle('start'), { clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(handle('start'), { clientX: 1000, pointerId: 1 })
    expect(useReviewStore.getState().pendingRange).toEqual({ start: 339.5, end: 340 })
  })

  it('pressing and dragging the strip itself scrubs the video to find a frame', () => {
    useReviewStore.getState().setPendingRange({ start: 320, end: 340 })
    const { hitArea, onSeek } = renderStrip()

    fireEvent.pointerDown(hitArea(), { clientX: 500, pointerId: 1 })
    expect(onSeek).toHaveBeenLastCalledWith(330)
    fireEvent.pointerMove(hitArea(), { clientX: 600, pointerId: 1 })
    expect(onSeek).toHaveBeenLastCalledWith(335)
    fireEvent.pointerUp(hitArea(), { pointerId: 1 })
    fireEvent.pointerMove(hitArea(), { clientX: 900, pointerId: 1 })
    expect(onSeek).toHaveBeenCalledTimes(2) // no scrubbing after release
    expect(useReviewStore.getState().pendingRange).toEqual({ start: 320, end: 340 })
  })

  it('re-frames when the range changes from elsewhere, such as a drag on the main bar', () => {
    useReviewStore.getState().setPendingRange({ start: 320, end: 340 })
    const { handle } = renderStrip()
    act(() => { useReviewStore.getState().setPendingRange({ start: 1000, end: 1020 }) })
    expect(handle('start').style.left).toBe('30%')
    expect(handle('end').style.left).toBe('70%')
  })
})

describe('ProgressBar zoom strip', () => {
  it('appears with a drafted range and disappears when the range is removed', () => {
    const { container } = render(<ProgressBar currentTime={0} duration={3565} onSeek={vi.fn()} />)
    expect(container.querySelector('[data-testid="range-zoom-strip"]')).toBeNull()

    act(() => { useReviewStore.getState().setPendingRange({ start: 320, end: 340 }) })
    expect(container.querySelector('[data-testid="range-zoom-strip"]')).toBeTruthy()

    act(() => { useReviewStore.getState().setPendingRange(null) })
    expect(container.querySelector('[data-testid="range-zoom-strip"]')).toBeNull()
  })
})

describe('RangeZoomStrip pointers and gesture flag', () => {
  it('scrubbing belongs to one finger: a second touch neither scrubs nor ends it', () => {
    useReviewStore.getState().setPendingRange({ start: 320, end: 340 })
    const { hitArea, onSeek } = renderStrip()

    fireEvent.pointerDown(hitArea(), { clientX: 500, pointerId: 1 })
    fireEvent.pointerDown(hitArea(), { clientX: 100, pointerId: 2 })
    fireEvent.pointerMove(hitArea(), { clientX: 100, pointerId: 2 })
    expect(onSeek).toHaveBeenCalledTimes(1)

    fireEvent.pointerUp(hitArea(), { pointerId: 2 })
    fireEvent.pointerMove(hitArea(), { clientX: 600, pointerId: 1 })
    expect(onSeek).toHaveBeenLastCalledWith(335) // finger 1 is still scrubbing
  })

  it('flags a range gesture for the whole scrub so looping holds off', () => {
    useReviewStore.getState().setPendingRange({ start: 320, end: 340 })
    const { hitArea } = renderStrip()

    fireEvent.pointerDown(hitArea(), { clientX: 500, pointerId: 1 })
    expect(useReviewStore.getState().rangeGestureActive).toBe(true)
    fireEvent.pointerUp(hitArea(), { pointerId: 1 })
    expect(useReviewStore.getState().rangeGestureActive).toBe(false)
  })

  it('does not jump a strip handle grabbed away from its edge', () => {
    useReviewStore.getState().setPendingRange({ start: 320, end: 340 })
    const { handle } = renderStrip()
    // end edge is at x=700 on a 50s/1000px window; grab 40px (2s) to its right, then move 1px
    fireEvent.pointerDown(handle('end'), { clientX: 740, pointerId: 1 })
    fireEvent.pointerMove(handle('end'), { clientX: 741, pointerId: 1 })
    expect(useReviewStore.getState().pendingRange?.end).toBeCloseTo(340.05, 5)
  })
})

