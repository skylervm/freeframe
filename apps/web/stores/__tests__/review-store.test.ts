import { describe, it, expect, beforeEach } from 'vitest'
import { useReviewStore } from '../review-store'

describe('Review store', () => {
  beforeEach(() => {
    useReviewStore.getState().reset()
  })

  it('has correct initial state', () => {
    const state = useReviewStore.getState()
    expect(state.currentAsset).toBeNull()
    expect(state.currentVersion).toBeNull()
    expect(state.playheadTime).toBe(0)
    expect(state.isDrawingMode).toBe(false)
    expect(state.drawingTool).toBe('pen')
    expect(state.drawingColor).toBe('#FF3B30')
    expect(state.brushSize).toBe(4)
  })

  it('setPlayheadTime updates playhead time', () => {
    useReviewStore.getState().setPlayheadTime(42.5)
    expect(useReviewStore.getState().playheadTime).toBe(42.5)
  })

  it('toggleDrawingMode toggles the drawing mode', () => {
    expect(useReviewStore.getState().isDrawingMode).toBe(false)
    useReviewStore.getState().toggleDrawingMode()
    expect(useReviewStore.getState().isDrawingMode).toBe(true)
    useReviewStore.getState().toggleDrawingMode()
    expect(useReviewStore.getState().isDrawingMode).toBe(false)
  })

  it('setDrawingTool changes the drawing tool', () => {
    useReviewStore.getState().setDrawingTool('rectangle')
    expect(useReviewStore.getState().drawingTool).toBe('rectangle')
    useReviewStore.getState().setDrawingTool('arrow')
    expect(useReviewStore.getState().drawingTool).toBe('arrow')
  })

  it('setDrawingColor changes the drawing color', () => {
    useReviewStore.getState().setDrawingColor('#00FF00')
    expect(useReviewStore.getState().drawingColor).toBe('#00FF00')
  })

  it('setBrushSize changes the brush size', () => {
    useReviewStore.getState().setBrushSize(10)
    expect(useReviewStore.getState().brushSize).toBe(10)
  })

  it('reset returns all state to initial values', () => {
    useReviewStore.getState().setPlayheadTime(100)
    useReviewStore.getState().toggleDrawingMode()
    useReviewStore.getState().setDrawingTool('rectangle')
    useReviewStore.getState().setDrawingColor('#0000FF')
    useReviewStore.getState().setBrushSize(20)

    useReviewStore.getState().reset()

    const state = useReviewStore.getState()
    expect(state.playheadTime).toBe(0)
    expect(state.isDrawingMode).toBe(false)
    expect(state.drawingTool).toBe('pen')
    expect(state.drawingColor).toBe('#FF3B30')
    expect(state.brushSize).toBe(4)
  })

  it('setCurrentVersion clears activeAnnotation and focusedCommentId on version change', () => {
    const v1 = { id: 'v1', version_number: 1 } as any
    const v2 = { id: 'v2', version_number: 2 } as any

    useReviewStore.getState().setCurrentVersion(v1)
    useReviewStore.getState().setActiveAnnotation({ strokes: [] })
    useReviewStore.getState().setFocusedCommentId('c1')

    useReviewStore.getState().setCurrentVersion(v2)

    const state = useReviewStore.getState()
    expect(state.currentVersion).toEqual(v2)
    expect(state.activeAnnotation).toBeNull()
    expect(state.focusedCommentId).toBeNull()
  })

  it('setCurrentVersion does not clear activeAnnotation on initial set or same version re-selection', () => {
    const v1 = { id: 'v1', version_number: 1 } as any

    useReviewStore.getState().setCurrentVersion(v1)
    useReviewStore.getState().setActiveAnnotation({ strokes: [] })
    useReviewStore.getState().setFocusedCommentId('c1')

    useReviewStore.getState().setCurrentVersion(v1)

    const state = useReviewStore.getState()
    expect(state.currentVersion).toEqual(v1)
    expect(state.activeAnnotation).toEqual({ strokes: [] })
    expect(state.focusedCommentId).toBe('c1')
  })
})

describe('review store clip range', () => {
  beforeEach(() => {
    useReviewStore.getState().reset()
  })

  it('clears the drafted range and loop when the asset changes', () => {
    const store = useReviewStore.getState()
    store.setMediaDuration(120)
    store.setPendingRange({ start: 10, end: 20 })
    store.setLoopRange(true)

    store.setCurrentAsset({ id: 'asset-2' } as any)

    const state = useReviewStore.getState()
    expect(state.pendingRange).toBeNull()
    expect(state.loopRange).toBe(false)
    expect(state.mediaDuration).toBe(0)
  })

  it('clears the drafted range when the version changes, not on re-selecting the same one', () => {
    const v1 = { id: 'v1', version_number: 1 } as any
    const v2 = { id: 'v2', version_number: 2 } as any
    useReviewStore.getState().setCurrentVersion(v1)
    useReviewStore.getState().setPendingRange({ start: 10, end: 20 })

    useReviewStore.getState().setCurrentVersion(v1)
    expect(useReviewStore.getState().pendingRange).toEqual({ start: 10, end: 20 })

    useReviewStore.getState().setCurrentVersion(v2)
    expect(useReviewStore.getState().pendingRange).toBeNull()
  })

  it('turns looping off when the range is cleared', () => {
    const store = useReviewStore.getState()
    store.setPendingRange({ start: 10, end: 20 })
    store.setLoopRange(true)
    store.setPendingRange(null)
    expect(useReviewStore.getState().loopRange).toBe(false)
  })
})

describe('review store clip range: version and duration changes', () => {
  beforeEach(() => {
    useReviewStore.getState().reset()
  })

  it('forgets the old video length when the version changes, so no range is drafted against it', () => {
    const v1 = { id: 'v1', version_number: 1 } as any
    const v2 = { id: 'v2', version_number: 2 } as any
    useReviewStore.getState().setCurrentVersion(v1)
    useReviewStore.getState().setMediaDuration(3000)

    useReviewStore.getState().setCurrentVersion(v2)

    expect(useReviewStore.getState().mediaDuration).toBe(0)
  })

  it('drops a draft that runs past the end of the video that just loaded, and keeps a valid one', () => {
    useReviewStore.getState().setPendingRange({ start: 2990, end: 2995 })
    useReviewStore.getState().setLoopRange(true)
    useReviewStore.getState().setMediaDuration(100)
    expect(useReviewStore.getState().pendingRange).toBeNull()
    expect(useReviewStore.getState().loopRange).toBe(false)

    useReviewStore.getState().setPendingRange({ start: 10, end: 20 })
    useReviewStore.getState().setMediaDuration(100)
    expect(useReviewStore.getState().pendingRange).toEqual({ start: 10, end: 20 })
  })

  it('abandons a gesture in progress when a shorter video invalidates the draft', () => {
    useReviewStore.getState().setPendingRange({ start: 2990, end: 2995 })
    useReviewStore.getState().beginRangeGesture(1)
    useReviewStore.getState().setMediaDuration(100)
    expect(useReviewStore.getState().pendingRange).toBeNull()
    expect(useReviewStore.getState().rangeGesturePointer).toBeNull()
  })

  it('clears the gesture on an asset or version change', () => {
    useReviewStore.getState().beginRangeGesture(1)
    useReviewStore.getState().setCurrentAsset({ id: 'a2' } as any)
    expect(useReviewStore.getState().rangeGesturePointer).toBeNull()
  })

  it('lets one pointer own the gesture at a time, and only that pointer release it', () => {
    const store = useReviewStore.getState()
    expect(store.beginRangeGesture(1)).toBe(true)
    expect(store.beginRangeGesture(2)).toBe(false)
    store.endRangeGesture(2) // not the owner: no effect
    expect(useReviewStore.getState().rangeGesturePointer).toBe(1)
    store.endRangeGesture(1)
    expect(useReviewStore.getState().rangeGesturePointer).toBeNull()
    expect(store.beginRangeGesture(2)).toBe(true)
  })

  it('abandons a gesture in progress when the range is removed', () => {
    useReviewStore.getState().setPendingRange({ start: 10, end: 20 })
    useReviewStore.getState().beginRangeGesture(1)
    useReviewStore.getState().setPendingRange(null)
    expect(useReviewStore.getState().rangeGesturePointer).toBeNull()
  })
})

