import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProjectSettingsDialog } from '../project-settings-dialog'
import { api } from '@/lib/api'
import type { Project } from '@/types'

vi.mock('@/lib/api', () => ({
  api: { patch: vi.fn(), delete: vi.fn(), upload: vi.fn() },
}))

const project = {
  id: 'p1', name: 'Original', description: 'Original description',
  is_public: false, poster_source: 'manual', poster_url: 'https://storage.test/manual.jpg',
} as Project

beforeEach(() => {
  vi.resetAllMocks()
})

describe('project cover reset', () => {
  it('stages the reset and saves it together with drafted project fields', async () => {
    const onUpdated = vi.fn()
    render(<ProjectSettingsDialog project={project} open onOpenChange={vi.fn()} onUpdated={onUpdated} />)
    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'Renamed' } })
    fireEvent.change(screen.getByPlaceholderText('Optional project description...'), { target: { value: 'New description' } })
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.click(screen.getByRole('button', { name: 'Use automatic cover' }))
    expect(api.delete).not.toHaveBeenCalled()
    expect(api.patch).not.toHaveBeenCalled()
    expect(screen.getByPlaceholderText('Project name')).toHaveValue('Renamed')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onUpdated).toHaveBeenCalledOnce())
    expect(api.delete).toHaveBeenCalledWith('/projects/p1/poster')
    expect(api.patch).toHaveBeenCalledWith('/projects/p1', {
      name: 'Renamed', description: 'New description', is_public: true,
    })
  })

  it('cancel makes no writes and reopening restores the saved cover', () => {
    const onOpenChange = vi.fn()
    const props = { project, onOpenChange, onUpdated: vi.fn() }
    const { rerender } = render(<ProjectSettingsDialog {...props} open />)
    fireEvent.click(screen.getByRole('button', { name: 'Use automatic cover' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(api.delete).not.toHaveBeenCalled()
    expect(api.patch).not.toHaveBeenCalled()
    rerender(<ProjectSettingsDialog {...props} open={false} />)
    rerender(<ProjectSettingsDialog {...props} open />)
    expect(screen.getByAltText('Poster')).toHaveAttribute('src', project.poster_url)
    expect(screen.getByRole('button', { name: 'Use automatic cover' })).toBeInTheDocument()
  })

  it('shows a reset failure and keeps the dialog and drafts open', async () => {
    vi.mocked(api.delete).mockRejectedValueOnce(new Error('reset failed'))
    const onOpenChange = vi.fn()
    render(<ProjectSettingsDialog project={project} open onOpenChange={onOpenChange} onUpdated={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use automatic cover' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save all changes')
    expect(screen.getByPlaceholderText('Project name')).toHaveValue('Renamed')
    expect(api.patch).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})
