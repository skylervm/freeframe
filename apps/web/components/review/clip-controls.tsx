'use client'

import * as React from 'react'
import { useSWRConfig } from 'swr'
import { Check, Pencil, Repeat, X } from 'lucide-react'
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
}

const BUTTON =
  'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50'

/**
 * Controls for the posted range comment that is being played: loop on or off, edit its
 * start and end, or stop. Renders nothing unless this comment is the one playing.
 */
export function ClipControls({ commentId, savedRange, canEdit, onSaved }: ClipControlsProps) {
  const activeClip = useReviewStore((s) => s.activeClip)
  const loopRange = useReviewStore((s) => s.loopRange)
  const { setLoopRange, clearClip, setClipEditing, setEditableRange } = useReviewStore.getState()
  const { mutate } = useSWRConfig()
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  if (activeClip?.commentId !== commentId) return null

  const editing = activeClip.editing

  const save = async () => {
    const { range } = useReviewStore.getState().activeClip ?? activeClip
    setSaving(true)
    setError(null)
    try {
      await api.patch(`/comments/${commentId}`, { timecode_start: range.start, timecode_end: range.end })
      onSaved(range)
      setClipEditing(false)
      void mutate((key) => typeof key === 'string' && key.includes('/comments?version_id='))
    } catch {
      setError("Couldn't save the new range.")
    } finally {
      setSaving(false)
    }
  }

  const cancel = () => {
    setEditableRange(savedRange)
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
          {canEdit && (
            <button
              type="button"
              title="Drag the start and end to adjust this clip"
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
