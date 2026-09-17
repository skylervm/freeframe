'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import { ReviewProvider, useReview } from '@/components/review/review-provider'
import { VideoPlayer } from '@/components/review/video-player'
import { AudioPlayer } from '@/components/review/audio-player'
import { ImageViewer } from '@/components/review/image-viewer'
import { AnnotationCanvas } from '@/components/review/annotation-canvas'
import { AnnotationOverlay } from '@/components/review/annotation-overlay'
import { CommentPanel } from '@/components/review/comment-panel'
import { CommentInput } from '@/components/review/comment-input'
// ApprovalBar removed for now
import { VersionSwitcher } from '@/components/review/version-switcher'
import { ShareDialog } from '@/components/review/share-dialog'
import { CompareOverlay } from '@/components/review/compare/compare-overlay'
import { useReviewStore } from '@/stores/review-store'
import { useAuthStore } from '@/stores/auth-store'
import { useComments } from '@/hooks/use-comments'
import { useSSE } from '@/hooks/use-sse'
import { api } from '@/lib/api'
import { useUploadStore } from '@/stores/upload-store'
import { useBreadcrumbStore } from '@/stores/breadcrumb-store'
import { useMobileNavigation } from '@/components/layout/mobile-navigation-context'
import { canCompare } from '@/lib/compare-time'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Info,
  Loader2,
  Columns2,
  Upload,
  GitCompareArrows,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Share2,
} from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { usePageTitle } from '@/hooks/use-page-title'
import type { Project, AssetResponse, ProjectMember, FolderTreeNode } from '@/types'

const acceptByType: Record<string, string> = {
  video: 'video/*',
  audio: 'audio/*',
  image: 'image/*',
  image_carousel: 'image/*',
}

function ReviewScreenInner({ projectId }: { projectId: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { asset, versions, isLoading, refetchComments, refetchVersions } = useReview()
  const { currentVersion, isDrawingMode, focusedCommentId, seekTo, setCurrentVersion, setFocusedCommentId, setActiveAnnotation } = useReviewStore()
  const { user } = useAuthStore()
  const startVersionUpload = useUploadStore((s) => s.startVersionUpload)
  const versionFileInputRef = useRef<HTMLInputElement>(null)
  const mobileMoreActionsRef = useRef<HTMLButtonElement>(null)
  const setExtraCrumbs = useBreadcrumbStore((s) => s.setExtraCrumbs)
  const setLabel = useBreadcrumbStore((s) => s.setLabel)
  const { isOpen: mobileNavigationOpen, toggle: toggleMobileNavigation } = useMobileNavigation()
  usePageTitle(asset?.name ?? null)
  const [annotationData, setAnnotationData] = useState<Record<string, unknown> | null>(null)
  const [activeTab, setActiveTab] = useState<'comments' | 'fields'>('comments')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [mobileShareOpen, setMobileShareOpen] = useState(false)
  const deepLinkApplied = useRef(false)

  // Fetch folder tree to build the folder path for the breadcrumb
  const { data: folderTree } = useSWR<FolderTreeNode[]>(
    asset ? `/projects/${projectId}/folder-tree` : null,
    () => api.get<FolderTreeNode[]>(`/projects/${projectId}/folder-tree`),
  )

  // Set extra crumbs = [folder path..., asset name]
  // Don't register asset UUID as a label — use extraCrumbs for correct ordering
  useEffect(() => {
    if (!asset?.name) return

    function findPath(
      nodes: FolderTreeNode[],
      targetId: string,
      trail: { id: string; name: string }[],
    ): { id: string; name: string }[] | null {
      for (const node of nodes) {
        const next = [...trail, { id: node.id, name: node.name }]
        if (node.id === targetId) return next
        const found = findPath(node.children, targetId, next)
        if (found) return found
      }
      return null
    }

    const folderPath = asset.folder_id && folderTree
      ? (findPath(folderTree, asset.folder_id, []) ?? [])
      : []

    setExtraCrumbs([
      ...folderPath.map((f) => ({ label: f.name, href: `/projects/${projectId}?folder=${f.id}` })),
      { label: asset.name }, // asset name — no href (current page)
    ])
  }, [asset?.id, asset?.name, asset?.folder_id, folderTree, setExtraCrumbs])

  // Fetch project info for breadcrumb + register project name as label
  const { data: project } = useSWR<Project>(
    `/projects/${projectId}`,
    () => api.get<Project>(`/projects/${projectId}`),
  )
  useEffect(() => {
    if (project?.name) setLabel(projectId, project.name)
  }, [project?.name, projectId, setLabel])

  // Role-based permissions
  const { data: members } = useSWR<ProjectMember[]>(
    `/projects/${projectId}/members`,
    () => api.get<ProjectMember[]>(`/projects/${projectId}/members`),
  )
  const currentMember = members?.find((m) => m.user_id === user?.id)
  const currentRole = currentMember?.role ?? 'viewer'
  const canComment = currentRole !== 'viewer'

  // Fetch all assets for navigation (1 of N)
  const { data: allAssets } = useSWR<AssetResponse[]>(
    `/projects/${projectId}/assets`,
    () => api.get<AssetResponse[]>(`/projects/${projectId}/assets`),
  )

  const {
    comments,
    createComment,
    resolveComment,
    deleteComment,
    addReaction,
    removeReaction,
  } = useComments(asset?.id || '', currentVersion?.id || '')

  // Keep the version list live: when a new version transcodes, revalidate so it
  // appears/updates in the switcher without a hard refresh (#118). The review
  // provider's versions are plain state, not SWR, so nothing else refetches them.
  const refetchIfThisAsset = (eventAssetId: string) => {
    if (eventAssetId === asset?.id) refetchVersions()
  }
  useSSE(asset?.project_id, {
    onTranscodeProgress: (d) => refetchIfThisAsset(d.asset_id),
    onTranscodeComplete: (d) => refetchIfThisAsset(d.asset_id),
    onTranscodeFailed: (d) => refetchIfThisAsset(d.asset_id),
  })

  // Deep-link to a specific comment from notification (?commentId=...)
  // Runs once after comments are loaded — seeks to timecode, focuses comment, shows annotation
  useEffect(() => {
    const commentId = searchParams.get('commentId')
    if (!commentId || deepLinkApplied.current || comments.length === 0) return
    const target = comments.find((c: any) => c.id === commentId)
    if (!target) return
    deepLinkApplied.current = true
    setFocusedCommentId(commentId)
    setActiveTab('comments')
    if ((target as any).timecode_start !== null && (target as any).timecode_start !== undefined) {
      seekTo((target as any).timecode_start, true)
    }
    if ((target as any).annotation?.drawing_data) {
      setActiveAnnotation((target as any).annotation.drawing_data)
    }
  }, [comments, searchParams, seekTo, setFocusedCommentId, setActiveAnnotation])

  // Version-compare overlay: driven entirely by the ?compare= URL param so it
  // survives refresh/deep-link. closeCompare strips all four compare params.
  const compareOpen = Boolean(searchParams.get('compare'))
  const closeCompare = useCallback(() => {
    const p = new URLSearchParams(searchParams.toString())
    p.delete('compare'); p.delete('mode'); p.delete('offA'); p.delete('offB')
    router.replace(`${pathname}?${p.toString()}`, { scroll: false })
  }, [router, pathname, searchParams])

  // Asset navigation
  const currentIndex = allAssets?.findIndex((a) => a.id === asset?.id) ?? -1
  const totalAssets = allAssets?.length ?? 0
  const prevAsset = currentIndex > 0 ? allAssets?.[currentIndex - 1] : null
  const nextAsset = currentIndex < totalAssets - 1 ? allAssets?.[currentIndex + 1] : null

  const navigateAsset = (assetId: string) => {
    router.push(`/projects/${projectId}/assets/${assetId}`)
  }

  const openCompare = () => {
    const readyVersions = versions
      .filter((v) => v.processing_status === 'ready')
      .sort((a, b) => a.version_number - b.version_number)
    const cur = currentVersion ?? readyVersions[readyVersions.length - 1]
    const prev = [...readyVersions].reverse().find((v) => v.version_number < cur.version_number)
      ?? readyVersions.find((v) => v.id !== cur.id)
    if (!prev) return
    const p = new URLSearchParams(searchParams.toString())
    p.set('compare', prev.id)
    router.replace(`${pathname}?${p.toString()}`, { scroll: false })
  }

  const openVersionUpload = () => versionFileInputRef.current?.click()

  const sortedVersions = [...versions].sort((a, b) => a.version_number - b.version_number)

  // Keyboard navigation for prev/next asset
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (searchParams.get('compare')) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      // Video/audio players handle arrow keys for frame-stepping — don't navigate away
      const playerOwnsArrows = asset && (asset.asset_type === 'video' || asset.asset_type === 'audio')
      if (e.key === 'ArrowLeft' && prevAsset && !playerOwnsArrows) {
        e.preventDefault()
        navigateAsset(prevAsset.id)
      }
      if (e.key === 'ArrowRight' && nextAsset && !playerOwnsArrows) {
        e.preventDefault()
        navigateAsset(nextAsset.id)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [asset, prevAsset, nextAsset, searchParams])

  if (isLoading || !asset) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <span className="text-xs text-text-tertiary">Loading asset...</span>
        </div>
      </div>
    )
  }

  const handleSubmitComment = async (
    body: string,
    timecodeStart?: number,
    timecodeEnd?: number,
    annotation?: Record<string, unknown>,
    parentId?: string,
    visibility?: string,
    mentionUserIds?: string[],
  ) => {
    await createComment(
      body,
      timecodeStart,
      timecodeEnd,
      annotation || annotationData || undefined,
      parentId,
      visibility,
      mentionUserIds,
    )
    setAnnotationData(null)
    refetchComments()
  }

  const handleSubmitReply = async (parentId: string, body: string) => {
    await createComment(body, undefined, undefined, undefined, parentId)
    refetchComments()
  }

  const versionReady = currentVersion?.processing_status === 'ready'
  const versionProcessing =
    currentVersion?.processing_status === 'processing' ||
    currentVersion?.processing_status === 'queued' ||
    currentVersion?.processing_status === 'uploading'

  const renderMediaViewer = () => {
    if (!currentVersion || !versionReady) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-4 text-center px-6">
            {versionProcessing ? (
              <>
                <div className="h-12 w-12 rounded-full bg-accent/10 flex items-center justify-center">
                  <Loader2 className="h-6 w-6 animate-spin text-accent" />
                </div>
                <div>
                  <p className="text-sm font-medium text-text-primary">Processing asset</p>
                  <p className="text-xs text-text-tertiary mt-1">
                    This may take a few minutes depending on file size.
                  </p>
                </div>
              </>
            ) : currentVersion?.processing_status === 'failed' ? (
              <>
                <div className="h-12 w-12 rounded-full bg-status-error/10 flex items-center justify-center">
                  <Info className="h-6 w-6 text-status-error" />
                </div>
                <div>
                  <p className="text-sm font-medium text-text-primary">Processing failed</p>
                  <p className="text-xs text-text-tertiary mt-1">
                    Try uploading a new version of this asset.
                  </p>
                </div>
              </>
            ) : (
              <>
                <div className="h-12 w-12 rounded-full bg-bg-tertiary flex items-center justify-center">
                  <Info className="h-6 w-6 text-text-tertiary" />
                </div>
                <div>
                  <p className="text-sm font-medium text-text-primary">Version not ready</p>
                  <p className="text-xs text-text-tertiary mt-1">
                    This version is still being prepared.
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      )
    }

    switch (asset.asset_type) {
      case 'video':
        return (
          <VideoPlayer
            assetId={asset.id}
            comments={comments}
            compact={sidebarOpen}
            className={sidebarOpen ? 'md:flex-1 md:min-h-0' : 'flex-1 min-h-0'}
            overlay={
              <>
                <AnnotationOverlay key={focusedCommentId ?? 'none'} />
                {isDrawingMode && (
                  <AnnotationCanvas
                    onSave={(data) => setAnnotationData(data)}
                  />
                )}
              </>
            }
          />
        )
      case 'audio':
        return (
          <AudioPlayer
            asset={asset}
            version={currentVersion}
            comments={comments}
            className="flex-1"
          />
        )
      case 'image':
      case 'image_carousel':
        return (
          <div className="relative flex-1 flex items-center justify-center p-4 overflow-hidden">
            <ImageViewer
              asset={asset}
              version={currentVersion as any}
              annotationCanvas={
                <>
                  <AnnotationOverlay key={focusedCommentId ?? 'none'} />
                  {isDrawingMode && (
                    <AnnotationCanvas
                      onSave={(data) => setAnnotationData(data)}
                    />
                  )}
                </>
              }
            />
          </div>
        )
      default:
        return null
    }
  }

  return (
    <div className="absolute inset-x-0 top-0 flex h-[100svh] flex-col overflow-hidden md:inset-0 md:h-auto">
      {/* ─── Top bar (Frame.io style) ──────────────────────────────────── */}
      <div className="flex h-12 min-w-0 items-center justify-between border-b border-border bg-bg-secondary px-3 shrink-0">
        {/* Left: back + breadcrumb */}
        <div className="flex items-center gap-1 min-w-0 flex-1">
          <button
            type="button"
            onClick={(event) => toggleMobileNavigation(event.currentTarget)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary md:hidden"
            aria-label={mobileNavigationOpen ? 'Close navigation' : 'Open navigation'}
            aria-controls="dashboard-navigation"
            aria-expanded={mobileNavigationOpen}
          >
            <Menu className="h-4 w-4" />
          </button>
          <Link
            href={`/projects/${asset.project_id}`}
            className="flex items-center justify-center h-7 w-7 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>

          {/* Asset name only */}
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary">
            {asset.name}
          </span>
        </div>

        {/* Compact asset navigation keeps review traversal available on phones. */}
        {totalAssets > 1 && (
          <div className="flex shrink-0 items-center gap-0.5 md:hidden">
            <button
              onClick={() => prevAsset && navigateAsset(prevAsset.id)}
              disabled={!prevAsset}
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
              aria-label="Previous asset"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => nextAsset && navigateAsset(nextAsset.id)}
              disabled={!nextAsset}
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
              aria-label="Next asset"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Center: asset navigation */}
        {totalAssets > 1 && (
          <div className="hidden shrink-0 items-center gap-1 md:flex">
            <button
              onClick={() => prevAsset && navigateAsset(prevAsset.id)}
              disabled={!prevAsset}
              className="flex items-center justify-center h-7 w-7 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="Previous asset (←)"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-xs text-text-secondary tabular-nums px-1">
              {currentIndex + 1} of {totalAssets}
            </span>
            <button
              onClick={() => nextAsset && navigateAsset(nextAsset.id)}
              disabled={!nextAsset}
              className="flex items-center justify-center h-7 w-7 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="Next asset (→)"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Right: version, share, sidebar toggle */}
        <div className="flex shrink-0 items-center gap-1 md:flex-1 md:justify-end md:gap-2">
          {/* Hidden file input for new version upload */}
          <input
            ref={versionFileInputRef}
            type="file"
            className="hidden"
            accept={acceptByType[asset.asset_type] ?? '*/*'}
            onChange={async (e) => {
              const file = e.target.files?.[0]
              if (!file || !asset) return
              startVersionUpload(file, asset.id, asset.name, asset.project_id)
              e.target.value = ''
              // Surface the newly-created version (starts as "uploading") quickly;
              // SSE transcode events then drive it through processing → ready (#118).
              setTimeout(() => refetchVersions(), 800)
              setTimeout(() => refetchVersions(), 2500)
            }}
          />
          <div className="hidden md:block">
            <VersionSwitcher versions={versions} />
          </div>
          {asset && canCompare(asset.asset_type, versions) && (
            <button
              onClick={openCompare}
              className="hidden h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary md:inline-flex"
              title="Compare versions"
            >
              <GitCompareArrows className="h-3.5 w-3.5" />
              Compare
            </button>
          )}
          <button
            onClick={openVersionUpload}
            className="hidden h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary md:inline-flex"
            title="Upload new version"
          >
            <Upload className="h-3.5 w-3.5" />
            New Version
          </button>
          <div className="hidden md:block">
            <ShareDialog assetId={asset.id} assetName={asset.name} projectId={projectId} asset={asset} />
          </div>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                ref={mobileMoreActionsRef}
                type="button"
                className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary md:hidden"
                aria-label="More review actions"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={6}
                className="z-[100] min-w-[180px] rounded-xl border border-border bg-bg-elevated p-1 shadow-xl md:hidden"
              >
                {totalAssets > 1 && (
                  <>
                    <DropdownMenu.Item
                      disabled={!prevAsset}
                      onSelect={() => prevAsset && navigateAsset(prevAsset.id)}
                      className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-text-secondary outline-none transition-colors hover:bg-bg-hover hover:text-text-primary data-[highlighted]:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Previous asset
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      disabled={!nextAsset}
                      onSelect={() => nextAsset && navigateAsset(nextAsset.id)}
                      className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-text-secondary outline-none transition-colors hover:bg-bg-hover hover:text-text-primary data-[highlighted]:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <ChevronRight className="h-4 w-4" />
                      Next asset
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator className="my-1 h-px bg-border" />
                  </>
                )}
                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger className="flex w-full cursor-pointer items-center justify-between rounded-lg px-2.5 py-2 text-sm text-text-secondary outline-none transition-colors hover:bg-bg-hover hover:text-text-primary data-[highlighted]:bg-bg-hover">
                    Version v{currentVersion?.version_number ?? sortedVersions.at(-1)?.version_number ?? 1}
                    <ChevronRight className="h-4 w-4" />
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.SubContent className="z-[101] min-w-[140px] rounded-xl border border-border bg-bg-elevated p-1 shadow-xl">
                      {sortedVersions.map((version) => {
                        const unavailable = version.processing_status !== 'ready'
                        return (
                          <DropdownMenu.Item
                            key={version.id}
                            disabled={unavailable}
                            onSelect={() => setCurrentVersion(version)}
                            className={cn(
                              'flex cursor-pointer items-center justify-between rounded-lg px-2.5 py-2 text-sm outline-none transition-colors',
                              currentVersion?.id === version.id
                                ? 'bg-accent/10 text-accent'
                                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary data-[highlighted]:bg-bg-hover',
                              unavailable && 'cursor-not-allowed opacity-50',
                            )}
                          >
                            <span>v{version.version_number}</span>
                            <span className="text-xs capitalize text-text-tertiary">{version.processing_status}</span>
                          </DropdownMenu.Item>
                        )
                      })}
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>
                {asset && canCompare(asset.asset_type, versions) && (
                  <DropdownMenu.Item
                    onSelect={openCompare}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-text-secondary outline-none transition-colors hover:bg-bg-hover hover:text-text-primary data-[highlighted]:bg-bg-hover"
                  >
                    <GitCompareArrows className="h-4 w-4" />
                    Compare versions
                  </DropdownMenu.Item>
                )}
                <DropdownMenu.Item
                  onSelect={openVersionUpload}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-text-secondary outline-none transition-colors hover:bg-bg-hover hover:text-text-primary data-[highlighted]:bg-bg-hover"
                >
                  <Upload className="h-4 w-4" />
                  New version
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={() => setMobileShareOpen(true)}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-text-secondary outline-none transition-colors hover:bg-bg-hover hover:text-text-primary data-[highlighted]:bg-bg-hover"
                >
                  <Share2 className="h-4 w-4" />
                  Share
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <ShareDialog
            assetId={asset.id}
            assetName={asset.name}
            projectId={projectId}
            asset={asset}
            open={mobileShareOpen}
            onOpenChange={setMobileShareOpen}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              mobileMoreActionsRef.current?.focus()
            }}
            hideTrigger
            mobileDialog
          />
          <button
            onClick={() => setSidebarOpen((p) => !p)}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-md transition-colors md:hidden',
              sidebarOpen
                ? 'bg-bg-hover text-text-primary'
                : 'text-text-tertiary hover:text-text-primary hover:bg-bg-hover',
            )}
            aria-label={sidebarOpen ? 'Hide comments' : 'Show comments'}
            aria-controls={sidebarOpen ? 'review-comments' : undefined}
            aria-expanded={sidebarOpen}
          >
            <MessageSquare className="h-4 w-4" />
          </button>
          <button
            onClick={() => setSidebarOpen((p) => !p)}
            className={cn(
              'hidden h-8 w-8 items-center justify-center rounded-md transition-colors md:flex',
              sidebarOpen
                ? 'bg-bg-hover text-text-primary'
                : 'text-text-tertiary hover:text-text-primary hover:bg-bg-hover',
            )}
            title="Toggle sidebar"
          >
            <Columns2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* ─── Main content: viewer + sidebar ────────────────────────────── */}
      {/* `review-workspace` / `review-viewer` are the hooks the phone-landscape
          orientation rule in globals.css targets to turn this stack into two
          columns. Width alone cannot decide it — a phone in landscape is
          physically wide but still needs the compact review surface. */}
      {compareOpen && asset && currentVersion && canCompare(asset.asset_type, versions) ? (
        <CompareOverlay asset={asset} versions={versions} rightVersion={currentVersion} onClose={closeCompare} canComment={canComment} />
      ) : (
      <div className="review-workspace flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
        {/* Left: viewer column */}
        <div
          className={cn(
            'review-viewer flex min-w-0 flex-col overflow-hidden bg-bg-primary',
            !sidebarOpen
              ? 'min-h-0 flex-1'
              : asset.asset_type === 'video'
                // Video sizes itself to a natural 16:9 box in portrait.
                ? 'shrink-0'
                // Image/audio viewers fill their column, so they still need a
                // bounded height to share the screen with the comments pane.
                : 'h-[min(56svh,28rem,calc(100svh-15rem))] shrink-0',
            'md:h-auto md:max-h-none md:flex-1',
          )}
        >
          {/* Media viewer */}
          {renderMediaViewer()}
        </div>

        {/* Right: comments sidebar */}
        {sidebarOpen && (
          <div id="review-comments" className="flex min-h-0 w-full flex-1 flex-col overflow-hidden border-t border-border bg-bg-secondary md:w-[360px] md:flex-none md:border-l md:border-t-0 animate-in slide-in-from-right-2 duration-150">
            {/* Tabs (Frame.io pill style) */}
            <div className="px-4 pt-3 pb-2 shrink-0">
              <div className="flex items-center bg-bg-tertiary rounded-lg p-0.5">
                <button
                  onClick={() => setActiveTab('comments')}
                  className={cn(
                    'flex-1 py-1.5 text-[13px] font-medium rounded-md transition-all',
                    activeTab === 'comments'
                      ? 'bg-bg-hover text-text-primary shadow-sm'
                      : 'text-text-tertiary hover:text-text-secondary',
                  )}
                >
                  Comments
                </button>
                <button
                  onClick={() => setActiveTab('fields')}
                  className={cn(
                    'flex-1 py-1.5 text-[13px] font-medium rounded-md transition-all',
                    activeTab === 'fields'
                      ? 'bg-bg-hover text-text-primary shadow-sm'
                      : 'text-text-tertiary hover:text-text-secondary',
                  )}
                >
                  Fields
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
              {activeTab === 'comments' ? (
                <>
                  <CommentPanel
                    comments={comments as any}
                    currentUserId={user?.id}
                    onResolve={resolveComment}
                    onDelete={deleteComment}
                    onAddReaction={addReaction}
                    onRemoveReaction={removeReaction}
                    onReply={() => {}}
                    onSubmitReply={handleSubmitReply}
                  />
                  {canComment && (
                    <CommentInput
                      assetId={asset.id}
                      projectId={asset.project_id}
                      assetType={asset.asset_type}
                      onSubmit={handleSubmitComment}
                      annotationData={annotationData}
                    />
                  )}
                </>
              ) : (
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-text-tertiary">Name</span>
                      <span className="text-xs text-text-primary font-medium truncate ml-4">{asset.name}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-text-tertiary">Type</span>
                      <span className="text-xs text-text-primary capitalize">{asset.asset_type.replace('_', ' ')}</span>
                    </div>
                    {currentVersion && (
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-text-tertiary">Version</span>
                        <span className="text-xs text-text-primary">v{currentVersion.version_number}</span>
                      </div>
                    )}
                    {currentVersion && (
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-text-tertiary">Processing</span>
                        <span className={cn(
                          'text-xs capitalize',
                          currentVersion.processing_status === 'ready' && 'text-status-success',
                          currentVersion.processing_status === 'processing' && 'text-status-warning',
                          currentVersion.processing_status === 'queued' && 'text-status-warning',
                          currentVersion.processing_status === 'failed' && 'text-status-error',
                          currentVersion.processing_status === 'uploading' && 'text-text-tertiary',
                        )}>
                          {currentVersion.processing_status}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  )
}

export default function ReviewPage({
  params,
}: {
  params: { id: string; assetId: string }
}) {
  const { id: projectId, assetId } = params

  return (
    <ReviewProvider assetId={assetId}>
      <ReviewScreenInner projectId={projectId} />
    </ReviewProvider>
  )
}
