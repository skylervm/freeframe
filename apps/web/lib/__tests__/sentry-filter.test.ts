import { describe, it, expect } from 'vitest'
import { redactBreadcrumb, redactSentryEvent, redactUrlCredentials } from '../sentry-filter'

describe('redactUrlCredentials', () => {
  it('redacts a sensitive query parameter without touching other params', () => {
    expect(redactUrlCredentials('/api/notifications?token=fake-token&page=2')).toBe(
      '/api/notifications?token=REDACTED&page=2',
    )
  })

  it('redacts a share-link path token', () => {
    expect(redactUrlCredentials('https://review.frombelow.studio/share/fake-share-token')).toBe(
      'https://review.frombelow.studio/share/REDACTED',
    )
  })

  it('redacts an invite path token', () => {
    expect(redactUrlCredentials('/invite/fake-invite-token')).toBe('/invite/REDACTED')
  })

  it('redacts a nested api invite path token', () => {
    expect(redactUrlCredentials('/api/auth/invite/fake-invite-token')).toBe('/api/auth/invite/REDACTED')
  })

  it('redacts both a path token and a query token on the same url', () => {
    expect(redactUrlCredentials('/share/fake-share-token?access_token=fake-access')).toBe(
      '/share/REDACTED?access_token=REDACTED',
    )
  })

  it('redacts a bare query string with no leading "?"', () => {
    expect(redactUrlCredentials('token=fake-token&page=2')).toBe('token=REDACTED&page=2')
  })

  it('redacts a sensitive param in free text, e.g. a header or breadcrumb message', () => {
    expect(redactUrlCredentials('GET /projects/5 referred from /share/fake-share-token')).toBe(
      'GET /projects/5 referred from /share/REDACTED',
    )
  })

  it('leaves urls with nothing sensitive unchanged', () => {
    expect(redactUrlCredentials('/api/projects?page=2')).toBe('/api/projects?page=2')
  })

  it('does not throw on malformed percent-encoding in a query name', () => {
    expect(() => redactUrlCredentials('/api/projects?%E0%A4%A=1')).not.toThrow()
  })
})

describe('redactSentryEvent', () => {
  it('redacts sensitive request headers case-insensitively', () => {
    const event = {
      request: {
        headers: {
          Authorization: 'Bearer fake-token',
          Cookie: 'ff_access_token=fake-token',
          'X-Api-Key': 'fake-key',
          'content-type': 'application/json',
        },
      },
    }

    const result = redactSentryEvent(event)

    expect(result.request?.headers?.Authorization).toBe('REDACTED')
    expect(result.request?.headers?.Cookie).toBe('REDACTED')
    expect(result.request?.headers?.['X-Api-Key']).toBe('REDACTED')
    expect(result.request?.headers?.['content-type']).toBe('application/json')
  })

  it('redacts a share token carried in non-named headers (referer, next-url)', () => {
    const event = {
      request: {
        headers: {
          referer: 'https://review.frombelow.studio/share/fake-share-token',
          'next-url': '/share/fake-share-token',
        },
      },
    }

    const result = redactSentryEvent(event)

    expect(result.request?.headers?.referer).toBe('https://review.frombelow.studio/share/REDACTED')
    expect(result.request?.headers?.['next-url']).toBe('/share/REDACTED')
  })

  it('blanks next-router-state-tree entirely (it encodes a dynamic segment as ["token","<value>","d"], not a path)', () => {
    // A real Next.js router state tree for /share/[token], URL-encoded as the
    // header value actually appears on the wire.
    const tree =
      '%5B%22%22%2C%7B%22children%22%3A%5B%22share%22%2C%7B%22children%22%3A%5B%5B%22token%22%2C%22fake-share-token%22%2C%22d%22%5D%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%5D%7D%5D%7D%5D%7D%5D'

    const event = { request: { headers: { 'next-router-state-tree': tree } } }
    const result = redactSentryEvent(event)

    expect(result.request?.headers?.['next-router-state-tree']).toBe('REDACTED')
  })

  it('deletes request.cookies and request.data entirely', () => {
    const event = {
      request: {
        cookies: { ff_access_token: 'fake-token', ff_refresh_token: 'fake-refresh' },
        data: { password: 'fake-password' },
      },
    }

    const result = redactSentryEvent(event)

    expect(result.request).not.toHaveProperty('cookies')
    expect(result.request).not.toHaveProperty('data')
  })

  it('redacts the query string on request.url', () => {
    const event = { request: { url: '/api/export?access_token=fake-token' } }
    const result = redactSentryEvent(event)
    expect(result.request?.url).toBe('/api/export?access_token=REDACTED')
  })

  it('redacts a share-link path token on request.url', () => {
    const event = { request: { url: 'https://review.frombelow.studio/share/fake-share-token' } }
    const result = redactSentryEvent(event)
    expect(result.request?.url).toBe('https://review.frombelow.studio/share/REDACTED')
  })

  it('redacts a structured request.query_string', () => {
    const event = { request: { query_string: { token: 'fake-token', page: '2' } } }
    const result = redactSentryEvent(event)
    expect((result.request?.query_string as Record<string, unknown>).token).toBe('REDACTED')
    expect((result.request?.query_string as Record<string, unknown>).page).toBe('2')
  })

  it('redacts a string request.query_string with no leading "?"', () => {
    const event = { request: { query_string: 'access_token=fake-token&page=2' } }
    const result = redactSentryEvent(event)
    expect(result.request?.query_string).toBe('access_token=REDACTED&page=2')
  })

  it('redacts event.transaction', () => {
    const event = { transaction: '/share/[token]' }
    // Not path-token shaped ([token] is the route pattern, not a value) but
    // must still pass through the same redaction as everything else without
    // throwing, and redact a query if the transaction name carries one.
    const eventWithQuery = { transaction: '/share/fake-share-token' }
    expect(redactSentryEvent(event).transaction).toBe('/share/[token]')
    expect(redactSentryEvent(eventWithQuery).transaction).toBe('/share/REDACTED')
  })

  it('redacts breadcrumb urls and drops console breadcrumbs', () => {
    const event = {
      breadcrumbs: [
        { category: 'fetch', data: { url: '/share/fake-share-token?token=fake-token' } },
        { category: 'console', message: 'Bearer fake-token leaked to console' },
        { category: 'navigation', message: 'navigated to /share/fake-share-token' },
      ],
    }

    const result = redactSentryEvent(event)

    expect(result.breadcrumbs).toHaveLength(2)
    expect(result.breadcrumbs?.[0].data?.url).toBe('/share/REDACTED?token=REDACTED')
    expect(result.breadcrumbs?.[1].message).toBe('navigated to /share/REDACTED')
  })

  it('redacts navigation breadcrumb data.from and data.to', () => {
    const event = {
      breadcrumbs: [
        {
          category: 'navigation',
          data: { from: '/share/fake-share-token', to: '/invite/fake-invite-token' },
        },
      ],
    }

    const result = redactSentryEvent(event)

    expect(result.breadcrumbs?.[0].data?.from).toBe('/share/REDACTED')
    expect(result.breadcrumbs?.[0].data?.to).toBe('/invite/REDACTED')
  })
})

describe('redactBreadcrumb', () => {
  it('redacts every string field on breadcrumb.data, not just url/http.query', () => {
    const breadcrumb = {
      category: 'navigation',
      data: {
        from: '/share/fake-share-token',
        to: '/invite/fake-invite-token',
        url: '/api/export?access_token=fake-token',
        'http.query': 'token=fake-token',
        statusCode: 200,
      },
    }

    const result = redactBreadcrumb(breadcrumb)

    expect(result?.data?.from).toBe('/share/REDACTED')
    expect(result?.data?.to).toBe('/invite/REDACTED')
    expect(result?.data?.url).toBe('/api/export?access_token=REDACTED')
    expect(result?.data?.['http.query']).toBe('token=REDACTED')
    expect(result?.data?.statusCode).toBe(200)
  })

  it('redacts message', () => {
    const breadcrumb = {
      category: 'xhr',
      message: 'GET /share/fake-share-token',
    }

    const result = redactBreadcrumb(breadcrumb)

    expect(result?.message).toBe('GET /share/REDACTED')
  })

  it('drops console-category breadcrumbs', () => {
    expect(redactBreadcrumb({ category: 'console', message: 'fake-token' })).toBeNull()
  })

  it('passes null through unchanged', () => {
    expect(redactBreadcrumb(null)).toBeNull()
  })
})
