'use client'

import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useClipRenderJob, type ClipRenderState } from '@/hooks/use-clip-render-job'
import type { CommentWithReplies } from '@/hooks/use-comments'
import type { ProjectRole } from '@/types'
import { formatRelativeTime } from '@/lib/utils'

export function AssetClipRenderControls({ assetId, versionId, role, comments, menu = false }: {
  assetId: string
  versionId: string
  role: ProjectRole
  comments: CommentWithReplies[]
  menu?: boolean
}) {
  const state = useClipRenderJob(assetId, versionId, 'video', role, comments)
  return <ClipRenderControls state={state} menu={menu} />
}

export function ClipRenderControls({ state, menu = false }: { state: ClipRenderState; menu?: boolean }) {
  const { data, eligible, busy, error, generate, cancel } = state
  if (!eligible || !data || data.range_count === 0) return null

  const { job, locked_count: locked, range_count: count, worker_last_seen_at: lastSeen } = data
  const queued = job?.status === 'queued'
  const claimed = job?.status === 'claimed'
  const inset = menu ? 'px-2.5' : ''
  const note = locked === 0
    ? 'Lock a range to generate clips'
    : `${locked} locked of ${count}. Unlocked ranges are skipped.`
  const buttonClass = 'w-full rounded-md border border-border bg-bg-tertiary px-3 py-1.5 text-left text-sm font-medium text-text-primary transition-colors hover:border-border-focus hover:bg-bg-hover disabled:opacity-50'
  const action = (text: string, onClick: () => Promise<unknown>, disabled: boolean) => menu ? (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={(event) => { event.preventDefault(); void onClick() }}
      className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-text-secondary outline-none transition-colors hover:bg-bg-hover hover:text-text-primary data-[disabled]:opacity-50 data-[highlighted]:bg-bg-hover"
    >
      {text}
    </DropdownMenu.Item>
  ) : (
    <button type="button" disabled={disabled} onClick={() => void onClick()} className={buttonClass}>
      {text}
    </button>
  )

  return (
    <div className={menu ? 'space-y-1 py-2 text-xs' : 'space-y-1 px-4 py-2 text-xs'}>
      <div role="status" aria-live="polite" className={`break-words text-text-secondary ${inset}`}>
        {queued && <>
          <p>Queued. Waiting for your Mac.</p>
          <p className="text-text-tertiary">{lastSeen ? `Mac last seen ${formatRelativeTime(lastSeen)}` : 'Mac not seen yet'}</p>
        </>}
        {claimed && <p>Rendering on your Mac</p>}
        {job?.status === 'done' && <p>Done: {job.clips_rendered ?? 0} clips</p>}
        {job?.status === 'failed' && <p>{job.message || 'Rendering failed.'}</p>}
      </div>
      {queued && action('Cancel', cancel, busy)}
      {!queued && !claimed && <>
        {action('Generate clips', generate, busy || locked === 0)}
        <p className={`text-text-tertiary ${inset}`}>{note}</p>
      </>}
      {error && <p role="alert" className={`break-words text-red-400 ${inset}`}>{error}</p>}
    </div>
  )
}
