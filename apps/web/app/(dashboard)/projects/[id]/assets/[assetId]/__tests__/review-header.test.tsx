import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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
        ? []
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
vi.mock('@/components/review/video-player', () => ({ VideoPlayer: () => <div /> }))
vi.mock('@/components/review/audio-player', () => ({ AudioPlayer: () => <div /> }))
vi.mock('@/components/review/image-viewer', () => ({ ImageViewer: () => <div /> }))
vi.mock('@/components/review/annotation-canvas', () => ({ AnnotationCanvas: () => <div /> }))
vi.mock('@/components/review/annotation-overlay', () => ({ AnnotationOverlay: () => <div /> }))
vi.mock('@/components/review/comment-panel', () => ({ CommentPanel: () => <div /> }))
vi.mock('@/components/review/comment-input', () => ({ CommentInput: () => <div /> }))
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

describe('ReviewScreenInner header', () => {
  it('keeps every essential review action compact below md while desktop actions stay md-only', () => {
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
})
