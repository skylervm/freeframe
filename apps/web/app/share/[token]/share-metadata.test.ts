import { describe, expect, it } from 'vitest'
import { shareMetadata } from './share-metadata'

describe('shareMetadata', () => {
  it('uses the share link title with project and sharer as description', () => {
    const m = shareMetadata({
      title: 'FBREP1: RITCHRD',
      project_name: 'From Below Radio: Episode 1',
      created_by_name: 'Skyler Vander Molen',
    })
    expect(m.title).toBe('FBREP1: RITCHRD')
    expect(m.description).toBe('From Below Radio: Episode 1 · Shared by Skyler Vander Molen')
    expect(m.openGraph?.title).toBe('FBREP1: RITCHRD')
  })

  it('falls back to the asset name when the link has no title', () => {
    const m = shareMetadata({ asset: { name: 'cut_v3.mov' } })
    expect(m.title).toBe('cut_v3.mov')
    expect(m.description).toBe('Review on FreeFrame')
  })

  it('falls back to FreeFrame when the api could not be reached', () => {
    expect(shareMetadata(null).title).toBe('FreeFrame')
  })
})
