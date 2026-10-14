'use client'

import type React from 'react'
import { useCallback, useRef } from 'react'
import { FRAME_SECONDS, moveRangeEdge, type RangeEdge } from '@/lib/clip-range'
import { useReviewStore } from '@/stores/review-store'

interface UseRangeDragOptions {
  /** Media time under a pointer position, in the caller's own scale (full bar or zoom strip). */
  timeAt: (clientX: number) => number
  duration: number
  /** Scrub the video to the edge being dragged. */
  onSeek: (time: number) => void
  onDragEnd?: () => void
}

interface ActiveDrag {
  edge: RangeEdge
  pointerId: number
  /** Media time between the grab point and the edge, kept so the edge never jumps under the pointer. */
  grabOffset: number
}

/**
 * Pointer and keyboard handlers for a clip range's start/end edge. Shared by
 * the main progress bar and the zoom strip, which differ only in how a pointer
 * position maps to a time.
 */
export function useRangeDrag({ timeAt, duration, onSeek, onDragEnd }: UseRangeDragOptions) {
  // A ref, not state: pointermove must see the edge grabbed by the pointerdown
  // that just fired, before React has re-rendered.
  const activeRef = useRef<ActiveDrag | null>(null)

  const finish = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Only the pointer that owns the drag can end it; a second finger lifting does not.
      if (!activeRef.current || activeRef.current.pointerId !== e.pointerId) return
      activeRef.current = null
      useReviewStore.getState().setRangeGestureActive(false)
      onDragEnd?.()
    },
    [onDragEnd],
  )

  const handlersFor = useCallback(
    (edge: RangeEdge) => ({
      onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
        // Keep the surrounding bar's own press-to-seek out of it.
        e.stopPropagation()
        e.preventDefault()
        if (activeRef.current) return // another finger already owns a drag
        const { pendingRange, setRangeGestureActive } = useReviewStore.getState()
        if (!pendingRange) return
        e.currentTarget.setPointerCapture(e.pointerId)
        activeRef.current = {
          edge,
          pointerId: e.pointerId,
          grabOffset: timeAt(e.clientX) - pendingRange[edge],
        }
        setRangeGestureActive(true)
      },
      onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
        const active = activeRef.current
        if (!active || active.edge !== edge || active.pointerId !== e.pointerId) return
        // Read the range at event time so a slow render never moves a stale copy.
        const { pendingRange, setPendingRange } = useReviewStore.getState()
        if (!pendingRange) return
        const next = moveRangeEdge(pendingRange, edge, timeAt(e.clientX) - active.grabOffset, duration)
        setPendingRange(next)
        onSeek(next[edge])
      },
      onPointerUp: finish,
      onPointerCancel: finish,
      onLostPointerCapture: finish,
      // Arrow keys nudge a focused handle: one frame, or one second with Shift.
      onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
        const direction = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
        if (direction === 0) return
        // These keys also drive the player's own frame stepping; the handle owns them while focused.
        e.preventDefault()
        e.stopPropagation()
        const { pendingRange, setPendingRange } = useReviewStore.getState()
        if (!pendingRange) return
        const step = e.shiftKey ? 1 : FRAME_SECONDS
        const next = moveRangeEdge(pendingRange, edge, pendingRange[edge] + direction * step, duration)
        setPendingRange(next)
        onSeek(next[edge])
      },
    }),
    [timeAt, duration, onSeek, finish],
  )

  const isDragging = useCallback(() => activeRef.current !== null, [])

  return { handlersFor, isDragging }
}
