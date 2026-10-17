import { api, ApiError } from './api'

export interface ClipRenderJob {
  id: string
  asset_id: string
  version_id: string
  status: 'queued' | 'claimed' | 'done' | 'failed' | 'cancelled'
  clips_rendered: number | null
  message: string | null
}

export interface LatestClipRenderJob {
  job: ClipRenderJob | null
  locked_count: number
  range_count: number
  worker_last_seen_at: string | null
}

export const clipRenderJobs = {
  latestPath: (assetId: string, versionId: string) =>
    `/assets/${assetId}/clip-render-jobs/latest?version_id=${versionId}`,
  create: (assetId: string, versionId: string) =>
    api.post<ClipRenderJob>(`/assets/${assetId}/clip-render-jobs`, { version_id: versionId }),
  cancel: (jobId: string) => api.post<ClipRenderJob>(`/clip-render-jobs/${jobId}/cancel`),
}

export function clipRenderError(error: unknown): string {
  if (error instanceof ApiError) {
    try {
      const detail = JSON.parse(error.detail)
      if (typeof detail.message === 'string') return detail.message
    } catch {}
    return error.detail
  }
  return "Couldn't update the clip render job."
}
