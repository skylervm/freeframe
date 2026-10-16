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

/** One frame at the app's fixed 24fps (see formatTimecode); the keyboard nudge step. */
export const FRAME_SECONDS = 1 / 24

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

/**
 * Playing a posted clip: what to do once the playhead has reached the end of its range.
 * With loop on it goes back to the start; with loop off it stops at the end.
 */
export function clipEndAction(
  currentTime: number,
  range: ClipRange | null,
  loopEnabled: boolean,
): 'restart' | 'stop' | null {
  if (!range || currentTime < range.end) return null
  return loopEnabled ? 'restart' : 'stop'
}

/** Slack either side of a clip before the playhead counts as having left it (scrubbed away). */
export const CLIP_EXIT_TOLERANCE_SECONDS = 0.5

export function isOutsideClip(currentTime: number, range: ClipRange): boolean {
  return (
    currentTime < range.start - CLIP_EXIT_TOLERANCE_SECONDS ||
    currentTime > range.end + CLIP_EXIT_TOLERANCE_SECONDS
  )
}

/** Context shown either side of the range in the zoom strip: at least this many seconds. */
export const ZOOM_MIN_PAD_SECONDS = 15

export interface ZoomWindow {
  start: number
  end: number
}

/**
 * The stretch of media the zoom strip shows: the range plus padding on both
 * sides (at least ZOOM_MIN_PAD_SECONDS, or half the range for long ranges),
 * kept inside 0..duration.
 */
export function zoomWindow(range: ClipRange, duration: number): ZoomWindow {
  const pad = Math.max(ZOOM_MIN_PAD_SECONDS, (range.end - range.start) / 2)
  return {
    start: Math.max(0, range.start - pad),
    end: Math.min(duration, range.end + pad),
  }
}

/** Where `time` sits inside the window as a 0..100 percentage (clamped). */
export function windowPercent(time: number, window: ZoomWindow): number {
  const length = window.end - window.start
  if (length <= 0) return 0
  return clamp(((time - window.start) / length) * 100, 0, 100)
}

/** The time at horizontal position `ratio` (0..1) across the window. */
export function windowTimeAt(ratio: number, window: ZoomWindow): number {
  return windowTimeAtUnclamped(clamp(ratio, 0, 1), window)
}

/**
 * Like windowTimeAt, but a position past either end of the strip maps to a time
 * past the window. Drags need this: a handle grabbed a few pixels off its edge
 * line must still be able to reach the very start or end, which means the
 * pointer going beyond the strip.
 */
export function windowTimeAtUnclamped(ratio: number, window: ZoomWindow): number {
  return window.start + ratio * (window.end - window.start)
}

