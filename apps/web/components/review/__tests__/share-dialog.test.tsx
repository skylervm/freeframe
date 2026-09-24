import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ShareDialog } from '../share-dialog'

vi.mock('@/hooks/use-share-links', () => ({
  useShareLinks: () => ({ shareLinks: [], isLoading: false, mutateShareLinks: vi.fn() }),
}))
vi.mock('@/lib/api', () => ({ api: { post: vi.fn(), delete: vi.fn() } }))
vi.mock('@/components/projects/share-create-dialog', () => ({
  ShareCreateDialog: () => null,
}))

describe('ShareDialog mobile dialog', () => {
  it('uses the shared modal primitive and reports close requests for the invoking menu', async () => {
    const onOpenChange = vi.fn()
    const onCloseAutoFocus = vi.fn()
    render(
      <ShareDialog
        assetId="asset-1"
        projectId="project-1"
        open
        onOpenChange={onOpenChange}
        onCloseAutoFocus={onCloseAutoFocus}
        hideTrigger
        mobileDialog
      />,
    )

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAccessibleName('Share asset')
    await waitFor(() => expect(screen.getByRole('button', { name: 'New Share Link' })).toHaveFocus())

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
