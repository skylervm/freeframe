import { api } from '@/lib/api'
import { useBrandingStore } from '@/stores/branding-store'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

interface WorkspaceBranding {
  has_logo_dark: boolean
  has_logo_light: boolean
  has_icon: boolean
  updated_at: string | null
}

function imageUrl(name: 'logo_dark' | 'logo_light', b: WorkspaceBranding): string {
  return `${API_URL}/workspace/branding/${name}.png?v=${encodeURIComponent(b.updated_at ?? '')}`
}

function applyToStore(b: WorkspaceBranding) {
  const { setOrgLogoDark, setOrgLogoLight } = useBrandingStore.getState()
  setOrgLogoDark(b.has_logo_dark ? imageUrl('logo_dark', b) : null)
  setOrgLogoLight(b.has_logo_light ? imageUrl('logo_light', b) : null)
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  // Server-hosted logos are fetched as a blob: an <img> copy already in the
  // cache (the sidebar's) has no CORS headers and would taint the canvas.
  const url = src.startsWith('data:') ? src : URL.createObjectURL(await (await fetch(src, { cache: 'no-store' })).blob())
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('Could not load logo image'))
      img.src = url
    })
  } finally {
    if (url !== src) URL.revokeObjectURL(url)
  }
}

/** Draw the image onto a transparent canvas and return it as a PNG data URL. */
async function renderPng(src: string, fit: (w: number, h: number) => { cw: number; ch: number; x: number; y: number; w: number; h: number }) {
  const img = await loadImage(src)
  const w = img.naturalWidth || 512
  const h = img.naturalHeight || 512
  const box = fit(w, h)
  const canvas = document.createElement('canvas')
  canvas.width = box.cw
  canvas.height = box.ch
  canvas.getContext('2d')!.drawImage(img, box.x, box.y, box.w, box.h)
  return canvas.toDataURL('image/png')
}

/**
 * The logo as-is, rasterised to PNG and capped at 512px on its long side, which
 * keeps even a photographic logo under the api's 2 MB limit.
 */
export function logoToPng(src: string) {
  return renderPng(src, (w, h) => {
    const s = Math.min(1, 512 / Math.max(w, h))
    const cw = Math.round(w * s)
    const ch = Math.round(h * s)
    return { cw, ch, x: 0, y: 0, w: cw, h: ch }
  })
}

/** The logo centred on a transparent 512px square, unchanged otherwise. */
export function logoToIcon(src: string) {
  return renderPng(src, (w, h) => {
    const s = 512 / Math.max(w, h)
    const dw = Math.round(w * s)
    const dh = Math.round(h * s)
    return { cw: 512, ch: 512, x: Math.round((512 - dw) / 2), y: Math.round((512 - dh) / 2), w: dw, h: dh }
  })
}

let latestSave = 0

/** Save both logos to the server and regenerate the site icon from them. */
export async function saveWorkspaceBranding(dark: string | null, light: string | null) {
  const save = ++latestSave
  const [logoDark, logoLight] = await Promise.all([
    dark ? logoToPng(dark) : null,
    light ? logoToPng(light) : null,
  ])
  const source = logoDark ?? logoLight
  const icon = source ? await logoToIcon(source) : null
  const b = await api.put<WorkspaceBranding>('/workspace/branding', {
    logo_dark: logoDark,
    logo_light: logoLight,
    icon,
  })
  // A slower, older save must not overwrite the store after a newer one.
  if (save === latestSave) applyToStore(b)
}

/**
 * Load the server's branding into the store. Logos used to live only in this
 * browser's storage; if the server has never had branding saved and this
 * browser still holds a logo, a superadmin's browser uploads it once.
 */
export async function syncWorkspaceBranding(isSuperadmin: boolean) {
  const b = await api.get<WorkspaceBranding>('/workspace/branding', { unauthenticated: true })
  const { orgLogoDark, orgLogoLight } = useBrandingStore.getState()
  if (!b.updated_at && isSuperadmin && (orgLogoDark || orgLogoLight)) {
    await saveWorkspaceBranding(orgLogoDark, orgLogoLight)
    return
  }
  if (b.updated_at) applyToStore(b)
}
