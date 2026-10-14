import { describe, expect, it } from 'vitest'
import { resolveSubmitTimecode, resolveSubmitTimecodes } from '../resolve-submit-timecode'

describe('resolveSubmitTimecode', () => {
  it('attached at playhead 0 includes the timecode (0, not undefined)', () => {
    expect(
      resolveSubmitTimecode({
        hasTimecode: true,
        timecodeAttached: true,
        hasAnnotation: false,
        playheadTime: 0,
      }),
    ).toBe(0)
  })

  it('attached at a non-zero playhead includes that timecode', () => {
    expect(
      resolveSubmitTimecode({
        hasTimecode: true,
        timecodeAttached: true,
        hasAnnotation: false,
        playheadTime: 42.5,
      }),
    ).toBe(42.5)
  })

  it('detached with no drawing omits the timecode', () => {
    expect(
      resolveSubmitTimecode({
        hasTimecode: true,
        timecodeAttached: false,
        hasAnnotation: false,
        playheadTime: 12,
      }),
    ).toBeUndefined()
  })

  it('detached WITH a drawing force-attaches the timecode (frame-anchored)', () => {
    expect(
      resolveSubmitTimecode({
        hasTimecode: true,
        timecodeAttached: false,
        hasAnnotation: true,
        playheadTime: 12,
      }),
    ).toBe(12)
  })

  it('detached WITH a drawing at playhead 0 still attaches 0', () => {
    expect(
      resolveSubmitTimecode({
        hasTimecode: true,
        timecodeAttached: false,
        hasAnnotation: true,
        playheadTime: 0,
      }),
    ).toBe(0)
  })

  it('non-timed media (image) never carries a timecode, even attached', () => {
    expect(
      resolveSubmitTimecode({
        hasTimecode: false,
        timecodeAttached: true,
        hasAnnotation: true,
        playheadTime: 5,
      }),
    ).toBeUndefined()
  })
})

describe('resolveSubmitTimecodes', () => {
  const base = { hasTimecode: true, timecodeAttached: true, hasAnnotation: false, playheadTime: 42, range: null }

  it('without a range it behaves like the single-timecode rule', () => {
    expect(resolveSubmitTimecodes(base)).toEqual({ start: 42 })
    expect(resolveSubmitTimecodes({ ...base, timecodeAttached: false })).toEqual({ start: undefined })
  })

  it('a drafted range sends both ends, even with the clock detached', () => {
    const range = { start: 10, end: 20 }
    expect(resolveSubmitTimecodes({ ...base, range })).toEqual({ start: 10, end: 20 })
    expect(resolveSubmitTimecodes({ ...base, range, timecodeAttached: false })).toEqual({ start: 10, end: 20 })
  })

  it('a range starting at 0 keeps the 0', () => {
    expect(resolveSubmitTimecodes({ ...base, range: { start: 0, end: 5 } })).toEqual({ start: 0, end: 5 })
  })

  it('a drawing wins: the comment is pinned to the playhead frame with no end', () => {
    expect(resolveSubmitTimecodes({ ...base, range: { start: 10, end: 20 }, hasAnnotation: true })).toEqual({ start: 42 })
  })

  it('media without timecodes never carries a range', () => {
    expect(resolveSubmitTimecodes({ ...base, hasTimecode: false, range: { start: 10, end: 20 } })).toEqual({ start: undefined })
  })
})
