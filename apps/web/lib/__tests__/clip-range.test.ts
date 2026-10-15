import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RANGE_SECONDS,
  MIN_RANGE_SECONDS,
  ZOOM_MIN_PAD_SECONDS,
  defaultRange,
  loopTarget,
  moveRangeEdge,
  windowPercent,
  windowTimeAt,
  zoomWindow,
} from '../clip-range'

describe('defaultRange', () => {
  it('starts at the playhead and runs the default length', () => {
    expect(defaultRange(100, 3000)).toEqual({ start: 100, end: 100 + DEFAULT_RANGE_SECONDS })
  })

  it('shortens the range instead of running past the end of the media', () => {
    expect(defaultRange(2998, 3000)).toEqual({ start: 2998, end: 3000 })
  })

  it('pulls the start back when the playhead is at the very end', () => {
    const range = defaultRange(3000, 3000)
    expect(range.end).toBe(3000)
    expect(range.end - range.start).toBeCloseTo(MIN_RANGE_SECONDS)
  })

  it('never goes below 0 for a negative playhead', () => {
    expect(defaultRange(-4, 3000).start).toBe(0)
  })
})

describe('moveRangeEdge', () => {
  const range = { start: 10, end: 20 }

  it('moves the start freely inside the media', () => {
    expect(moveRangeEdge(range, 'start', 12, 100)).toEqual({ start: 12, end: 20 })
  })

  it('stops the start one minimum step before the end', () => {
    expect(moveRangeEdge(range, 'start', 50, 100)).toEqual({ start: 20 - MIN_RANGE_SECONDS, end: 20 })
  })

  it('stops the end one minimum step after the start', () => {
    expect(moveRangeEdge(range, 'end', 2, 100)).toEqual({ start: 10, end: 10 + MIN_RANGE_SECONDS })
  })

  it('clamps the start at 0 and the end at the duration', () => {
    expect(moveRangeEdge(range, 'start', -5, 100).start).toBe(0)
    expect(moveRangeEdge(range, 'end', 500, 100).end).toBe(100)
  })

  it('does not change the other edge', () => {
    expect(moveRangeEdge(range, 'start', 15, 100).end).toBe(20)
    expect(moveRangeEdge(range, 'end', 15, 100).start).toBe(10)
  })
})

describe('loopTarget', () => {
  const range = { start: 10, end: 20 }

  it('jumps back to the start once the playhead reaches the end', () => {
    expect(loopTarget(20, range, true)).toBe(10)
    expect(loopTarget(20.4, range, true)).toBe(10)
  })

  it('leaves playback alone inside the range', () => {
    expect(loopTarget(15, range, true)).toBeNull()
  })

  it('does nothing when looping is off or there is no range', () => {
    expect(loopTarget(25, range, false)).toBeNull()
    expect(loopTarget(25, null, true)).toBeNull()
  })
})

describe('zoomWindow', () => {
  it('pads a short range by the minimum on both sides', () => {
    expect(zoomWindow({ start: 320, end: 340 }, 3565)).toEqual({
      start: 320 - ZOOM_MIN_PAD_SECONDS,
      end: 340 + ZOOM_MIN_PAD_SECONDS,
    })
  })

  it('pads a long range by half its length', () => {
    expect(zoomWindow({ start: 1000, end: 1200 }, 3565)).toEqual({ start: 900, end: 1300 })
  })

  it('stays inside the media at both ends', () => {
    expect(zoomWindow({ start: 5, end: 10 }, 3565).start).toBe(0)
    expect(zoomWindow({ start: 3550, end: 3560 }, 3565).end).toBe(3565)
  })

  it('always contains the range', () => {
    const range = { start: 100, end: 140 }
    const window = zoomWindow(range, 3565)
    expect(window.start).toBeLessThan(range.start)
    expect(window.end).toBeGreaterThan(range.end)
  })
})

describe('window mapping', () => {
  const window = { start: 100, end: 200 }

  it('maps a time to a percentage across the window', () => {
    expect(windowPercent(150, window)).toBe(50)
    expect(windowPercent(100, window)).toBe(0)
    expect(windowPercent(200, window)).toBe(100)
  })

  it('clamps times outside the window', () => {
    expect(windowPercent(50, window)).toBe(0)
    expect(windowPercent(500, window)).toBe(100)
  })

  it('maps a horizontal ratio back to a time, clamped to the window', () => {
    expect(windowTimeAt(0.25, window)).toBe(125)
    expect(windowTimeAt(-1, window)).toBe(100)
    expect(windowTimeAt(2, window)).toBe(200)
  })

  it('is stable for a zero-length window', () => {
    expect(windowPercent(5, { start: 5, end: 5 })).toBe(0)
  })
})

