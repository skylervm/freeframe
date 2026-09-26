import type { Metadata } from 'next'

export interface ShareMetadataSource {
  title?: string | null
  project_name?: string | null
  folder_name?: string | null
  asset?: { name?: string | null } | null
  created_by_name?: string | null
}

export function shareMetadata(data: ShareMetadataSource | null): Metadata {
  const context = data?.project_name || data?.folder_name || data?.asset?.name || null
  const title = data?.title || context || 'FreeFrame'
  const parts = [context !== title ? context : null, data?.created_by_name ? `Shared by ${data.created_by_name}` : null]
  const description = parts.filter(Boolean).join(' · ') || 'Review on FreeFrame'
  return {
    title,
    description,
    openGraph: { title, description, siteName: 'FreeFrame', type: 'website' },
  }
}
