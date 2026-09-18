import * as Sentry from '@sentry/nextjs'
import { redactBreadcrumb, redactSentryEvent } from './lib/sentry-filter'

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

if (dsn) {
  Sentry.init({
    dsn,
    sendDefaultPii: false,
    environment: process.env.NODE_ENV ?? 'production',
    beforeSend: (event) => redactSentryEvent(event),
    beforeBreadcrumb: (breadcrumb) => redactBreadcrumb(breadcrumb),
  })
}
