'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  windowPercent,
  windowTimeAt,
  windowTimeAtUnclamped,
  zoomWindow,
  type ZoomWindow,
} from '@/lib/clip-range'
import { cn, formatTimecode } from '@/lib/utils'
import { useReviewStore } from '@/stores/review-store'
import { RangeHandle } from './range-handle'
import { useRangeDrag } from './use-range-drag'

interface RangeZoomStripProps {
  currentTime: number
  duration: number
  onSeek: (time: number) => void
  className?: string
}

/**
 * A magnified timeline of just the stretch around the drafted range, so the
 * start and end can be dragged to the frame on a long video. On a one-hour bar
 * a pixel is several seconds; here it is a fraction of one.
 *
 * The window is frozen while a handle is being dragged here (otherwise the
 * handle would slide under the pointer) and re-frames around the new range on
 * release, or whenever the range changes from somewhere else.
 */
export function RangeZoomStrip({ currentTime, duration, onSeek, className }: RangeZoomStripProps) {
  const pendingRange = useReviewStore((s) => s.pendingRange)
  const trackRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<ZoomWindow | null>(() =>
    pendingRange ? zoomWindow(pendingRange, duration) : null,
  )
  // Pointer handlers read the current view through a ref, not a stale closure.
  const viewRef = useRef(view)
  viewRef.current = view
  const scrubPointerRef = useRef<number | null>(null)

  // Unmounting mid-scrub must not leave the gesture claimed.
  useEffect(
    () => () => {
      if (scrubPointerRef.current !== null) useReviewStore.getState().endRangeGesture(scrubPointerRef.current)
    },
    [],
  )

  // Pointer position as a ratio across the track (can be below 0 or above 1), or null before layout.
  const ratioAt = useCallback((clientX: number): number | null => {
    const track = trackRef.current
    if (!track) return null
    const rect = track.getBoundingClientRect()
    return (clientX - rect.left) / rect.width
  }, [])

  // For scrubbing: stays inside the strip.
  const timeAt = useCallback(
    (clientX: number): number => {
      const ratio = ratioAt(clientX)
      const current = viewRef.current
      return ratio === null || !current ? 0 : windowTimeAt(ratio, current)
    },
    [ratioAt],
  )

  // For dragging handles: not clamped, so a handle grabbed off its edge can still reach the ends.
  const rawTimeAt = useCallback(
    (clientX: number): number => {
      const ratio = ratioAt(clientX)
      const current = viewRef.current
      return ratio === null || !current ? 0 : windowTimeAtUnclamped(ratio, current)
    },
    [ratioAt],
  )

  const reframe = useCallback(() => {
    const range = useReviewStore.getState().pendingRange
    if (range) setView(zoomWindow(range, duration))
  }, [duration])

  const { handlersFor, isDragging } = useRangeDrag({ timeAt: rawTimeAt, duration, onSeek, onDragEnd: reframe })

  useEffect(() => {
    if (pendingRange && !isDragging()) setView(zoomWindow(pendingRange, duration))
  }, [pendingRange, duration, isDragging])

  if (!pendingRange || !view) return null

  const startPercent = windowPercent(pendingRange.start, view)
  const endPercent = windowPercent(pendingRange.end, view)
  const playheadInWindow = currentTime >= view.start && currentTime <= view.end

  // Pressing or dragging the strip itself (not a handle) scrubs the video, to find the frame.
  const handleScrubDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (!useReviewStore.getState().beginRangeGesture(e.pointerId)) return // another pointer owns the gesture
    e.currentTarget.setPointerCapture(e.pointerId)
    scrubPointerRef.current = e.pointerId
    onSeek(timeAt(e.clientX))
  }
  const handleScrubMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (scrubPointerRef.current === e.pointerId && useReviewStore.getState().rangeGesturePointer === e.pointerId) {
      onSeek(timeAt(e.clientX))
    }
  }
  const endScrub = (e: React.PointerEvent<HTMLDivElement>) => {
    if (scrubPointerRef.current !== e.pointerId) return
    scrubPointerRef.current = null
    useReviewStore.getState().endRangeGesture(e.pointerId)
  }

  return (
    // Wider side padding than the main bar: a handle at the very start or end of the
    // media has its grab area outside the track, and the viewer clips anything past the edge.
    <div data-testid="range-zoom-strip" className={cn('w-full px-6 md:px-8', className)}>
      <div
        data-testid="range-zoom-hit-area"
        className="relative w-full cursor-pointer touch-none py-3 md:py-2"
        onPointerDown={handleScrubDown}
        onPointerMove={handleScrubMove}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
        onLostPointerCapture={endScrub}
      >
        <div ref={trackRef} data-testid="range-zoom-track" className="relative h-2 w-full rounded-full bg-border">
          <div
            className="pointer-events-none absolute inset-y-0 rounded-full bg-amber-400/70"
            style={{ left: `${startPercent}%`, width: `${endPercent - startPercent}%` }}
          />
          {playheadInWindow && (
            <div
              data-testid="range-zoom-playhead"
              className="pointer-events-none absolute top-1/2 z-10 h-4 w-0.5 -translate-x-1/2 -translate-y-1/2 bg-white/80"
              style={{ left: `${windowPercent(currentTime, view)}%` }}
            />
          )}
          <RangeHandle
            edge="start"
            time={pendingRange.start}
            duration={duration}
            leftPercent={startPercent}
            handlers={handlersFor('start')}
          />
          <RangeHandle
            edge="end"
            time={pendingRange.end}
            duration={duration}
            leftPercent={endPercent}
            handlers={handlersFor('end')}
          />
        </div>
      </div>
      <div className="flex justify-between font-mono text-[10px] text-amber-300/90 select-none">
        <span>start {formatTimecode(pendingRange.start)}</span>
        <span>{(pendingRange.end - pendingRange.start).toFixed(1)}s</span>
        <span>end {formatTimecode(pendingRange.end)}</span>
      </div>
    </div>
  )
}
