import { useEffect } from 'react'

/**
 * Phones have no Comments/Fields tab row, so they must never be left on Fields
 * — e.g. a tablet rotated below md after Fields was picked at desktop width.
 * `min-width: 768px` is the exact complement of Tailwind's md, so no fractional
 * width falls between "tab row hidden" and "guard active".
 */
export function useCommentsTabOnPhone(showComments: () => void) {
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const desktop = window.matchMedia('(min-width: 768px)')
    const onChange = () => {
      if (!desktop.matches) showComments()
    }
    onChange()
    desktop.addEventListener('change', onChange)
    return () => desktop.removeEventListener('change', onChange)
  }, [showComments])
}
