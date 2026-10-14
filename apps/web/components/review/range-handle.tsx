'use client'

import type React from 'react'
import { cn } from '@/lib/utils'
import type { RangeEdge } from '@/lib/clip-range'

interface RangeHandleProps {
  edge: RangeEdge
  /** Media time this handle marks, for the slider's accessible value. */
  time: number
  duration: number
  /** Horizontal position inside the track, 0..100. */
  leftPercent: number
  handlers: {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void
    onPointerUp: () => void
    onPointerCancel: () => void
    onLostPointerCapture: () => void
  }
}

/**
 * One draggable range edge. The start handle's grab area sits to the LEFT of
 * the start line and the end handle's to the RIGHT of the end line, so a short
 * range never leaves the two overlapping.
 */
export function RangeHandle({ edge, time, duration, leftPercent, handlers }: RangeHandleProps) {
  return (
    <div
      role="slider"
      aria-label={edge === 'start' ? 'Range start' : 'Range end'}
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={time}
      data-testid={`range-handle-${edge}`}
      className={cn(
        'absolute top-1/2 z-20 flex h-11 w-11 -translate-y-1/2 cursor-ew-resize touch-none items-center md:h-8 md:w-8',
        edge === 'start' ? '-translate-x-full justify-end' : 'justify-start',
      )}
      style={{ left: `${leftPercent}%` }}
      {...handlers}
    >
      <div className="h-4 w-1.5 rounded-sm bg-amber-400 shadow-lg" />
    </div>
  )
}
