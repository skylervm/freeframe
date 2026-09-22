import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShareLinkContent } from '../share-link-detail'

const state = vi.hoisted(() => ({
  api: { get: vi.fn(), patch: vi.fn() },
  shareLink: {
    id: 'link-1',
    asset_id: null,
    folder_id: null,
    project_id: 'project-1',
    title: 'Episode review',
    description: null,
  },
}))

const api = state.api

vi.mock('swr', () => ({
  default: () => ({ data: state.shareLink, mutate: vi.fn() }),
}))

vi.mock('@/lib/api', () => ({ api: state.api }))
vi.mock('@/components/projects/share-link-activity', () => ({ ShareLinkActivityPanel: () => null }))

describe('ShareLinkContent', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders assets returned for a multi-share preview', async () => {
    api.get.mockResolvedValue({
      assets: [{ id: 'asset-1', name: 'Episode 1 Interview', asset_type: 'video', thumbnail_url: null }],
      subfolders: [],
    })

    render(<ShareLinkContent token="link-token" projectId="project-1" onBack={vi.fn()} frontendUrl="https://freeframe.test" />)

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/share/link-token/assets?page=1&per_page=50'))
    expect(await screen.findByText('Episode 1 Interview')).toBeInTheDocument()
    expect(screen.queryByText('No content yet')).not.toBeInTheDocument()
  })

  it('distinguishes a preview request failure from an empty share link', async () => {
    api.get.mockRejectedValue(new Error('Network error'))

    render(<ShareLinkContent token="link-token" projectId="project-1" onBack={vi.fn()} frontendUrl="https://freeframe.test" />)

    expect(await screen.findByText('Could not load shared content')).toBeInTheDocument()
    expect(screen.queryByText('No content yet')).not.toBeInTheDocument()
  })
})
