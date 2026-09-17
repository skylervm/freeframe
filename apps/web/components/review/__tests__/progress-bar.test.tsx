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
