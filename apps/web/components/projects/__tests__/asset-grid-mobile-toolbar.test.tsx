import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AssetGrid } from '../asset-grid'

vi.mock('../appearance-popover', () => ({
  AppearancePopover: ({ compact = false }: { compact?: boolean }) => (
    <button data-compact={compact ? 'true' : 'false'}>Appearance</button>
  ),
}))
vi.mock('../sort-popover', () => ({
  SortPopover: ({ compact = false }: { compact?: boolean }) => (
    <button data-compact={compact ? 'true' : 'false'}>Sort</button>
  ),
}))
vi.mock('../asset-card', () => ({ AssetCard: () => null }))
vi.mock('../folder-card', () => ({ FolderCard: () => null }))
vi.mock('../move-to-dialog', () => ({ MoveToDialog: () => null }))
vi.mock('@/stores/view-store', () => ({
  useViewStore: () => ({
    layout: 'grid', cardSize: 'M', aspectRatio: 'landscape', thumbnailScale: 'fill',
    showCardInfo: true, titleLines: '2', flattenFolders: false, showFileSize: false,
    showUploader: false, sortKey: 'custom', sortDirection: 'asc',
  }),
}))

describe('AssetGrid mobile toolbar', () => {
  it('uses compact controls and keeps project actions in a keyboard menu', async () => {
    const user = userEvent.setup()
    const upload = vi.fn()
    render(
      <AssetGrid
        assets={[]}
        projectId="project-1"
        actions={<button type="button" onClick={upload}>Upload</button>}
      />,
    )

    expect(screen.getByRole('button', { name: 'More project actions' })).toHaveClass('md:hidden')
    expect(screen.getAllByText('Appearance').find((button) => button.dataset.compact === 'true')).toBeTruthy()
    expect(screen.getAllByText('Sort').find((button) => button.dataset.compact === 'true')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'More project actions' }))
    expect(await screen.findByRole('menuitem', { name: 'Upload' })).toBeVisible()
    await user.keyboard('{ArrowDown}{Enter}')
    expect(upload).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
