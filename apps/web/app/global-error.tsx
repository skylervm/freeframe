'use client'

import * as React from 'react'
import * as Sentry from '@sentry/nextjs'

interface GlobalErrorProps {
  error: Error & { digest?: string }
  reset: () => void
}

// Only fires when the ROOT layout itself throws (errors inside a route
// segment are caught by that segment's error.tsx). Next requires this file
// to render its own <html>/<body> since the root layout is gone.
export default function GlobalError({ error, reset }: GlobalErrorProps) {
  React.useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <html>
      <body>
        <div style={{ display: 'flex', minHeight: '100vh', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1rem', fontFamily: 'sans-serif' }}>
          <h2>Something went wrong</h2>
          <button onClick={reset}>Try again</button>
        </div>
      </body>
    </html>
  )
}
