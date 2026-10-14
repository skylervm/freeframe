/**
 * Decide what timecode (if any) a submitted comment should carry.
 *
 * Rules:
 * - Non-timed media (images) never carries a timecode.
 * - A timecode that is attached (the user left the clock toggle on) is
 *   always included, INCLUDING 0 — 0:00 is a valid, meaningful video time
 *   and must never be silently dropped just because it's falsy.
 * - A drawing (Fabric annotation) is frame-anchored: if the submit carries
 *   an annotation payload, the timecode is force-included even when the
 *   user detached the clock toggle, because a comment with a drawing but
 *   no timecode on timed media is never valid.
 */
export interface ResolveSubmitTimecodeArgs {
  /** Asset supports timecodes at all (video/audio). */
  hasTimecode: boolean;
  /** User has the clock toggle attached. */
  timecodeAttached: boolean;
  /** This submit carries an annotation (drawing) payload. */
  hasAnnotation: boolean;
  /** Current playhead position in seconds. */
  playheadTime: number;
}

export function resolveSubmitTimecode({
  hasTimecode,
  timecodeAttached,
  hasAnnotation,
  playheadTime,
}: ResolveSubmitTimecodeArgs): number | undefined {
  if (!hasTimecode) return undefined;
  if (timecodeAttached || hasAnnotation) return playheadTime;
  return undefined;
}

export interface ResolveSubmitTimecodesArgs extends ResolveSubmitTimecodeArgs {
  /** The clip range drafted on the timeline, or null when range mode is off. */
  range: { start: number; end: number } | null;
}

/**
 * Start and end for a submitted comment.
 *
 * A drafted range wins over the clock toggle: choosing a range is itself the
 * request to attach timecodes. A drawing wins over a range, because a drawing
 * is pinned to one frame and cannot also span a clip.
 */
export function resolveSubmitTimecodes(args: ResolveSubmitTimecodesArgs): {
  start?: number;
  end?: number;
} {
  if (args.range && args.hasTimecode && !args.hasAnnotation) {
    return { start: args.range.start, end: args.range.end };
  }
  return { start: resolveSubmitTimecode(args) };
}
