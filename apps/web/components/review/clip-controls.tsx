'use client'

import * as React from 'react'
import { useSWRConfig } from 'swr'
import { Check, Lock, LockOpen, Pencil, Repeat, X } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { ClipRange } from '@/lib/clip-range'
import { useReviewStore } from '@/stores/review-store'

interface ClipControlsProps {
  commentId: string
  /** The range as stored on the comment; Cancel puts the handles back here. */
  savedRange: ClipRange
  /** Whether this user may move the range: the comment's author or the project owner. */
  canEdit: boolean
  /** Called once the new range is saved, so the caller can update its copy of the comment. */
  onSaved: (range: ClipRange) => void
  /** When the range was locked (approved), or null. A locked range cannot be edited. */
  lockedAt: string | null
  /** Called once a lock or unlock is saved, so the caller can update its copy of the comment. */
  onLockChanged: (lockedAt: string | null) => void
}

const BUTTON =
  'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50'

/**
 * Controls for the posted range comment that is being played: loop on or off, edit its
 * start and end, or stop. Renders nothing unless this comment is the one playing.
 */
export function ClipControls({ commentId, savedRange, canEdit, onSaved, lockedAt, onLockChanged }: ClipControlsProps) {
  const activeClip = useReviewStore((s) => s.activeClip)
  const loopRange = useReviewStore((s) => s.loopRange)
  const { setLoopRange, clearClip, setClipEditing, setEditableRange } = useReviewStore.getState()
  const { mutate } = useSWRConfig()
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // The caller updates its copy of the comment in place, which does not re-render it, so
  // keep the range as last saved here rather than trusting a possibly stale prop.
  const [saved, setSaved] = React.useState(savedRange)
  React.useEffect(() => setSaved(savedRange), [savedRange.start, savedRange.end]) // eslint-disable-line react-hooks/exhaustive-deps
  // Same reason as `saved`: the lock state as last saved here.
  const [locked, setLocked] = React.useState(lockedAt)
  React.useEffect(() => setLocked(lockedAt), [lockedAt])

  if (activeClip?.commentId !== commentId) return null

  const editing = activeClip.editing

  const save = async () => {
    const current = useReviewStore.getState().activeClip
    if (current?.commentId !== commentId) return
    const { range } = current
    setSaving(true)
    setError(null)
    try {
      await api.patch(`/comments/${commentId}`, { timecode_start: range.start, timecode_end: range.end })
      onSaved(range)
      setSaved(range)
      if (useReviewStore.getState().activeClip?.commentId === commentId) setClipEditing(false)
      void mutate((key) => typeof key === 'string' && key.includes('/comments?version_id='))
    } catch {
      setError("Couldn't save the new range.")
      // The range may have been locked meanwhile; refetch so the row shows its real state.
      void mutate((key) => typeof key === 'string' && key.includes('/comments?version_id='))
    } finally {
      setSaving(false)
    }
  }

  const setLock = async (lock: boolean) => {
    if (useReviewStore.getState().activeClip?.commentId !== commentId) return
    setSaving(true)
    setError(null)
    try {
      const updated = await api.patch<{ locked_at?: string | null }>(`/comments/${commentId}`, { locked: lock })
      const next = lock ? (updated?.locked_at ?? new Date().toISOString()) : null
      onLockChanged(next)
      setLocked(next)
      void mutate((key) => typeof key === 'string' && key.includes('/comments?version_id='))
    } catch {
      setError(lock ? "Couldn't lock this range." : "Couldn't unlock this range.")
    } finally {
      setSaving(false)
    }
  }

  const cancel = () => {
    setEditableRange(saved)
    setClipEditing(false)
    setError(null)
  }

  return (
    <div
      data-testid="clip-controls"
      className="mt-2 flex flex-wrap items-center gap-1.5"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        aria-pressed={loopRange}
        title={loopRange ? 'Stop looping this clip' : 'Loop this clip'}
        onClick={() => setLoopRange(!loopRange)}
        className={cn(
          BUTTON,
          loopRange ? 'bg-amber-400/20 text-amber-300 hover:bg-amber-400/30' : 'bg-white/[0.06] text-text-tertiary hover:text-text-primary',
        )}
      >
        <Repeat className="h-3 w-3" />
        Loop
      </button>
      {editing ? (
        <>
          <button
            type="button"
            disabled={saving}
            onClick={save}
            className={cn(BUTTON, 'bg-accent text-white hover:bg-accent/90')}
          >
            <Check className="h-3 w-3" />
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={cancel}
            className={cn(BUTTON, 'text-text-tertiary hover:text-text-primary')}
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          {locked ? (
            <>
              <span className="inline-flex items-center gap-1 px-1 text-[11px] font-medium text-emerald-400">
                <Lock className="h-3 w-3" />
                Locked
              </span>
              {canEdit && (
                <button
                  type="button"
                  disabled={saving}
                  title="Unlock this range so it can be edited"
                  onClick={() => setLock(false)}
                  className={cn(BUTTON, 'bg-white/[0.06] text-text-tertiary hover:text-text-primary')}
                >
                  <LockOpen className="h-3 w-3" />
                  Unlock
                </button>
              )}
            </>
          ) : canEdit && (
            <button
              type="button"
              disabled={saving}
              title="Lock this range to approve it as a clip"
              onClick={() => setLock(true)}
              className={cn(BUTTON, 'bg-white/[0.06] text-text-tertiary hover:text-text-primary')}
            >
              <Lock className="h-3 w-3" />
              Lock
            </button>
          )}
          {canEdit && !locked && (
            <button
              type="button"
              title="Drag the start and end to adjust this clip"
              disabled={saving}
              onClick={() => setClipEditing(true)}
              className={cn(BUTTON, 'bg-white/[0.06] text-text-tertiary hover:text-text-primary')}
            >
              <Pencil className="h-3 w-3" />
              Edit range
            </button>
          )}
          <button
            type="button"
            aria-label="Stop playing this clip"
            title="Stop playing this clip"
            onClick={clearClip}
            className={cn(BUTTON, 'text-text-tertiary hover:text-text-primary')}
          >
            <X className="h-3 w-3" />
          </button>
        </>
      )}
      {error && <span className="text-[11px] text-red-400">{error}</span>}
    </div>
  )
}
