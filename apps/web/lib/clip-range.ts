/**
 * Pure helpers for the draggable clip range (start/end handles on the timeline).
 * All times are seconds. Nothing here touches the DOM or the store, so the drag
 * rules can be tested without rendering.
 */
export interface ClipRange {
  start: number
  end: number
}

export type RangeEdge = 'start' | 'end'

/** How long a freshly created range is, before the user drags it. */
export const DEFAULT_RANGE_SECONDS = 5

/** The two handles can never be closer than this (also keeps end > start). */
export const MIN_RANGE_SECONDS = 0.5

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** A starting range at the playhead, shortened if it would run past the end. */
export function defaultRange(playhead: number, duration: number): ClipRange {
  const minLength = Math.min(MIN_RANGE_SECONDS, duration)
  const start = clamp(playhead, 0, Math.max(0, duration - minLength))
  const end = Math.min(start + DEFAULT_RANGE_SECONDS, duration)
  return { start, end }
}

/** Move one edge to `time`, keeping 0 <= start < end <= duration. */
export function moveRangeEdge(
  range: ClipRange,
  edge: RangeEdge,
  time: number,
  duration: number,
): ClipRange {
  if (edge === 'start') {
    const latestStart = Math.max(0, range.end - MIN_RANGE_SECONDS)
    return { start: clamp(time, 0, latestStart), end: range.end }
  }
  const earliestEnd = Math.min(duration, range.start + MIN_RANGE_SECONDS)
  return { start: range.start, end: clamp(time, earliestEnd, duration) }
}

/**
 * Loop playback: where to jump when the playhead has run past the end of the
 * range, or null to leave playback alone.
 */
export function loopTarget(
  currentTime: number,
  range: ClipRange | null,
  loopEnabled: boolean,
): number | null {
  if (!loopEnabled || !range) return null
  return currentTime >= range.end ? range.start : null
}
