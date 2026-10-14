import { create } from 'zustand'
import type { Asset, AssetVersion } from '@/types'
import type { ClipRange } from '@/lib/clip-range'

type DrawingTool = 'pen' | 'rectangle' | 'arrow' | 'line'
export type TimeFormat = 'standard' | 'timecode' | 'frames'

interface ReviewState {
  currentAsset: Asset | null
  currentVersion: AssetVersion | null
  playheadTime: number
  /** Length of the loaded video in seconds; 0 until its metadata loads. */
  mediaDuration: number
  /** The clip range being drafted for the next comment, or null when range mode is off. */
  pendingRange: ClipRange | null
  /** Loop playback inside pendingRange. */
  loopRange: boolean
  /** True while a handle is being dragged or the zoom strip scrubbed; loop playback holds off. */
  rangeGestureActive: boolean
  seekTarget: { time: number; id: number; pause?: boolean } | null
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
  setRangeGestureActive: (active: boolean) => void
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
  loopRange: false,
  rangeGestureActive: false,
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

export const useReviewStore = create<ReviewState>()((set) => ({
  ...initialState,

  setCurrentAsset: (asset: Asset) => {
    set({ currentAsset: asset, playheadTime: 0, mediaDuration: 0, pendingRange: null, loopRange: false, rangeGestureActive: false, seekTarget: null })
  },

  setCurrentVersion: (version: AssetVersion) => {
    set((state) =>
      state.currentVersion != null && state.currentVersion.id !== version.id
        ? { currentVersion: version, activeAnnotation: null, focusedCommentId: null, mediaDuration: 0, pendingRange: null, loopRange: false, rangeGestureActive: false }
        : { currentVersion: version },
    )
  },

  setPlayheadTime: (time: number) => {
    set({ playheadTime: time })
  },

  setMediaDuration: (duration: number) => {
    // A draft that runs past the end of the video that just loaded is no longer valid.
    set((state) => {
      const range = state.pendingRange
      return range && range.end > duration
        ? { mediaDuration: duration, pendingRange: null, loopRange: false }
        : { mediaDuration: duration }
    })
  },

  setPendingRange: (range: ClipRange | null) => {
    // Leaving range mode also stops looping: there is nothing left to loop.
    set(range ? { pendingRange: range } : { pendingRange: null, loopRange: false })
  },

  setLoopRange: (loop: boolean) => {
    set({ loopRange: loop })
  },

  setRangeGestureActive: (active: boolean) => {
    set({ rangeGestureActive: active })
  },

  seekTo: (time: number, pause?: boolean) => {
    set({ seekTarget: { time, id: Date.now(), pause }, playheadTime: time })
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
