'use client'

import type React from 'react'
import { useCallback, useEffect, useRef } from 'react'
import { FRAME_SECONDS, moveRangeEdge, type RangeEdge } from '@/lib/clip-range'
import { selectEditableRange, useReviewStore } from '@/stores/review-store'

interface UseRangeDragOptions {
  /**
   * Media time under a pointer position, NOT clamped to the track: a handle grabbed
   * off its edge line must be able to reach 0 and the end, so the pointer maps
   * beyond them. moveRangeEdge does the clamping.
   */
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
 * position maps to a time. The store decides which single pointer owns the
 * gesture across both, so a second finger on either timeline is ignored.
 */
export function useRangeDrag({ timeAt, duration, onSeek, onDragEnd }: UseRangeDragOptions) {
  // A ref, not state: pointermove must see the edge grabbed by the pointerdown
  // that just fired, before React has re-rendered.
  const activeRef = useRef<ActiveDrag | null>(null)

  // Unmounting mid-drag (range removed, screen left) must not leave the gesture claimed.
  useEffect(
    () => () => {
      if (activeRef.current) useReviewStore.getState().endRangeGesture(activeRef.current.pointerId)
    },
    [],
  )

  const finish = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Only the pointer that owns the drag can end it; a second finger lifting does not.
      if (!activeRef.current || activeRef.current.pointerId !== e.pointerId) return
      activeRef.current = null
      useReviewStore.getState().endRangeGesture(e.pointerId)
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
        const state = useReviewStore.getState()
        const range = selectEditableRange(state)
        if (!range) return
        if (!state.beginRangeGesture(e.pointerId)) return // another pointer owns the gesture
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          // The pointer is already gone, so no up or cancel will ever arrive to release the claim.
          useReviewStore.getState().endRangeGesture(e.pointerId)
          return
        }
        activeRef.current = {
          edge,
          pointerId: e.pointerId,
          grabOffset: timeAt(e.clientX) - range[edge],
        }
      },
      onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
        const active = activeRef.current
        if (!active || active.edge !== edge || active.pointerId !== e.pointerId) return
        // Read the range at event time so a slow render never moves a stale copy.
        const state = useReviewStore.getState()
        const range = selectEditableRange(state)
        // The store drops the gesture when the range is removed or the asset changes.
        if (!range || state.rangeGesturePointer !== e.pointerId) return
        const next = moveRangeEdge(range, edge, timeAt(e.clientX) - active.grabOffset, duration)
        state.setEditableRange(next)
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
        const state = useReviewStore.getState()
        const range = selectEditableRange(state)
        if (!range) return
        const step = e.shiftKey ? 1 : FRAME_SECONDS
        const next = moveRangeEdge(range, edge, range[edge] + direction * step, duration)
        state.setEditableRange(next)
        onSeek(next[edge])
      },
    }),
    [timeAt, duration, onSeek, finish],
  )

  // True only while this surface's own drag is the live gesture (a stale ref after the
  // store dropped the gesture does not count).
  const isDragging = useCallback(
    () => activeRef.current !== null && useReviewStore.getState().rangeGesturePointer === activeRef.current.pointerId,
    [],
  )

  return { handlersFor, isDragging }
}
