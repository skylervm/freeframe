// Sentry can attach request headers, cookies, query strings and breadcrumb
// URLs to an event even with `sendDefaultPii: false` — that flag only stops
// it from ALSO grabbing IP/user info, it does not strip credentials already
// present in the request/response Sentry captures. This module is the single
// place that redaction lives, called from beforeSend/beforeBreadcrumb in
// every Sentry.init (client, server, edge).

const SENSITIVE_HEADER_NAMES = /^(authorization|cookie|set-cookie|x-api-key)$/i
const SENSITIVE_QUERY_PARAM_NAMES = /^(token|api_key|apikey|key|access_token|refresh_token)$/i
// Routes that embed a secret directly in the path rather than a header/query.
// Unanchored so it also matches nested paths like /api/auth/invite/<token>.
// The token charset is deliberately narrow (not "anything but a slash") so
// this doesn't over-match into surrounding text/JSON when the path is
// embedded in something like the next-router-state-tree header.
const TOKEN_PATH_PATTERN = /\/(share|invite)\/[A-Za-z0-9._-]+/g
// Matches a query parameter wherever it appears: after '?', after '&'/';', or
// at the very start of a bare query string with no leading '?' (e.g. a
// breadcrumb's `http.query` or Sentry's `request.query_string`).
const QUERY_PARAM_PATTERN = /([?&;]|^)([^&;=?#]*)(=)([^&;#]*)/g

function isSensitiveQueryParameterName(rawName: string): boolean {
  let name = rawName
  try {
    name = decodeURIComponent(rawName.replace(/\+/g, ' '))
  } catch {
    // Malformed percent-encoding (e.g. a lone '%'). Fall back to the raw
    // name rather than letting beforeSend throw and drop the event.
  }
  return SENSITIVE_QUERY_PARAM_NAMES.test(name.trim())
}

function redactQueryString(value: string): string {
  return value.replace(QUERY_PARAM_PATTERN, (match, separator, name, equals) => (
    isSensitiveQueryParameterName(name) ? `${separator}${name}${equals}REDACTED` : match
  ))
}

/**
 * Redacts credentials from any URL-shaped string: a full URL, a bare path, a
 * bare query string, or free text that happens to contain one (a breadcrumb
 * message, a `referer`/`next-url` header, `next-router-state-tree`). Safe to
 * run over arbitrary strings — both patterns only touch matched param/path
 * shapes, so non-matching text passes through unchanged.
 */
export function redactUrlCredentials(value: string): string {
  const fragmentStart = value.indexOf('#')
  const withoutFragment = fragmentStart === -1 ? value : value.slice(0, fragmentStart)
  const fragment = fragmentStart === -1 ? '' : value.slice(fragmentStart)

  const pathRedacted = withoutFragment.replace(TOKEN_PATH_PATTERN, (_match, kind: string) => `/${kind}/REDACTED`)
  return `${redactQueryString(pathRedacted)}${fragment}`
}

type SentryRequest = {
  url?: unknown
  query_string?: unknown
  headers?: Record<string, unknown>
  cookies?: unknown
  data?: unknown
}

type SentryBreadcrumb = {
  category?: string
  data?: Record<string, unknown>
  message?: unknown
}

type SentryEventForRedaction = {
  request?: SentryRequest
  breadcrumbs?: SentryBreadcrumb[]
  transaction?: unknown
}

/**
 * Redacts every header value: the named highly-sensitive ones (authorization,
 * cookie, set-cookie, x-api-key) are blanked entirely; every other string
 * value is run through `redactUrlCredentials` because Next.js carries the
 * current path (and any share/invite token in it) in ordinary-looking
 * headers too — `referer`, `next-url`, `next-router-state-tree`.
 */
function redactHeaders(headers: Record<string, unknown> | undefined): void {
  if (!headers) return
  for (const [name, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_NAMES.test(name)) {
      headers[name] = 'REDACTED'
    } else if (typeof value === 'string') {
      headers[name] = redactUrlCredentials(value)
    }
  }
}

function redactQueryStringField(value: unknown): unknown {
  if (typeof value === 'string') return redactUrlCredentials(value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  for (const [name, parameter] of Object.entries(value)) {
    if (SENSITIVE_QUERY_PARAM_NAMES.test(name)) {
      ;(value as Record<string, unknown>)[name] = Array.isArray(parameter) ? parameter.map(() => 'REDACTED') : 'REDACTED'
    }
  }
  return value
}

/** Redacts a single breadcrumb in place: every string field in `data`, plus the message. */
export function redactBreadcrumb<T extends SentryBreadcrumb>(breadcrumb: T | null): T | null {
  if (!breadcrumb) return breadcrumb
  // console.* calls can log whatever the caller passed, including tokens —
  // drop them outright rather than trying to redact free-form text.
  if (breadcrumb.category === 'console') return null

  if (breadcrumb.data) {
    // Covers `url`/`http.query` on fetch/xhr breadcrumbs as well as `from`/
    // `to` on navigation breadcrumbs — any field can carry a URL or token.
    for (const [name, value] of Object.entries(breadcrumb.data)) {
      if (typeof value === 'string') breadcrumb.data[name] = redactUrlCredentials(value)
    }
  }
  if (typeof breadcrumb.message === 'string') breadcrumb.message = redactUrlCredentials(breadcrumb.message)

  return breadcrumb
}

/** `beforeSend` filter: strips credentials from the request and any breadcrumbs already attached. */
export function redactSentryEvent<T extends SentryEventForRedaction>(event: T): T {
  const { request } = event
  if (request) {
    if (typeof request.url === 'string') request.url = redactUrlCredentials(request.url)
    if (request.query_string !== undefined) request.query_string = redactQueryStringField(request.query_string)
    redactHeaders(request.headers)
    if ('cookies' in request) delete request.cookies
    if ('data' in request) delete request.data
  }

  if (typeof event.transaction === 'string') event.transaction = redactUrlCredentials(event.transaction)

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      .map((breadcrumb) => redactBreadcrumb(breadcrumb))
      .filter((breadcrumb): breadcrumb is SentryBreadcrumb => breadcrumb !== null) as typeof event.breadcrumbs
  }

  return event
}
