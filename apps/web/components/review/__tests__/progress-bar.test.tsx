import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'
import { ProgressBar } from '../progress-bar'

beforeEach(() => {
  useReviewStore.getState().reset()
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  })
})

describe('ProgressBar touch scrubbing', () => {
  it('seeks as a touch pointer is dragged across the timeline', () => {
    const onSeek = vi.fn()
    const { container } = render(
      <ProgressBar currentTime={0} duration={100} onSeek={onSeek} />,
    )
    const track = container.querySelector('.touch-none') as HTMLDivElement
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 200,
      bottom: 4,
      width: 200,
      height: 4,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    fireEvent.pointerDown(track, { clientX: 40, pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerMove(track, { clientX: 150, pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerUp(track, { clientX: 150, pointerId: 1, pointerType: 'touch' })

    expect(onSeek).toHaveBeenLastCalledWith(75)
  })

  it('stops dragging when a touch gesture is cancelled', () => {
    const onSeek = vi.fn()
    const { container } = render(
      <ProgressBar currentTime={0} duration={100} onSeek={onSeek} />,
    )
    const track = container.querySelector('.touch-none') as HTMLDivElement
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 200, bottom: 4, width: 200, height: 4, x: 0, y: 0, toJSON: () => ({}),
    })

    fireEvent.pointerDown(track, { clientX: 40, pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerCancel(track, { pointerId: 1, pointerType: 'touch' })
    const callsAfterCancel = onSeek.mock.calls.length
    fireEvent.pointerMove(track, { clientX: 150, pointerId: 1, pointerType: 'touch' })

    expect(onSeek).toHaveBeenCalledTimes(callsAfterCancel)
  })
})
