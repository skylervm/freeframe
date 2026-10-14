import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RANGE_SECONDS,
  MIN_RANGE_SECONDS,
  defaultRange,
  loopTarget,
  moveRangeEdge,
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
