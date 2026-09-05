'use client'

import * as React from 'react'
import useSWRInfinite from 'swr/infinite'
import { RotateCcw, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { usePageTitle } from '@/hooks/use-page-title'

type TrashItem = {
  operation_id: string
  id: string
  type: 'asset' | 'folder' | 'project' | 'project_folder'
  name: string | null
  deleted_at: string
  expires_at: string | null
}

type TrashResponse = { items: TrashItem[]; retention_days: number }

const labels: Record<TrashItem['type'], string> = {
  asset: 'Asset',
  folder: 'Media folder',
  project: 'Project',
  project_folder: 'Project folder',
}

function dateLabel(value: string | null) {
  if (!value) return 'Retention disabled'
  return `Deletes ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value))}`
}

export default function TrashPage() {
  usePageTitle('Trash')
  const pageSize = 50
  const { data: pages, error, isLoading, mutate, setSize, size } = useSWRInfinite<TrashResponse>(
    (index, previous) => previous && previous.items.length < pageSize ? null : `/trash?skip=${index * pageSize}&limit=${pageSize}`,
    (key: string) => api.get<TrashResponse>(key),
  )
  const data = pages?.[0]
  const items = pages?.flatMap((page) => page.items) ?? []
  const hasMore = !!pages?.length && pages[pages.length - 1].items.length === pageSize
  const [pending, setPending] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)

  const restore = async (item: TrashItem) => {
    setPending(item.operation_id)
    setActionError(null)
    try {
      await api.post(`/trash/${item.operation_id}/restore`, {})
      await mutate()
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Could not restore this item.')
    } finally {
      setPending(null)
    }
  }

  const empty = async (item: TrashItem) => {
    if (!window.confirm(`Permanently delete “${item.name ?? labels[item.type]}”? This cannot be undone.`)) return
    setPending(item.operation_id)
    setActionError(null)
    try {
      await api.delete(`/trash/${item.operation_id}`)
      await mutate()
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Could not permanently delete this item.')
    } finally {
      setPending(null)
    }
  }

  return (
    <main className="h-full w-full overflow-y-auto px-6 py-8">
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-text-primary">Trash</h1>
        <p className="mt-1 text-sm text-text-tertiary">
          Deleted items are kept for {data?.retention_days ?? 30} days before permanent removal.
        </p>
      </div>

      {actionError && <p role="alert" className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{actionError}</p>}
      {error && <p role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">Could not load Trash. Refresh to try again.</p>}
      {isLoading ? <p className="text-sm text-text-tertiary">Loading Trash…</p> : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center">
          <Trash2 className="mx-auto h-6 w-6 text-text-tertiary" />
          <p className="mt-3 text-sm text-text-secondary">Trash is empty</p>
          <p className="mt-1 text-xs text-text-tertiary">Deleted projects, folders, and assets will appear here.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-bg-secondary">
          {items.map((item) => {
            const busy = pending === item.operation_id
            return (
              <div key={item.operation_id} className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0">
                <Trash2 className="h-4 w-4 shrink-0 text-text-tertiary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-text-primary">{item.name ?? 'Deleted item'}</p>
                  <p className="mt-0.5 text-xs text-text-tertiary">{labels[item.type]} · {dateLabel(item.expires_at)}</p>
                </div>
                <button disabled={busy} onClick={() => restore(item)} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-accent hover:bg-bg-hover disabled:opacity-50">
                  <RotateCcw className="h-3.5 w-3.5" /> Restore
                </button>
                <button disabled={busy} onClick={() => empty(item)} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/10 disabled:opacity-50">
                  <Trash2 className="h-3.5 w-3.5" /> Empty
                </button>
              </div>
            )
          })}
        </div>
      )}
      {hasMore && (
        <button onClick={() => setSize(size + 1)} className="mt-4 self-start rounded-md px-3 py-2 text-sm font-medium text-accent hover:bg-bg-hover">
          Load more
        </button>
      )}
      </div>
    </main>
  )
}
