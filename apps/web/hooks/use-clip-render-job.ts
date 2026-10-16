'use client'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { api } from '@/lib/api'
import { clipRenderError, clipRenderJobs, type LatestClipRenderJob } from '@/lib/clip-render-jobs'
import type { ProjectRole } from '@/types'
import type { CommentWithReplies } from './use-comments'

export const CLIP_RENDER_POLL_INTERVAL = 10_000

export function useClipRenderJob(
  assetId: string | null,
  versionId: string | null,
  assetType: string | undefined,
  role: ProjectRole,
  comments: CommentWithReplies[],
) {
  const eligible = assetType === 'video' && (role === 'owner' || role === 'editor')
  const key = eligible && assetId && versionId ? clipRenderJobs.latestPath(assetId, versionId) : null
  const { data, mutate } = useSWR<LatestClipRenderJob>(
    key,
    (path: string) => api.get<LatestClipRenderJob>(path),
    {
      revalidateOnFocus: false,
      refreshInterval: (latest) => latest?.job?.status === 'queued' || latest?.job?.status === 'claimed'
        ? CLIP_RENDER_POLL_INTERVAL : 0,
    },
  )
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const rangeRevision = JSON.stringify(comments.map((comment) => [
    comment.id, comment.parent_id, comment.body, comment.timecode_start, comment.timecode_end, comment.locked_at, comment.resolved,
  ]))

  useEffect(() => {
    setFailure(null)
  }, [key])

  // Locking, unlocking, resolving or editing a comment revalidates the same comment list.
  useEffect(() => {
    if (key) void mutate().catch(() => {})
  }, [rangeRevision, key, mutate])

  async function update(action: () => Promise<unknown>) {
    if (!key || pendingKey === key) return
    setPendingKey(key)
    setFailure(null)
    try {
      await action()
      await mutate()
    } catch (error) {
      setFailure({ key, message: clipRenderError(error) })
      // A different browser or runner may have changed the job meanwhile.
      void mutate().catch(() => {})
    } finally {
      setPendingKey((current) => current === key ? null : current)
    }
  }

  return {
    eligible,
    data,
    busy: key !== null && pendingKey === key,
    error: failure?.key === key ? failure.message : null,
    generate: () => update(() => clipRenderJobs.create(assetId!, versionId!)),
    cancel: () => data?.job ? update(() => clipRenderJobs.cancel(data.job!.id)) : Promise.resolve(),
  }
}

export type ClipRenderState = ReturnType<typeof useClipRenderJob>
