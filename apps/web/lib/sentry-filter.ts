// Sentry can attach request headers, cookies, query strings and breadcrumb
// URLs to an event even with `sendDefaultPii: false` — that flag only stops
// it from ALSO grabbing IP/user info, it does not strip credentials already
// present in the request/response Sentry captures. This module is the single
// place that redaction lives, called from beforeSend/beforeBreadcrumb in
// every Sentry.init (client, server, edge).

const SENSITIVE_HEADER_NAMES = /^(authorization|cookie|set-cookie|x-api-key)$/i
const SENSITIVE_QUERY_PARAM_NAMES = /^(token|api_key|apikey|key|access_token|refresh_token)$/i
// Routes that embed a secret directly in the path rather than a header/query.
const TOKEN_PATH_PATTERN = /\/share\/[^/?#\s]+/g

/** Redacts a `token`-shaped query parameter without touching the rest of the string. */
function redactQueryString(query: string): string {
  return query.replace(/(^|[&;])([^&;=]*)(=)([^&;]*)/g, (match, separator, name, equals) => (
    SENSITIVE_QUERY_PARAM_NAMES.test(decodeURIComponent(name)) ? `${separator}${name}${equals}REDACTED` : match
  ))
}

/** Redacts credentials from a full URL or URL path: query params and `/share/<token>`. */
export function redactUrlCredentials(value: string): string {
  const withRedactedPath = value.replace(TOKEN_PATH_PATTERN, '/share/REDACTED')

  const queryStart = withRedactedPath.indexOf('?')
  if (queryStart === -1) return withRedactedPath

  const prefix = withRedactedPath.slice(0, queryStart + 1)
  const rest = withRedactedPath.slice(queryStart + 1)
  const fragmentStart = rest.indexOf('#')
  const query = fragmentStart === -1 ? rest : rest.slice(0, fragmentStart)
  const fragment = fragmentStart === -1 ? '' : rest.slice(fragmentStart)

  return `${prefix}${redactQueryString(query)}${fragment}`
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
}

function redactHeaders(headers: Record<string, unknown> | undefined): void {
  if (!headers) return
  for (const name of Object.keys(headers)) {
    if (SENSITIVE_HEADER_NAMES.test(name)) headers[name] = 'REDACTED'
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

/** Redacts a single breadcrumb in place: URL fields, http.query, and the message. */
export function redactBreadcrumb<T extends SentryBreadcrumb>(breadcrumb: T | null): T | null {
  if (!breadcrumb) return breadcrumb
  // console.* calls can log whatever the caller passed, including tokens —
  // drop them outright rather than trying to redact free-form text.
  if (breadcrumb.category === 'console') return null

  if (breadcrumb.data) {
    if (typeof breadcrumb.data.url === 'string') breadcrumb.data.url = redactUrlCredentials(breadcrumb.data.url)
    if (typeof breadcrumb.data['http.query'] === 'string') {
      breadcrumb.data['http.query'] = redactQueryString(String(breadcrumb.data['http.query']).replace(/^\?/, ''))
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

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      .map((breadcrumb) => redactBreadcrumb(breadcrumb))
      .filter((breadcrumb): breadcrumb is SentryBreadcrumb => breadcrumb !== null) as typeof event.breadcrumbs
  }

  return event
}
