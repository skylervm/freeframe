import * as React from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useComments, type CommentWithReplies } from '../use-comments'
import { useClipRenderJob } from '../use-clip-render-job'

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: mocks }))

function wrapper({ children }: { children: React.ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, errorRetryCount: 0 }}>{children}</SWRConfig>
}

beforeEach(() => vi.resetAllMocks())

describe('create comment', () => {
  it('posts the lock once and refreshes locked comments and render counts', async () => {
    const created = {
      id: 'clip', parent_id: null, body: 'Clip', timecode_start: 0, timecode_end: 5,
      locked_at: '2026-10-23T12:00:00Z', resolved: false, replies: [],
    } as unknown as CommentWithReplies
    let saved = false
    mocks.get.mockImplementation(async (key: string) => key.includes('/comments?')
      ? (saved ? [created] : [])
      : { job: null, range_count: saved ? 1 : 0, locked_count: saved ? 1 : 0, worker_last_seen_at: null })
    mocks.post.mockImplementation(async () => { saved = true; return created })
    const { result } = renderHook(() => {
      const comments = useComments('asset', 'version')
      const render = useClipRenderJob('asset', 'version', 'video', 'owner', comments.comments)
      return { ...comments, render }
    }, { wrapper })
    await waitFor(() => expect(result.current.render.data?.locked_count).toBe(0))

    await act(async () => {
      await result.current.createComment('Clip', 0, 5, undefined, undefined, 'public', undefined, true)
    })

    expect(mocks.post).toHaveBeenCalledExactlyOnceWith('/assets/asset/comments', {
      body: 'Clip', version_id: 'version', timecode_start: 0, timecode_end: 5, visibility: 'public', locked: true,
    })
    await waitFor(() => expect(result.current.comments).toEqual([created]))
    await waitFor(() => expect(result.current.render.data).toMatchObject({ range_count: 1, locked_count: 1 }))
  })

  it('leaves the normal create payload unchanged', async () => {
    mocks.get.mockResolvedValue([])
    mocks.post.mockResolvedValue({ id: 'note', replies: [] })
    const { result } = renderHook(() => useComments('asset', 'version'), { wrapper })

    await act(async () => { await result.current.createComment('Typed note', 0) })

    expect(mocks.post).toHaveBeenCalledExactlyOnceWith('/assets/asset/comments', {
      body: 'Typed note', version_id: 'version', timecode_start: 0,
    })
  })

  it('does not insert a comment if locked creation fails', async () => {
    mocks.get.mockResolvedValue([])
    mocks.post.mockRejectedValue(new Error('Lock rejected'))
    const { result } = renderHook(() => useComments('asset', 'version'), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await expect(result.current.createComment('Clip', 0, 5, undefined, undefined, undefined, undefined, true))
        .rejects.toThrow('Lock rejected')
    })

    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(result.current.comments).toEqual([])
  })
})
