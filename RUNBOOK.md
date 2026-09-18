# RUNBOOK

## Sentry

- Project slug: `freeframe-web`, org `from-below` (EU region).
- Env var: `NEXT_PUBLIC_SENTRY_DSN`, set in the host `.env.prod`.
- Init lives in `apps/web/sentry.client.config.ts`, `sentry.server.config.ts`,
  `sentry.edge.config.ts` (via `apps/web/instrumentation.ts`), each guarded on
  the DSN being set.
- Baked into the client bundle at build time via a Docker `ARG`/`ENV` in
  `apps/web/Dockerfile.prod`, passed through as a build arg in
  `docker-compose.prod.yml`.
- Missing DSN = disabled, no build or deploy impact.
