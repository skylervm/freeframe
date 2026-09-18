import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FolderShareViewer } from '../folder-share-viewer'

// Records how the share screen sizes the player; the real one needs media APIs
// jsdom lacks. The share screen loads it with a dynamic import, which this
// module mock also covers.
vi.mock('@/components/review/video-player', () => ({
  VideoPlayer: ({ compact, className }: { compact?: boolean; className?: string }) => (
    <div data-testid="video-player" data-compact={String(compact)} className={className} />
  ),
}))

// Regression for #192: ShareReviewInner used to resolve its hooks with bare
// CommonJS require('@/...') calls. Node's loader does not understand the '@'
// alias from vitest.config.ts, so the subtree threw "Cannot find module" the
// moment a guest opened an asset — making the whole share-review UI untestable.
describe('folder share — opening an asset mounts the review UI (#192)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        assets: [{ id: 'a1', name: 'Clip.mp4', asset_type: 'video', latest_version_id: 'v1', thumbnail_url: null, status: 'ready' }],
        subfolders: [],
        total: 1,
      }),
    })) as unknown as typeof fetch)
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    // jsdom has no matchMedia (#188); the panel default reads it during render.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true, media: query, onchange: null,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent: () => false,
    }))
  })

  afterEach(() => { vi.unstubAllGlobals() })

  it('renders the review panel tabs after double-clicking an asset', async () => {
    render(
      <FolderShareViewer
        token="t" folderName="F" title="T" description={null}
        permission="comment" allowDownload={false} showVersions={false}
        appearance={{ open_in_viewer: true } as never} branding={null}
      />,
    )

    await waitFor(() => expect(screen.getByText('Clip.mp4')).toBeInTheDocument())
    fireEvent.doubleClick(screen.getByText('Clip.mp4'))

    // These tabs live inside ShareReviewInner, so they only appear if that
    // subtree mounted — i.e. if its hook imports resolved.
    await waitFor(() => expect(screen.getByText('Fields')).toBeInTheDocument(), { timeout: 3000 })
    expect(screen.getByText('Comments')).toBeInTheDocument()
  })
})

describe('folder share review on phones', () => {
  let mediaListeners: Array<() => void> = []
  let isDesktop = true

  beforeEach(() => {
    mediaListeners = []
    isDesktop = true
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        assets: [{ id: 'a1', name: 'Clip.mp4', asset_type: 'video', latest_version_id: 'v1', thumbnail_url: null, status: 'ready' }],
        subfolders: [],
        total: 1,
      }),
    })) as unknown as typeof fetch)
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    // Only the md query is live; every other query just reports a match.
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() { return query === '(min-width: 768px)' ? isDesktop : true },
      media: query, onchange: null,
      addEventListener: (_: string, listener: () => void) => { mediaListeners.push(listener) },
      removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent: () => false,
    }))
  })

  afterEach(() => { vi.unstubAllGlobals() })

  async function openAsset({ allowDownload = false } = {}) {
    render(
      <FolderShareViewer
        token="t" folderName="F" title="T" description={null}
        permission="comment" allowDownload={allowDownload} showVersions={false}
        appearance={{ open_in_viewer: true } as never} branding={null}
      />,
    )
    await waitFor(() => expect(screen.getByText('Clip.mp4')).toBeInTheDocument())
    fireEvent.doubleClick(screen.getByText('Clip.mp4'))
    await waitFor(() => expect(document.getElementById('review-comments')).not.toBeNull(), { timeout: 3000 })
  }

  it('uses the review page layout hooks instead of a scrolling page with a fixed video box', async () => {
    await openAsset()

    const comments = document.getElementById('review-comments') as HTMLElement
    const workspace = comments.parentElement as HTMLElement
    // The landscape two-column rule in globals.css keys on these.
    expect(workspace).toHaveClass('review-workspace', 'overflow-hidden', 'md:flex-row')
    expect(workspace).not.toHaveClass('overflow-y-auto')
    // Comments take the remaining height and scroll inside themselves. No
    // overflow-hidden: desktop share never clipped this pane, and the composer's
    // emoji picker spills out to the left of it.
    expect(comments).toHaveClass('flex-1', 'min-h-0', 'md:w-[360px]', 'md:flex-none')
    expect(comments).not.toHaveClass('overflow-hidden')
    expect(comments.className).not.toContain('min-h-[24rem]')
    // The old fixed 56svh / 16rem / 28rem box is gone from the viewer column.
    const viewer = workspace.querySelector('.review-viewer') as HTMLElement
    expect(viewer.className).not.toContain('min-h-[16rem]')
    expect(viewer).toHaveClass('md:flex-1')
    // Sized to the fixed inset-0 wrapper, never 100vh: iOS Safari's 100vh hides
    // the composer under its toolbar, including on wide phones in landscape.
    expect(workspace.parentElement).toHaveClass('h-full')
    expect(workspace.parentElement?.className).not.toMatch(/h-screen|100svh/)
  })

  it('drops the tab row and comment toolbar on phones, with the controls under a phone-only ⋯', async () => {
    await openAsset()

    expect(screen.getByText('Fields').parentElement?.parentElement).toHaveClass('hidden', 'md:block')
    const options = screen.getByRole('button', { name: 'Comment options' })
    expect(options).toHaveClass('md:hidden')
    // The panel's own toolbar hides below md because it gets compactToolbar.
    const toolbar = screen.getByTitle('Sort').closest('.shrink-0.justify-between')
    expect(toolbar).toHaveClass('hidden', 'md:flex')

    fireEvent.keyDown(options, { key: 'Enter' })
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Search comments' })).toBeInTheDocument())
    expect(screen.getByRole('menuitem', { name: 'Show: All comments' })).toBeInTheDocument()
    // A guest has no account, so export would silently fail — not offered.
    expect(screen.queryByRole('menuitem', { name: 'Download comments' })).toBeNull()
  })

  it('offers Download comments to a signed-in viewer', async () => {
    localStorage.setItem('ff_access_token', 'x')
    await openAsset()

    fireEvent.keyDown(screen.getByRole('button', { name: 'Comment options' }), { key: 'Enter' })

    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Download comments' })).toBeInTheDocument())
  })

  it('keeps the asset Download button to an icon on phones, leaving room for the name', async () => {
    await openAsset({ allowDownload: true })

    const download = screen.getByRole('button', { name: 'Download' })
    expect(download.querySelector('span')).toHaveClass('hidden', 'md:inline')
  })

  it('resets comment filters when the comments pane closes, as it did before', async () => {
    await openAsset()
    const openMenu = () => fireEvent.keyDown(screen.getByRole('button', { name: 'Comment options' }), { key: 'Enter' })

    openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Show: All comments' }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /^Public comments/ }))
    openMenu()
    expect(await screen.findByRole('menuitem', { name: 'Show: Public comments' })).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    fireEvent.click(screen.getByRole('button', { name: 'Hide comments' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show comments' }))
    openMenu()

    expect(await screen.findByRole('menuitem', { name: 'Show: All comments' })).toBeInTheDocument()
  })

  it('never leaves a phone on the Fields tab it has no way to leave', async () => {
    await openAsset()

    fireEvent.click(screen.getByText('Fields'))
    expect(screen.queryByTitle('Sort')).toBeNull()
    isDesktop = false
    act(() => mediaListeners.forEach((listener) => listener()))

    expect(screen.getByTitle('Sort')).toBeInTheDocument()
  })
})

describe('folder share review — a ready video on phones', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const body = url.includes('/stream/')
        ? { name: 'Clip.mp4', asset_type: 'video', url: '/clip.m3u8', version_id: 'v1' }
        : url.includes('/versions')
          ? [{ id: 'v1', version_number: 1, processing_status: 'ready', created_at: '' }]
          : url.includes('/comments')
            ? []
            : {
                assets: [{ id: 'a1', name: 'Clip.mp4', asset_type: 'video', latest_version_id: 'v1', thumbnail_url: null, status: 'ready' }],
                subfolders: [],
                total: 1,
              }
      return { ok: true, status: 200, json: async () => body }
    }) as unknown as typeof fetch)
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true, media: query, onchange: null,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent: () => false,
    }))
  })

  afterEach(() => { vi.unstubAllGlobals() })

  it('sizes the video to its own aspect ratio while comments are open, and fills the column when they close', async () => {
    render(
      <FolderShareViewer
        token="t" folderName="F" title="T" description={null}
        permission="comment" allowDownload={false} showVersions={false}
        appearance={{ open_in_viewer: true } as never} branding={null}
      />,
    )
    await waitFor(() => expect(screen.getByText('Clip.mp4')).toBeInTheDocument())
    fireEvent.doubleClick(screen.getByText('Clip.mp4'))

    const player = await screen.findByTestId('video-player', {}, { timeout: 3000 })
    expect(player).toHaveAttribute('data-compact', 'true')
    expect(player).toHaveClass('md:flex-1')
    // The column carries no fixed height; the player's aspect box sets it.
    expect(player.parentElement).toHaveClass('review-viewer', 'shrink-0')
    expect(player.parentElement?.className).not.toContain('56svh')

    fireEvent.click(screen.getByRole('button', { name: 'Hide comments' }))

    await waitFor(() => expect(screen.getByTestId('video-player')).toHaveAttribute('data-compact', 'false'))
    expect(screen.getByTestId('video-player')).toHaveClass('flex-1')
    expect(screen.getByTestId('video-player').parentElement).toHaveClass('min-h-0', 'flex-1')
  })
})
