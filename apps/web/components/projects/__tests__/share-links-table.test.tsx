import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ShareLinksTable } from '../share-links-table'
import type { ShareLinkListItem } from '@/types'

const inheritedLink: ShareLinkListItem = {
  id: 'link-1',
  token: null,
  title: 'Client review',
  description: null,
  is_enabled: true,
  permission: 'view',
  share_type: 'folder',
  target_name: 'Client review',
  view_count: 3,
  last_viewed_at: null,
}

describe('ShareLinksTable', () => {
  it('renders inherited share-link metadata without a broken link or management controls', () => {
    render(
      <ShareLinksTable
        shareLinks={[inheritedLink]}
        onSelectLink={vi.fn()}
        onToggleEnabled={vi.fn()}
        onViewActivity={vi.fn()}
        frontendUrl="https://freeframe.test"
      />,
    )

    expect(screen.getByText('Client review')).toBeInTheDocument()
    expect(screen.getByText('Link details available')).toBeInTheDocument()
    expect(screen.getAllByText('Read only')).toHaveLength(1)
    expect(screen.queryByTitle('Copy link')).not.toBeInTheDocument()
    expect(screen.queryByText('View Activity')).not.toBeInTheDocument()
    expect(screen.queryByText('/share/null')).not.toBeInTheDocument()
  })
})
