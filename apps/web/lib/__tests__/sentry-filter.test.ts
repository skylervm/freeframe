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

  it('redacts both a path token and a query token on the same url', () => {
    expect(redactUrlCredentials('/share/fake-share-token?access_token=fake-access')).toBe(
      '/share/REDACTED?access_token=REDACTED',
    )
  })

  it('leaves urls with nothing sensitive unchanged', () => {
    expect(redactUrlCredentials('/api/projects?page=2')).toBe('/api/projects?page=2')
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
})

describe('redactBreadcrumb', () => {
  it('redacts data.url, http.query, and message', () => {
    const breadcrumb = {
      category: 'xhr',
      data: { url: '/api/export?access_token=fake-token', 'http.query': '?token=fake-token' },
      message: 'GET /share/fake-share-token',
    }

    const result = redactBreadcrumb(breadcrumb)

    expect(result?.data?.url).toBe('/api/export?access_token=REDACTED')
    expect(result?.data?.['http.query']).toBe('token=REDACTED')
    expect(result?.message).toBe('GET /share/REDACTED')
  })

  it('drops console-category breadcrumbs', () => {
    expect(redactBreadcrumb({ category: 'console', message: 'fake-token' })).toBeNull()
  })

  it('passes null through unchanged', () => {
    expect(redactBreadcrumb(null)).toBeNull()
  })
})
