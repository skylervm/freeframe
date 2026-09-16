import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'
import { useVideoPlayer } from '../use-video-player'

// The `detached` option is the mechanism that keeps a compare pane from writing
// to the GLOBAL review store (so it can't corrupt the normal single-asset
// reviewer's playhead/annotation). These tests pin that gate on the two most
// impactful store-write paths: the seek control and the ~4fps playhead sync.
//
// The hook's HLS/media effect bails while videoRef.current is null, so we attach
// a minimal fake element after render to drive the control paths without media.

beforeEach(() => {
  useReviewStore.getState().reset()
})

const SRC = 'http://example.test/v.m3u8'

// videoRef.current is typed read-only; attach a minimal fake element for tests.
function attach(ref: { current: HTMLVideoElement | null }, el: Partial<HTMLVideoElement>) {
  ref.current = el as HTMLVideoElement
}

function mockIOS() {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' })
}

describe('useVideoPlayer — detached gates global-store writes', () => {
  it('seek writes playheadTime to the store when ATTACHED (normal reviewer)', () => {
    const { result } = renderHook(() => useVideoPlayer(SRC))
    attach(result.current.videoRef, { currentTime: 0, duration: 60, paused: true })
    act(() => result.current.seek(12))
    expect(useReviewStore.getState().playheadTime).toBe(12)
  })

  it('seek does NOT write playheadTime when DETACHED (compare pane)', () => {
    const { result } = renderHook(() => useVideoPlayer(SRC, { detached: true }))
    attach(result.current.videoRef, { currentTime: 0, duration: 60, paused: true })
    act(() => result.current.seek(12))
    expect(useReviewStore.getState().playheadTime).toBe(0) // store untouched
  })

  it('syncs the playing video to the store when ATTACHED', () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useVideoPlayer(SRC))
      attach(result.current.videoRef, { currentTime: 7, paused: false })
      act(() => { vi.advanceTimersByTime(300) }) // one ~250ms sync tick
      expect(useReviewStore.getState().playheadTime).toBe(7)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never starts the playhead sync interval when DETACHED', () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useVideoPlayer(SRC, { detached: true }))
      attach(result.current.videoRef, { currentTime: 7, paused: false })
      act(() => { vi.advanceTimersByTime(1000) })
      expect(useReviewStore.getState().playheadTime).toBe(0) // store untouched
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('useVideoPlayer fullscreen', () => {
  function nativeFullscreenContainer() {
    const container = document.createElement('div')
    const video = document.createElement('video') as HTMLVideoElement & { webkitEnterFullscreen?: () => void }
    video.webkitEnterFullscreen = vi.fn()
    container.appendChild(video)
    return { container, video }
  }

  it('uses the iPhone video fullscreen API when the container API is unavailable', () => {
    mockIOS()
    const { result } = renderHook(() => useVideoPlayer(SRC))
    const { container, video } = nativeFullscreenContainer()
    Object.defineProperty(container, 'requestFullscreen', { configurable: true, value: undefined })

    act(() => result.current.toggleFullscreen(container))

    expect(video.webkitEnterFullscreen).toHaveBeenCalledOnce()
  })

  it('prefers the iPhone video fullscreen API over the container API', () => {
    mockIOS()
    const { result } = renderHook(() => useVideoPlayer(SRC))
    const { container, video } = nativeFullscreenContainer()
    const requestFullscreen = vi.fn()
    Object.defineProperty(container, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen,
    })

    act(() => result.current.toggleFullscreen(container))

    expect(video.webkitEnterFullscreen).toHaveBeenCalledOnce()
    expect(requestFullscreen).not.toHaveBeenCalled()
  })

  it('uses container fullscreen outside iOS even when WebKit video fullscreen exists', () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Macintosh' })
    const { result } = renderHook(() => useVideoPlayer(SRC))
    const { container, video } = nativeFullscreenContainer()
    const requestFullscreen = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(container, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen,
    })

    act(() => result.current.toggleFullscreen(container))

    expect(requestFullscreen).toHaveBeenCalledOnce()
    expect(video.webkitEnterFullscreen).not.toHaveBeenCalled()
  })

  it('does not fall back to WebKit video fullscreen when non-iOS container fullscreen rejects', async () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Macintosh' })
    const { result } = renderHook(() => useVideoPlayer(SRC))
    const { container, video } = nativeFullscreenContainer()
    const requestFullscreen = vi.fn().mockRejectedValue(new Error('unsupported'))
    Object.defineProperty(container, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen,
    })

    await act(async () => result.current.toggleFullscreen(container))

    expect(requestFullscreen).toHaveBeenCalledOnce()
    expect(video.webkitEnterFullscreen).not.toHaveBeenCalled()
  })

  it('falls back to container fullscreen when the iPhone video API throws synchronously', () => {
    mockIOS()
    const { result } = renderHook(() => useVideoPlayer(SRC))
    const { container, video } = nativeFullscreenContainer()
    video.webkitEnterFullscreen = vi.fn(() => {
      throw new Error('native fullscreen unavailable')
    })
    const requestFullscreen = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(container, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen,
    })

    act(() => result.current.toggleFullscreen(container))

    expect(video.webkitEnterFullscreen).toHaveBeenCalledOnce()
    expect(requestFullscreen).toHaveBeenCalledOnce()
  })
})
