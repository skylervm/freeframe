import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  refreshAccessToken: vi.fn(),
}))

vi.mock('@/lib/auth', () => auth)

import { api } from '../api'

describe('unauthenticated API requests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn())
  })

  it('does not read or refresh credentials after a 401', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Passphrase required' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await expect(
      api.get('/share/public-link/assets', { unauthenticated: true }),
    ).rejects.toMatchObject({ status: 401 })

    expect(auth.getAccessToken).not.toHaveBeenCalled()
    expect(auth.refreshAccessToken).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:8000/share/public-link/assets',
      expect.objectContaining({
        headers: expect.not.objectContaining({ Authorization: expect.anything() }),
      }),
    )
  })
})
