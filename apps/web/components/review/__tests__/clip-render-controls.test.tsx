import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClipRenderState } from '@/hooks/use-clip-render-job'
import type { ClipRenderJob } from '@/lib/clip-render-jobs'
import { ClipRenderControls } from '../clip-render-controls'

function state(status?: ClipRenderJob['status'], overrides: Partial<ClipRenderState> = {}): ClipRenderState {
  return {
    eligible: true,
    busy: false,
    error: null,
    generate: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    data: {
      job: status
        ? { id: 'job', asset_id: 'asset', version_id: 'version', status, ranges: [{ number: 1 }, { number: 3 }], clips_rendered: 2, message: 'Render stopped.' }
        : null,
      locked_count: 2,
      range_count: 3,
      worker_last_seen_at: new Date(Date.now() - 120_000).toISOString(),
    },
    ...overrides,
  }
}

beforeEach(() => vi.restoreAllMocks())

describe('clip render controls', () => {
  it('queues from the ready button and says unlocked ranges are skipped', () => {
    const value = state()
    render(<ClipRenderControls state={value} />)
    expect(screen.getByText('2 locked of 3. Unlocked ranges are skipped.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Generate clips' }))
    expect(value.generate).toHaveBeenCalledOnce()
  })

  it('disables generation when no ranges are locked', () => {
    const value = state()
    value.data!.locked_count = 0
    render(<ClipRenderControls state={value} />)
    const button = screen.getByRole('button', { name: 'Generate clips' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByText('Lock a range to generate clips')).toBeTruthy()
    fireEvent.click(button)
    expect(value.generate).not.toHaveBeenCalled()
  })

  it('shows the queue, relative worker time, and cancel action', () => {
    const value = state('queued')
    render(<ClipRenderControls state={value} />)
    expect(screen.getByText('Queued. Waiting for your Mac.')).toBeTruthy()
    expect(screen.getByText('Mac last seen 2 minutes ago')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Generate clips/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(value.cancel).toHaveBeenCalledOnce()
  })

  it('keeps an existing queue and cancel action after all range comments are deleted', () => {
    const value = state('queued')
    const { rerender } = render(<ClipRenderControls state={value} />)
    value.data = { ...value.data!, range_count: 0, locked_count: 0 }
    rerender(<ClipRenderControls state={value} />)
    expect(screen.getByText('Queued. Waiting for your Mac.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(value.cancel).toHaveBeenCalledOnce()
  })

  it('keeps the rendering status with no remaining ranges', () => {
    const value = state('claimed')
    value.data = { ...value.data!, range_count: 0, locked_count: 0 }
    render(<ClipRenderControls state={value} />)
    expect(screen.getByText('Rendering on your Mac')).toBeTruthy()
  })

  it.each(['done', 'failed', 'cancelled'] as const)('keeps a %s job with no ranges and disables generation', (status) => {
    const value = state(status)
    value.data = { ...value.data!, range_count: 0, locked_count: 0 }
    render(<ClipRenderControls state={value} />)
    if (status === 'done') expect(screen.getByText('Done: 2 clips')).toBeTruthy()
    if (status === 'failed') expect(screen.getByText('Render stopped.')).toBeTruthy()
    const button = screen.getByRole('button', { name: 'Generate clips' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByText('Lock a range to generate clips')).toBeTruthy()
    fireEvent.click(button)
    expect(value.generate).not.toHaveBeenCalled()
  })

  it('honestly says when the Mac has never been seen', () => {
    const value = state('queued')
    value.data!.worker_last_seen_at = null
    render(<ClipRenderControls state={value} />)
    expect(screen.getByText('Mac not seen yet')).toBeTruthy()
  })

  it('shows rendering without generate or cancel actions', () => {
    render(<ClipRenderControls state={state('claimed')} />)
    expect(screen.getByText('Rendering on your Mac')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  function renderingState(clipsRendered: number | null, total = 12) {
    const value = state('claimed')
    value.data!.job!.ranges = Array.from({ length: total }, (_, index) => ({ number: index + 1 }))
    value.data!.job!.clips_rendered = clipsRendered
    return value
  }

  it.each([[5, '5 of 12 clips done'], [11, '11 of 12 clips done']])('shows a progress bar at %i of 12 while rendering', (done, text) => {
    render(<ClipRenderControls state={renderingState(done)} />)
    const bar = screen.getByRole('progressbar', { name: 'Clip render progress' })
    expect(bar.getAttribute('aria-valuemin')).toBe('0')
    expect(bar.getAttribute('aria-valuemax')).toBe('12')
    expect(bar.getAttribute('aria-valuenow')).toBe(String(done))
    expect((bar.firstElementChild as HTMLElement).style.width).toBe(`${(done / 12) * 100}%`)
    expect(screen.getByText(text)).toBeTruthy()
    expect(screen.getByText('Rendering on your Mac')).toBeTruthy()
  })

  it.each([null, 0])('says the render is starting with an empty bar when %s clips are done', (done) => {
    render(<ClipRenderControls state={renderingState(done)} />)
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('0')
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('0%')
    expect(screen.getByText('Starting render')).toBeTruthy()
  })

  it('never fills past full if the server reports more clips than the job has', () => {
    render(<ClipRenderControls state={renderingState(14, 12)} />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('12')
    expect(screen.getByText('12 of 12 clips done')).toBeTruthy()
  })

  it('shows no bar when the job has no clips to count', () => {
    render(<ClipRenderControls state={renderingState(null, 0)} />)
    expect(screen.getByText('Rendering on your Mac')).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it.each(['queued', 'done', 'failed', 'cancelled'] as const)('shows no progress bar for a %s job', (status) => {
    render(<ClipRenderControls state={state(status)} />)
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('shows the progress bar inside the phone menu too', () => {
    render(
      <DropdownMenu.Root defaultOpen>
        <DropdownMenu.Trigger>More</DropdownMenu.Trigger>
        <DropdownMenu.Content><ClipRenderControls state={renderingState(3)} menu /></DropdownMenu.Content>
      </DropdownMenu.Root>,
    )
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('3')
    expect(screen.getByText('3 of 12 clips done')).toBeTruthy()
  })

  it('shows the completed clip count', () => {
    render(<ClipRenderControls state={state('done')} />)
    expect(screen.getByText('Done: 2 clips')).toBeTruthy()
  })

  it('renders worker failures as text and permits retry', () => {
    const value = state('failed')
    value.data!.job!.message = '<img src=x onerror=alert(1)>'
    const { container } = render(<ClipRenderControls state={value} />)
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Generate clips/ }))
    expect(value.generate).toHaveBeenCalledOnce()
  })

  it('allows generation again after cancellation', () => {
    render(<ClipRenderControls state={state('cancelled')} />)
    expect(screen.getByRole('button', { name: /Generate clips/ })).toBeTruthy()
  })

  it.each(['ineligible', 'no ranges', 'loading'])('hides for %s', (reason) => {
    const value = state()
    if (reason === 'ineligible') value.eligible = false
    if (reason === 'no ranges') value.data!.range_count = 0
    if (reason === 'loading') value.data = undefined
    const { container } = render(<ClipRenderControls state={value} />)
    expect(container.innerHTML).toBe('')
  })

  it('disables actions during a request and displays errors as text', () => {
    const { container } = render(<ClipRenderControls state={state(undefined, { busy: true, error: '<script>bad()</script>' })} />)
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('alert').textContent).toBe('<script>bad()</script>')
    expect(container.querySelector('script')).toBeNull()
  })

  it('puts the phone action inside the existing menu and keeps the menu open', () => {
    const value = state()
    render(
      <DropdownMenu.Root defaultOpen>
        <DropdownMenu.Trigger>More</DropdownMenu.Trigger>
        <DropdownMenu.Content><ClipRenderControls state={value} menu /></DropdownMenu.Content>
      </DropdownMenu.Root>,
    )
    fireEvent.click(screen.getByRole('menuitem', { name: /Generate clips/ }))
    expect(value.generate).toHaveBeenCalledOnce()
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Generate clips/ })).toBeNull()
  })

  it('cancels through the phone menu', () => {
    const value = state('queued')
    render(
      <DropdownMenu.Root defaultOpen>
        <DropdownMenu.Trigger>More</DropdownMenu.Trigger>
        <DropdownMenu.Content><ClipRenderControls state={value} menu /></DropdownMenu.Content>
      </DropdownMenu.Root>,
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel' }))
    expect(value.cancel).toHaveBeenCalledOnce()
  })
})
