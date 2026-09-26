import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { SharePageClient } from './share-page-client'
import { shareMetadata, type ShareMetadataSource } from './share-metadata'

// Link previews (iMessage, Slack) read the server-rendered <head>, so the
// title has to be fetched here rather than in the client page. Inside the
// compose network the web container reaches the api service directly.
const INTERNAL_API_URL = process.env.INTERNAL_API_URL || 'http://api:8000'

export async function generateMetadata({
  params,
}: {
  params: { token: string }
}): Promise<Metadata> {
  let data: ShareMetadataSource | null = null
  try {
    // Pass the caller's IP so the api's per-IP rate limit doesn't bucket every
    // share-page render under the web container's address.
    const realIp = headers().get('x-real-ip')
    const res = await fetch(`${INTERNAL_API_URL}/share/${encodeURIComponent(params.token)}`, {
      cache: 'no-store',
      headers: realIp ? { 'x-real-ip': realIp } : undefined,
      signal: AbortSignal.timeout(2000),
    })
    if (res.ok) data = await res.json()
  } catch {
    // Fall back to the generic title; the page itself still loads client-side.
  }
  return shareMetadata(data)
}

export default function SharePage({ params }: { params: { token: string } }) {
  return <SharePageClient params={params} />
}
