import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { VideoPlayer } from '../video-player'

const setPlaybackRate = vi.fn()
const setQuality = vi.fn()
// The compact box reads the real element, so tests need to drive the ref.
const playerState = vi.hoisted(() => ({
  videoRef: { current: null as HTMLVideoElement | null },
  isFullscreen: false,
}))
const dropdownState = vi.hoisted(() => ({
  onValueChange: undefined as undefined | ((value: string) => void),
  value: undefined as string | undefined,
}))

vi.mock('@radix-ui/react-dropdown-menu', () => ({
  Root: ({ children }: { children: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Item: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button type="button" data-testid="transport-menu-item" onClick={() => onSelect?.()}>{children}</button>
  ),
  Sub: ({ children }: { children: ReactNode }) => <>{children}</>,
  SubTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  SubContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  RadioGroup: ({ children, onValueChange, value }: { children: ReactNode; onValueChange: (value: string) => void; value: string }) => {
    dropdownState.onValueChange = onValueChange
    dropdownState.value = value
    return <>{children}</>
  },
  RadioItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <button type="button" role="menuitemradio" aria-checked={dropdownState.value === value} onClick={() => dropdownState.onValueChange?.(value)}>{children}</button>
  ),
}))

vi.mock('@/hooks/use-video-player', () => ({
  useVideoPlayer: () => ({ videoRef: playerState.videoRef, isPlaying: false, currentTime: 0, duration: 60, buffered: 0, volume: 1, isMuted: false, playbackRate: 1, qualityLevels: [{ index: 0, label: '720p', height: 720, bitrate: 1 }], currentQuality: -1, isLoading: false, isFullscreen: playerState.isFullscreen, error: null, pause: vi.fn(), togglePlay: vi.fn(), seek: vi.fn(), setPlaybackRate, setQuality, toggleMute: vi.fn(), toggleFullscreen: vi.fn() }),
}))
vi.mock('../review-provider', () => ({ useReview: () => ({ registerPauseHandler: vi.fn() }) }))
vi.mock('@/stores/review-store', () => ({ useReviewStore: () => ({ isDrawingMode: false, timeFormat: 'standard', setTimeFormat: vi.fn(), setPlayheadTime: vi.fn(), currentVersion: { id: 'v1' } }) }))
vi.mock('@/lib/api', () => ({ api: { get: vi.fn().mockResolvedValue({ url: '/video.mp4' }) } }))
vi.mock('../progress-bar', () => ({ ProgressBar: () => <div /> }))

describe('VideoPlayer compact transport', () => {
  it('keeps direct controls and exposes retained actions in More', async () => {
    const user = userEvent.setup()
    render(<VideoPlayer assetId="asset-1" />)
    expect(screen.getByRole('button', { name: 'More playback controls' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enter fullscreen' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Loop' })[0]).toHaveClass('hidden', 'lg:flex')
    expect(screen.getAllByRole('button', { name: 'Playback speed' })[0]).toHaveClass('hidden', 'lg:flex')
    expect(screen.getByRole('combobox', { name: 'Quality' })).toHaveClass('hidden', 'lg:block')
    const timeButton = screen.getByRole('button', { name: 'Time format' })
    expect(timeButton).toHaveClass('max-w-full', 'min-w-0', 'overflow-hidden')
    await user.click(screen.getByRole('button', { name: 'More playback controls' }))
    expect(screen.getByText('Loop')).toBeInTheDocument()
    expect(screen.getByText('Playback speed')).toBeInTheDocument()
    await user.click(screen.getAllByTestId('transport-menu-item')[1])
    expect(setPlaybackRate).toHaveBeenCalledWith(1.25)
    await user.click(screen.getByText('Quality'))
    expect(screen.getByRole('menuitemradio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menuitemradio', { name: '720p' })).toHaveAttribute('aria-checked', 'false')
    await user.click(screen.getByRole('menuitemradio', { name: '720p' }))
    expect(setQuality).toHaveBeenCalledWith(0)
  })
})

describe('VideoPlayer compact box', () => {
  const area = () => document.querySelector('.review-video-area') as HTMLElement

  // React owns `videoRef`, so the element under test is the one it committed.
  // jsdom never decodes media, so its dimensions stay 0 until they are pinned.
  const reportSize = (width: number, height: number, event: 'loadedmetadata' | 'resize') => {
    const video = document.querySelector('video') as HTMLVideoElement
    Object.defineProperty(video, 'videoWidth', { value: width, configurable: true })
    Object.defineProperty(video, 'videoHeight', { value: height, configurable: true })
    act(() => {
      video.dispatchEvent(new Event(event))
    })
  }

  beforeEach(() => {
    playerState.videoRef = { current: null }
    playerState.isFullscreen = false
  })

  it('sizes the box to a vertical clip rather than pillarboxing it into 16:9', () => {
    render(<VideoPlayer assetId="asset-1" compact />)
    reportSize(1080, 1920, 'loadedmetadata')

    expect(area()).toHaveClass('aspect-[var(--review-aspect)]', 'md:aspect-auto')
    expect(area().style.getPropertyValue('--review-aspect')).toBe(String(1080 / 1920))
  })

  it('sizes the box to a widescreen clip', () => {
    render(<VideoPlayer assetId="asset-1" compact />)
    reportSize(1920, 1080, 'loadedmetadata')

    expect(area().style.getPropertyValue('--review-aspect')).toBe(String(1920 / 1080))
  })

  it('falls back to 16:9 until metadata arrives, so the box does not jump', () => {
    render(<VideoPlayer assetId="asset-1" compact />)

    expect(area().style.getPropertyValue('--review-aspect')).toBe(String(16 / 9))
  })

  it('re-reads the ratio when the source resizes on a quality switch', () => {
    render(<VideoPlayer assetId="asset-1" compact />)
    reportSize(1920, 1080, 'loadedmetadata')
    reportSize(1440, 1080, 'resize')

    expect(area().style.getPropertyValue('--review-aspect')).toBe(String(1440 / 1080))
  })

  it('fills the column instead of taking an aspect box when not compact', () => {
    render(<VideoPlayer assetId="asset-1" />)
    reportSize(1080, 1920, 'loadedmetadata')

    expect(area()).toHaveClass('flex-1', 'min-h-0')
    expect(area().className).not.toContain('aspect-')
    expect(area().style.getPropertyValue('--review-aspect')).toBe('')
  })

  it('ignores compact in fullscreen, where the player fills the screen', () => {
    playerState.isFullscreen = true
    render(<VideoPlayer assetId="asset-1" compact />)
    reportSize(1080, 1920, 'loadedmetadata')

    expect(area()).toHaveClass('flex-1', 'min-h-0')
    expect(area().className).not.toContain('aspect-')
  })
})
