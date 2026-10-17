import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const SECRET = 'ffcr_6f1c1d4e-2a9b-4c71-9a77-3a2f6c0d9e10_super-secret-value_123'

const h = vi.hoisted(() => ({
  data: undefined as unknown,
  keys: [] as unknown[],
  mutate: vi.fn(),
}))
vi.mock('swr', () => ({
  default: (key: unknown) => {
    h.keys.push(key)
    return { data: key ? h.data : undefined, mutate: h.mutate }
  },
}))
const get = vi.fn()
const post = vi.fn()
const del = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}))
const copy = vi.fn()
vi.mock('@/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  copyToClipboard: (...a: unknown[]) => copy(...a),
}))

import { useAuthStore } from '@/stores/auth-store'
import { ClipRunnerTab } from '../clip-runner-tab'

const TOKENS = [
  {
    id: 'a1',
    name: 'Mac clip runner',
    created_at: '2026-10-01T10:00:00Z',
    last_used_at: null,
    expires_at: '2027-10-01T23:59:59Z',
    revoked_at: null,
  },
  {
    id: 'b2',
    name: 'Old laptop',
    created_at: '2026-01-01T10:00:00Z',
    last_used_at: '2026-02-01T10:00:00Z',
    expires_at: '2026-12-01T23:59:59Z',
    revoked_at: '2026-03-01T10:00:00Z',
  },
]

function utcDatePlusDays(days: number) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

async function createToken() {
  post.mockResolvedValue({ id: 'n1', name: 'Mac clip runner', created_at: '', expires_at: '', token: SECRET })
  fireEvent.click(screen.getByRole('button', { name: /create token/i }))
  await screen.findByTestId('clip-runner-secret')
}

describe('ClipRunnerTab', () => {
  beforeEach(() => {
    h.data = TOKENS
    h.keys = []
    h.mutate.mockReset().mockResolvedValue(undefined)
    get.mockReset()
    post.mockReset()
    del.mockReset().mockResolvedValue(undefined)
    copy.mockReset().mockResolvedValue(true)
    useAuthStore.setState({ isSuperAdmin: true })
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lists tokens with created, last used, expiry and revoke only for live tokens', () => {
    render(<ClipRunnerTab />)
    expect(h.keys).toContain('/clip-runner-tokens')
    expect(screen.getByText('Mac clip runner')).toBeInTheDocument()
    expect(screen.getByText('Old laptop')).toBeInTheDocument()
    expect(screen.getByText(/Last used Never/)).toBeInTheDocument()
    expect(screen.getByText(/Revoked/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1)
  })

  it('defaults the expiry to 365 days ahead and caps it there', () => {
    render(<ClipRunnerTab />)
    const expiry = screen.getByLabelText('Token expiry') as HTMLInputElement
    expect(expiry.value).toBe(utcDatePlusDays(365))
    expect(expiry.max).toBe(utcDatePlusDays(365))
    expect((screen.getByLabelText('Token name') as HTMLInputElement).value).toBe('Mac clip runner')
    fireEvent.change(expiry, { target: { value: utcDatePlusDays(400) } })
    expect(screen.getByRole('button', { name: /create token/i })).toBeDisabled()
  })

  it('creates a token and shows the secret once, with save instructions, and never stores or logs it', async () => {
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level))
    render(<ClipRunnerTab />)
    await createToken()
    expect(post).toHaveBeenCalledWith('/clip-runner-tokens', {
      name: 'Mac clip runner',
      expires_at: `${utcDatePlusDays(365)}T23:59:59Z`,
    })
    expect(screen.getByTestId('clip-runner-secret')).toHaveTextContent(SECRET)
    expect(screen.getAllByText(SECRET)).toHaveLength(1)
    expect(screen.getByText(/shown only once/i)).toBeInTheDocument()
    expect(
      screen.getByText(
        'pbpaste > ~/.config/freeframe/clip-runner.token && chmod 600 ~/.config/freeframe/clip-runner.token',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText(/never paste the token into a chat/i)).toBeInTheDocument()
    // The list is revalidated from the server, never seeded with the created token.
    await waitFor(() => expect(h.mutate).toHaveBeenCalledWith())
    expect(h.keys.every((key) => key === '/clip-runner-tokens')).toBe(true)
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('super-secret')
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain('super-secret')
    expect(window.location.href).not.toContain('super-secret')
    for (const spy of logs) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain('super-secret')
    }

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(copy).toHaveBeenCalledWith(SECRET))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('clears the secret when the panel is dismissed or the tab unmounts', async () => {
    const view = render(<ClipRunnerTab />)
    await createToken()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByTestId('clip-runner-secret')).not.toBeInTheDocument()
    expect(view.container.textContent).not.toContain('super-secret')

    await createToken()
    view.unmount()
    const again = render(<ClipRunnerTab />)
    expect(again.container.textContent).not.toContain('super-secret')
  })

  it('revokes only after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<ClipRunnerTab />)
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Mac clip runner'))
    expect(del).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(del).toHaveBeenCalledWith('/clip-runner-tokens/a1'))
    await waitFor(() => expect(h.mutate).toHaveBeenCalled())
  })

  it('renders nothing and fetches nothing for non-superadmins', () => {
    useAuthStore.setState({ isSuperAdmin: false })
    const view = render(<ClipRunnerTab />)
    expect(view.container).toBeEmptyDOMElement()
    expect(h.keys.every((key) => key === null)).toBe(true)
    expect(get).not.toHaveBeenCalled()
  })

  it('renders server text as plain text', () => {
    h.data = [{ ...TOKENS[0], name: '<img src=x onerror=alert(1)>' }]
    const view = render(<ClipRunnerTab />)
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(view.container.querySelector('img')).toBeNull()
  })
})
