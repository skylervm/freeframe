import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
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
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:cover') })
})

describe('project poster upload', () => {
  it('shows the API error and keeps the dialog open when a poster upload fails', async () => {
    vi.mocked(api.upload).mockRejectedValueOnce(new Error('Project owner access required'))
    const onOpenChange = vi.fn()
    const { baseElement } = render(
      <ProjectSettingsDialog project={project} open onOpenChange={onOpenChange} onUpdated={vi.fn()} />,
    )
    const input = baseElement.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['jpg'], 'cover.jpg', { type: 'image/jpeg' })] } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Project owner access required')
    expect(api.patch).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})
