import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import ReviewPage from '../page'

const state = vi.hoisted(() => ({
  routerPush: vi.fn(),
  setCurrentVersion: vi.fn(),
}))

const asset = {
  id: 'asset-2',
  name: 'From Below Radio Episode 1',
  project_id: 'project-1',
  asset_type: 'video',
}

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: state.routerPush, replace: vi.fn() }),
  usePathname: () => '/projects/project-1/assets/asset-2',
  useSearchParams: () => ({ get: () => null, toString: () => '' }),
}))
vi.mock('next/link', () => ({
  default: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock('swr', () => ({
  default: (key: string) => ({
    data: key.endsWith('/assets')
      ? [{ ...asset, id: 'asset-1', name: 'Previous' }, asset, { ...asset, id: 'asset-3', name: 'Next' }]
      : key.endsWith('/members')
        ? [{ user_id: 'user-1', role: 'editor' }]
        : key.endsWith('/folder-tree')
          ? []
          : { id: 'project-1', name: 'Project' },
  }),
}))
vi.mock('@/components/review/review-provider', () => ({
  ReviewProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useReview: () => ({
    asset,
    versions: [{ id: 'version-1', version_number: 1, processing_status: 'ready' }],
    isLoading: false,
    refetchComments: vi.fn(),
    refetchVersions: vi.fn(),
  }),
}))
vi.mock('@/components/review/video-player', () => ({
  // Props are captured, not discarded: `compact` is load-bearing. Without it
  // the player falls back to `h-full` inside an auto-height parent and the
  // video area collapses to 0px in phone portrait.
  VideoPlayer: ({ compact }: { compact?: boolean }) => (
    <div data-testid="video-player" data-compact={String(compact)} />
  ),
}))
vi.mock('@/components/review/audio-player', () => ({ AudioPlayer: () => <div /> }))
vi.mock('@/components/review/image-viewer', () => ({ ImageViewer: () => <div /> }))
vi.mock('@/components/review/annotation-canvas', () => ({ AnnotationCanvas: () => <div /> }))
vi.mock('@/components/review/annotation-overlay', () => ({ AnnotationOverlay: () => <div /> }))
vi.mock('@/components/review/comment-panel', () => ({ CommentPanel: () => <div /> }))
vi.mock('@/components/review/comment-input', () => ({ CommentInput: () => <div data-testid="comment-input" /> }))
vi.mock('@/components/review/version-switcher', () => ({ VersionSwitcher: () => <span>Version switcher</span> }))
vi.mock('@/components/review/share-dialog', () => ({ ShareDialog: () => <span>Share dialog</span> }))
vi.mock('@/components/review/compare/compare-overlay', () => ({ CompareOverlay: () => <div /> }))
vi.mock('@/stores/review-store', () => ({
  useReviewStore: () => ({
    currentVersion: { id: 'version-1', version_number: 1, processing_status: 'ready' },
    isDrawingMode: false,
    focusedCommentId: null,
    seekTo: vi.fn(),
    setCurrentVersion: state.setCurrentVersion,
    setFocusedCommentId: vi.fn(),
    setActiveAnnotation: vi.fn(),
  }),
}))
vi.mock('@/stores/auth-store', () => ({ useAuthStore: () => ({ user: { id: 'user-1' } }) }))
vi.mock('@/hooks/use-comments', () => ({ useComments: () => ({ comments: [], createComment: vi.fn(), resolveComment: vi.fn(), deleteComment: vi.fn(), addReaction: vi.fn(), removeReaction: vi.fn() }) }))
vi.mock('@/hooks/use-sse', () => ({ useSSE: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }))
vi.mock('@/stores/upload-store', () => ({ useUploadStore: () => vi.fn() }))
vi.mock('@/stores/breadcrumb-store', () => ({ useBreadcrumbStore: () => vi.fn() }))
vi.mock('@/components/layout/mobile-navigation-context', () => ({ useMobileNavigation: () => ({ isOpen: false, toggle: vi.fn() }) }))
vi.mock('@/lib/compare-time', () => ({ canCompare: () => true }))
vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: vi.fn() }))

describe('ReviewScreenInner mobile layout', () => {
  it('keeps essential review actions compact below md while desktop actions stay md-only', () => {
    render(<ReviewPage params={{ id: 'project-1', assetId: asset.id }} />)

    expect(screen.getByText(asset.name)).toHaveClass('min-w-0', 'flex-1', 'truncate')
    expect(screen.getByRole('button', { name: 'Open navigation' })).toHaveClass('md:hidden')
    expect(screen.getByRole('button', { name: 'Previous asset' }).parentElement).toHaveClass('md:hidden')
    expect(screen.getByRole('button', { name: 'Next asset' }).parentElement).toHaveClass('md:hidden')
    expect(screen.getByRole('button', { name: 'More review actions' })).toHaveClass('md:hidden')
    expect(screen.getByRole('button', { name: 'Hide comments' })).toHaveClass('md:hidden')
    expect(screen.getByRole('button', { name: 'Compare' })).toHaveClass('hidden', 'md:inline-flex')
    expect(screen.getByRole('button', { name: 'New Version' })).toHaveClass('hidden', 'md:inline-flex')
    expect(screen.getByText('Version switcher').parentElement).toHaveClass('hidden', 'md:block')
  })

  it('stacks a naturally sized phone-portrait video over a bounded comments pane with a persistent input', () => {
    render(<ReviewPage params={{ id: 'project-1', assetId: asset.id }} />)

    const viewer = screen.getByTestId('video-player').parentElement
    const comments = document.getElementById('review-comments')
    const reviewSurface = screen.getByText(asset.name).closest('.absolute')
    expect(reviewSurface).toHaveClass('h-[100svh]', 'md:h-auto')
    // Video sizes itself to its own intrinsic aspect box, so the column must not
    // carry a viewport-height box that would letterbox it in portrait.
    expect(screen.getByTestId('video-player')).toHaveAttribute('data-compact', 'true')
    expect(viewer).toHaveClass('review-viewer', 'shrink-0')
    expect(viewer?.className).not.toContain('56svh')
    expect(viewer?.parentElement).toHaveClass('review-workspace', 'flex-col', 'md:flex-row')
    expect(comments).toHaveClass('min-h-0', 'flex-1', 'overflow-hidden')
    expect(comments?.parentElement).toHaveClass('overflow-hidden')
    expect(screen.getByTestId('comment-input')).toBeInTheDocument()
  })

  it('lets the video fill the column again once the comments pane is closed', async () => {
    const user = userEvent.setup()
    render(<ReviewPage params={{ id: 'project-1', assetId: asset.id }} />)

    await user.click(screen.getByRole('button', { name: 'Hide comments' }))

    // With no comments pane to share the screen with there is nothing to be
    // compact for, so the player goes back to filling the column.
    expect(screen.getByTestId('video-player')).toHaveAttribute('data-compact', 'false')
    expect(screen.getByTestId('video-player').parentElement).toHaveClass('flex-1', 'min-h-0')
    expect(document.getElementById('review-comments')).toBeNull()
  })

  it('turns the review surface into two columns in phone landscape', () => {
    // jsdom cannot evaluate media queries, so pin the CSS contract the layout
    // depends on: the orientation rule, scoped to the review-only hooks.
    const css = readFileSync(
      path.resolve(__dirname, '../../../../../../globals.css'),
      'utf8',
    )
    const start = css.indexOf('@media (max-width: 767px) and (orientation: landscape)')
    // `slice(-1)` on a miss returns the last character, so guard on the index
    // itself rather than on the length of what came back.
    expect(start).toBeGreaterThan(-1)
    const block = css.slice(start)

    // Assert the declarations, not just the selectors: emptying every rule body
    // would leave the selectors in place and the layout stacked.
    expect(block).toContain('.review-workspace {')
    expect(block).toMatch(/\.review-workspace \{[^}]*flex-direction:\s*row/)
    expect(block).toMatch(/\.review-viewer \{[^}]*flex:\s*1 1 0%/)
    expect(block).toMatch(/\.review-viewer \{[^}]*height:\s*auto/)
    expect(block).toMatch(/\.review-player \{[^}]*flex:\s*1 1 0%/)
    expect(block).toMatch(/\.review-video-area \{[^}]*aspect-ratio:\s*auto/)
    expect(block).toMatch(/#review-comments \{[^}]*width:\s*min\(45%, 20rem\)/)
    expect(block).toMatch(/#review-comments \{[^}]*border-left-width:\s*1px/)
  })
})
