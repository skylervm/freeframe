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
- The review deploy does NOT run `docker-compose.prod.yml` directly — the box
  runs `bash ~/infra/webhook/deploy-freeframe-review.sh`, which composes
  `docker-compose.prod.yml` plus the overlay at
  `~/infra/freeframe/docker-compose.review.yml` (not the copy in this repo).
  `NEXT_PUBLIC_SENTRY_DSN` needs to reach that box's `.env.prod` for the build
  arg here to take effect.
