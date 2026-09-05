import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProjectSettingsDialog } from '../project-settings-dialog'
import { api } from '@/lib/api'
import type { Project } from '@/types'

vi.mock('@/lib/api', () => ({
  api: { patch: vi.fn(), upload: vi.fn() },
}))

const project = {
  id: 'p1', name: 'Original', description: null, is_public: false, poster_url: null,
} as Project

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:cover'),
    revokeObjectURL: vi.fn(),
  })
})

describe('project poster upload', () => {
  it('keeps a selected poster when the parent refreshes the same project', () => {
    const props = { project, open: true, onOpenChange: vi.fn(), onUpdated: vi.fn() }
    const { baseElement, rerender } = render(<ProjectSettingsDialog {...props} />)
    const input = baseElement.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['gif'], 'cover.gif', { type: 'image/gif' })] } })

    rerender(<ProjectSettingsDialog {...props} project={{ ...project }} />)

    expect(screen.getByAltText('Poster')).toHaveAttribute('src', 'blob:cover')
  })

  it('shows the API error and keeps the dialog open when a poster upload fails', async () => {
    vi.mocked(api.upload).mockRejectedValueOnce(new Error('Project owner access required'))
    const onOpenChange = vi.fn()
    const { baseElement } = render(
      <ProjectSettingsDialog project={project} open onOpenChange={onOpenChange} onUpdated={vi.fn()} />,
    )
    const input = baseElement.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['gif'], 'cover.gif', { type: 'image/gif' })] } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Project owner access required')
    expect(api.patch).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('opens the crop editor for a non-animated image before uploading', () => {
    const { baseElement } = render(
      <ProjectSettingsDialog project={project} open onOpenChange={vi.fn()} onUpdated={vi.fn()} />,
    )
    const input = baseElement.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['jpg'], 'cover.jpg', { type: 'image/jpeg' })] } })

    expect(screen.getByRole('dialog', { name: 'Crop cover' })).toBeInTheDocument()
  })

  it('stages restoring the automatic thumbnail until settings are saved', async () => {
    vi.mocked(api.patch).mockResolvedValueOnce(project)
    const onOpenChange = vi.fn()
    render(
      <ProjectSettingsDialog
        project={{ ...project, poster_url: 'https://example.com/custom.jpg' }}
        open
        onOpenChange={onOpenChange}
        onUpdated={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Use automatic thumbnail' }))
    expect(screen.getByText('The automatic thumbnail will return when you save.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(api.patch).toHaveBeenCalledWith('/projects/p1', expect.objectContaining({
        restore_automatic_poster: true,
      }))
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })
})
