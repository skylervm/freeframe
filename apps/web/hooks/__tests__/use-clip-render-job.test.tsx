import * as React from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import type { LatestClipRenderJob } from '@/lib/clip-render-jobs'
import type { ProjectRole } from '@/types'
import type { CommentWithReplies } from '../use-comments'
import { CLIP_RENDER_POLL_INTERVAL, useClipRenderJob } from '../use-clip-render-job'

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/api')>(),
  api: mocks,
}))

const comments = [{ id: 'comment', parent_id: null, body: 'Clip 1', timecode_start: 1, timecode_end: 2, locked_at: null, resolved: false }] as CommentWithReplies[]
let latest: LatestClipRenderJob

function wrapper({ children }: { children: React.ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, errorRetryCount: 0 }}>{children}</SWRConfig>
}

function hook(role: ProjectRole = 'owner', assetType = 'video') {
  return renderHook(() => useClipRenderJob('asset', 'version', assetType, role, comments), { wrapper })
}

beforeEach(() => {
  vi.resetAllMocks()
  latest = { job: null, locked_count: 1, range_count: 1, worker_last_seen_at: null }
  mocks.get.mockImplementation(async () => latest)
  mocks.post.mockResolvedValue({})
})
afterEach(() => vi.useRealTimers())

describe('clip render job requests', () => {
  it.each(['owner', 'editor'] as const)('loads counts for an %s and queues this version', async (role) => {
    const { result } = hook(role)
    await waitFor(() => expect(result.current.data?.locked_count).toBe(1))
    expect(mocks.get).toHaveBeenCalledWith('/assets/asset/clip-render-jobs/latest?version_id=version')
    await act(() => result.current.generate())
    expect(mocks.post).toHaveBeenCalledWith('/assets/asset/clip-render-jobs', { version_id: 'version' })
  })

  it.each(['viewer', 'reviewer'] as const)('does not load or render controls for a %s', async (role) => {
    const { result } = hook(role)
    expect(result.current.eligible).toBe(false)
    expect(result.current.data).toBeUndefined()
    await act(() => result.current.generate())
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('does not load jobs for other media', () => {
    const { result } = hook('owner', 'audio')
    expect(result.current.eligible).toBe(false)
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it('cancels the latest job', async () => {
    latest = { ...latest, job: { id: 'job', asset_id: 'asset', version_id: 'version', ranges: [], status: 'queued', clips_rendered: null, message: null } }
    const { result } = hook()
    await waitFor(() => expect(result.current.data?.job?.id).toBe('job'))
    await act(() => result.current.cancel())
    expect(mocks.post).toHaveBeenCalledWith('/clip-render-jobs/job/cancel')
  })

  it('shows a structured conflict message and refreshes the current state', async () => {
    mocks.post.mockRejectedValue(new ApiError(409, JSON.stringify({ code: 'already_rendered', message: 'These ranges are done.' })))
    const { result } = hook()
    await waitFor(() => expect(result.current.data).toBeTruthy())
    const calls = mocks.get.mock.calls.length
    await act(() => result.current.generate())
    expect(result.current.error).toBe('These ranges are done.')
    expect(mocks.get.mock.calls.length).toBeGreaterThan(calls)
    expect(result.current.busy).toBe(false)
  })

  it('refreshes counts after a lock changes without polling an idle job', async () => {
    const { result, rerender } = renderHook(
      ({ list }) => useClipRenderJob('asset', 'version', 'video', 'owner', list),
      { wrapper, initialProps: { list: comments } },
    )
    await waitFor(() => expect(result.current.data?.locked_count).toBe(1))
    latest = { ...latest, locked_count: 0 }
    rerender({ list: [{ ...comments[0], locked_at: '2026-10-16T12:00:00Z' }] })
    await waitFor(() => expect(result.current.data?.locked_count).toBe(0))
  })

  it('switches the request and drops errors when the version changes', async () => {
    mocks.post.mockRejectedValue(new ApiError(409, 'Conflict'))
    const { result, rerender } = renderHook(
      ({ version }) => useClipRenderJob('asset', version, 'video', 'owner', comments),
      { wrapper, initialProps: { version: 'first' } },
    )
    await waitFor(() => expect(result.current.data).toBeTruthy())
    await act(() => result.current.generate())
    expect(result.current.error).toBe('Conflict')
    rerender({ version: 'second' })
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/assets/asset/clip-render-jobs/latest?version_id=second'))
    expect(result.current.error).toBeNull()
    rerender({ version: 'first' })
    await waitFor(() => expect(result.current.data).toBeTruthy())
    expect(result.current.error).toBeNull()
  })

  it.each(['queued', 'claimed'] as const)('polls a %s job every ten seconds and stops after completion and unmount', async (status) => {
    latest = { ...latest, job: { id: 'job', asset_id: 'asset', version_id: 'version', ranges: [], status, clips_rendered: null, message: null } }
    vi.useFakeTimers()
    const { result, unmount } = hook()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(result.current.data?.job?.status).toBe(status)
    const calls = mocks.get.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(CLIP_RENDER_POLL_INTERVAL) })
    expect(mocks.get.mock.calls.length).toBeGreaterThan(calls)
    latest = { ...latest, job: { ...latest.job!, status: 'done', clips_rendered: 2 } }
    await act(async () => { await vi.advanceTimersByTimeAsync(CLIP_RENDER_POLL_INTERVAL) })
    expect(result.current.data?.job?.status).toBe('done')
    const stopped = mocks.get.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(CLIP_RENDER_POLL_INTERVAL * 2) })
    expect(mocks.get).toHaveBeenCalledTimes(stopped)
    unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(CLIP_RENDER_POLL_INTERVAL * 2) })
    expect(mocks.get).toHaveBeenCalledTimes(stopped)
    expect(stopped).toBeGreaterThan(calls)
  })

  it('stops polling when an active control unmounts', async () => {
    latest = { ...latest, job: { id: 'job', asset_id: 'asset', version_id: 'version', ranges: [], status: 'queued', clips_rendered: null, message: null } }
    vi.useFakeTimers()
    const { unmount } = hook()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    const calls = mocks.get.mock.calls.length
    unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(CLIP_RENDER_POLL_INTERVAL * 2) })
    expect(mocks.get).toHaveBeenCalledTimes(calls)
  })

  it.each([null, 'done', 'failed', 'cancelled'] as const)('does not poll while idle or %s', async (status) => {
    if (status) latest = { ...latest, job: { id: 'job', asset_id: 'asset', version_id: 'version', ranges: [], status, clips_rendered: 2, message: null } }
    vi.useFakeTimers()
    hook()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    const calls = mocks.get.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(CLIP_RENDER_POLL_INTERVAL * 2) })
    expect(mocks.get).toHaveBeenCalledTimes(calls)
  })
})
