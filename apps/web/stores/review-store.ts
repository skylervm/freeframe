import { create } from 'zustand'
import type { Asset, AssetVersion } from '@/types'
import type { ClipRange } from '@/lib/clip-range'

type DrawingTool = 'pen' | 'rectangle' | 'arrow' | 'line'
export type TimeFormat = 'standard' | 'timecode' | 'frames'

/** A posted range comment being played; `editing` puts its start and end handles on the timeline. */
export interface ActiveClip {
  commentId: string
  range: ClipRange
  editing: boolean
}

interface ReviewState {
  currentAsset: Asset | null
  currentVersion: AssetVersion | null
  playheadTime: number
  /** Length of the loaded video in seconds; 0 until its metadata loads. */
  mediaDuration: number
  /** The clip range being drafted for the next comment, or null when range mode is off. */
  pendingRange: ClipRange | null
  /** The posted range comment being played, or null. Never set together with pendingRange. */
  activeClip: ActiveClip | null
  /** Loop playback inside pendingRange or activeClip (a clip starts out looping). */
  loopRange: boolean
  /**
   * Pointer id of the finger or mouse currently dragging a handle or scrubbing the zoom strip,
   * or null. One gesture at a time across both timelines; loop playback holds off while it is set.
   */
  rangeGesturePointer: number | null
  seekTarget: { time: number; id: number; pause?: boolean; play?: boolean } | null
  focusedCommentId: string | null
  pendingAnnotation: Record<string, unknown> | null
  activeAnnotation: Record<string, unknown> | null
  timeFormat: TimeFormat
  isDrawingMode: boolean
  drawingTool: DrawingTool
  drawingColor: string
  brushSize: number
  setCurrentAsset: (asset: Asset) => void
  setCurrentVersion: (version: AssetVersion) => void
  setPlayheadTime: (time: number) => void
  setMediaDuration: (duration: number) => void
  setPendingRange: (range: ClipRange | null) => void
  setLoopRange: (loop: boolean) => void
  /** Play only this posted range, looping. Abandons any draft range. */
  activateClip: (commentId: string, range: ClipRange) => void
  /** Stop playing the clip and drop its handles. */
  clearClip: () => void
  /** Show or hide the clip's start and end handles. */
  setClipEditing: (editing: boolean) => void
  /** Move the range the handles are on: the draft, or the clip being edited. */
  setEditableRange: (range: ClipRange) => void
  /** Claim the range gesture for this pointer; false if another pointer already holds it. */
  beginRangeGesture: (pointerId: number) => boolean
  /** Release the gesture, only if this pointer holds it. */
  endRangeGesture: (pointerId: number) => void
  seekTo: (time: number, pause?: boolean) => void
  setFocusedCommentId: (id: string | null) => void
  setPendingAnnotation: (data: Record<string, unknown> | null) => void
  setActiveAnnotation: (data: Record<string, unknown> | null) => void
  setTimeFormat: (format: TimeFormat) => void
  toggleDrawingMode: () => void
  setIsDrawingMode: (mode: boolean) => void
  setDrawingTool: (tool: DrawingTool) => void
  setDrawingColor: (color: string) => void
  setBrushSize: (size: number) => void
  reset: () => void
}

const initialState = {
  currentAsset: null,
  currentVersion: null,
  playheadTime: 0,
  mediaDuration: 0,
  pendingRange: null as ClipRange | null,
  activeClip: null as ActiveClip | null,
  loopRange: false,
  rangeGesturePointer: null as number | null,
  seekTarget: null,
  focusedCommentId: null,
  pendingAnnotation: null,
  activeAnnotation: null,
  timeFormat: 'timecode' as TimeFormat,
  isDrawingMode: false,
  drawingTool: 'pen' as DrawingTool,
  drawingColor: '#FF3B30',
  brushSize: 4,
}

export const useReviewStore = create<ReviewState>()((set, get) => ({
  ...initialState,

  setCurrentAsset: (asset: Asset) => {
    set({ currentAsset: asset, playheadTime: 0, mediaDuration: 0, pendingRange: null, activeClip: null, loopRange: false, rangeGesturePointer: null, seekTarget: null })
  },

  setCurrentVersion: (version: AssetVersion) => {
    set((state) =>
      state.currentVersion != null && state.currentVersion.id !== version.id
        ? { currentVersion: version, activeAnnotation: null, focusedCommentId: null, mediaDuration: 0, pendingRange: null, activeClip: null, loopRange: false, rangeGesturePointer: null }
        : { currentVersion: version },
    )
  },

  setPlayheadTime: (time: number) => {
    set({ playheadTime: time })
  },

  setMediaDuration: (duration: number) => {
    // A draft that runs past the end of the video that just loaded is no longer valid.
    set((state) => {
      const range = state.pendingRange ?? state.activeClip?.range
      return range && range.end > duration
        ? { mediaDuration: duration, pendingRange: null, activeClip: null, loopRange: false, rangeGesturePointer: null }
        : { mediaDuration: duration }
    })
  },

  setPendingRange: (range: ClipRange | null) => {
    // Leaving range mode also stops looping and abandons any drag in progress:
    // there is nothing left to loop or drag. Starting a draft over a playing clip
    // drops the clip, and the draft does not inherit the clip's looping.
    set((state) => {
      if (!range) return { pendingRange: null, loopRange: false, rangeGesturePointer: null }
      return state.activeClip
        ? { pendingRange: range, activeClip: null, loopRange: false, rangeGesturePointer: null }
        : { pendingRange: range }
    })
  },

  setLoopRange: (loop: boolean) => {
    set({ loopRange: loop })
  },

  activateClip: (commentId: string, range: ClipRange) => {
    set({
      activeClip: { commentId, range, editing: false },
      pendingRange: null,
      loopRange: true,
      rangeGesturePointer: null,
      seekTarget: { time: range.start, id: Date.now(), pause: false, play: true },
      playheadTime: range.start,
    })
  },

  clearClip: () => {
    set({ activeClip: null, loopRange: false, rangeGesturePointer: null })
  },

  setClipEditing: (editing: boolean) => {
    set((state) =>
      state.activeClip ? { activeClip: { ...state.activeClip, editing }, rangeGesturePointer: null } : state,
    )
  },

  setEditableRange: (range: ClipRange) => {
    set((state) => {
      if (state.pendingRange) return { pendingRange: range }
      if (state.activeClip?.editing) return { activeClip: { ...state.activeClip, range } }
      return state
    })
  },

  beginRangeGesture: (pointerId: number) => {
    if (get().rangeGesturePointer !== null) return false
    set({ rangeGesturePointer: pointerId })
    return true
  },

  endRangeGesture: (pointerId: number) => {
    set((state) => (state.rangeGesturePointer === pointerId ? { rangeGesturePointer: null } : state))
  },

  seekTo: (time: number, pause?: boolean) => {
    // Any ordinary seek (another comment, a timecode, a shortcut) leaves a playing clip.
    // While its handles are out, seeks are the drags and scrubs of editing it.
    set((state) => ({
      seekTarget: { time, id: Date.now(), pause },
      playheadTime: time,
      ...(state.activeClip && !state.activeClip.editing
        ? { activeClip: null, loopRange: false, rangeGesturePointer: null }
        : {}),
    }))
  },

  setFocusedCommentId: (id: string | null) => {
    set({ focusedCommentId: id })
  },

  setPendingAnnotation: (data: Record<string, unknown> | null) => {
    set({ pendingAnnotation: data })
  },

  setActiveAnnotation: (data: Record<string, unknown> | null) => {
    set({ activeAnnotation: data })
  },

  setTimeFormat: (format: TimeFormat) => {
    set({ timeFormat: format })
  },

  toggleDrawingMode: () => {
    set((state) => ({ isDrawingMode: !state.isDrawingMode }))
  },

  setIsDrawingMode: (mode: boolean) => {
    set({ isDrawingMode: mode })
  },

  setDrawingTool: (tool: DrawingTool) => {
    set({ drawingTool: tool })
  },

  setDrawingColor: (color: string) => {
    set({ drawingColor: color })
  },

  setBrushSize: (size: number) => {
    set({ brushSize: size })
  },

  reset: () => {
    set(initialState)
  },
}))

/** The range the start/end handles operate on: the draft, or the clip being edited. */
export const selectEditableRange = (state: ReviewState): ClipRange | null =>
  state.pendingRange ?? (state.activeClip?.editing ? state.activeClip.range : null)

/** The range playback is confined to: the draft, or the clip being played. */
export const selectLoopingRange = (state: ReviewState): ClipRange | null =>
  state.pendingRange ?? state.activeClip?.range ?? null
