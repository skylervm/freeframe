const { withSentryConfig } = require('@sentry/nextjs/config')

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    remotePatterns: [
      {
        protocol: 'http',
        hostname: 'localhost',
        port: '9000',
      },
    ],
  },
  experimental: {
    instrumentationHook: true,
  },
}

module.exports = withSentryConfig(nextConfig, {
  org: 'from-below',
  project: 'freeframe-web',
  silent: !process.env.CI,
  // No SENTRY_AUTH_TOKEN on this box; source-map upload would need one and
  // the client bundle isn't worth the image-size cost (3.5MB -> 28MB) without it.
  sourcemaps: { disable: true },
})
