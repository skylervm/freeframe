'use client'

import type React from 'react'
import { useCallback, useRef } from 'react'
import { moveRangeEdge, type RangeEdge } from '@/lib/clip-range'
import { useReviewStore } from '@/stores/review-store'

interface UseRangeDragOptions {
  /** Media time under a pointer position, in the caller's own scale (full bar or zoom strip). */
  timeAt: (clientX: number) => number
  duration: number
  /** Scrub the video to the edge being dragged. */
  onSeek: (time: number) => void
  onDragEnd?: () => void
}

/**
 * Pointer handlers for dragging a clip range's start/end edge. Shared by the
 * main progress bar and the zoom strip, which differ only in how a pointer
 * position maps to a time.
 */
export function useRangeDrag({ timeAt, duration, onSeek, onDragEnd }: UseRangeDragOptions) {
  // A ref, not state: pointermove must see the edge grabbed by the pointerdown
  // that just fired, before React has re-rendered.
  const draggingEdgeRef = useRef<RangeEdge | null>(null)

  const finish = useCallback(() => {
    if (draggingEdgeRef.current === null) return
    draggingEdgeRef.current = null
    onDragEnd?.()
  }, [onDragEnd])

  const handlersFor = useCallback(
    (edge: RangeEdge) => ({
      onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
        // Keep the surrounding bar's own press-to-seek out of it.
        e.stopPropagation()
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        draggingEdgeRef.current = edge
      },
      onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
        if (draggingEdgeRef.current !== edge) return
        // Read the range at event time so a slow render never moves a stale copy.
        const { pendingRange, setPendingRange } = useReviewStore.getState()
        if (!pendingRange) return
        const next = moveRangeEdge(pendingRange, edge, timeAt(e.clientX), duration)
        setPendingRange(next)
        onSeek(next[edge])
      },
      onPointerUp: finish,
      onPointerCancel: finish,
      onLostPointerCapture: finish,
    }),
    [timeAt, duration, onSeek, finish],
  )

  const isDragging = useCallback(() => draggingEdgeRef.current !== null, [])

  return { handlersFor, isDragging }
}
