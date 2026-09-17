import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { VideoPlayer } from '../video-player'

const setPlaybackRate = vi.fn()
const setQuality = vi.fn()
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
  useVideoPlayer: () => ({ videoRef: { current: null }, isPlaying: false, currentTime: 0, duration: 60, buffered: 0, volume: 1, isMuted: false, playbackRate: 1, qualityLevels: [{ index: 0, label: '720p', height: 720, bitrate: 1 }], currentQuality: -1, isLoading: false, isFullscreen: false, error: null, pause: vi.fn(), togglePlay: vi.fn(), seek: vi.fn(), setPlaybackRate, setQuality, toggleMute: vi.fn(), toggleFullscreen: vi.fn() }),
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
