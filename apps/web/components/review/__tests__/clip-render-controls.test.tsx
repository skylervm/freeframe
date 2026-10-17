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
      job: status ? { id: 'job', asset_id: 'asset', version_id: 'version', status, clips_rendered: 2, message: 'Render stopped.' } : null,
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
