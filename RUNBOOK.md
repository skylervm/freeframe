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

## Workspace branding

- Logos (dark and light) and a generated icon are stored in the database, on the
  `workspaces` row (`logo_dark`, `logo_light`, `icon`, `branding_updated_at`), not in
  the browser. Added by migration `bb23cc45dd67`; the api container runs
  `alembic upgrade head` on start, so a deploy applies it with no manual step.
- Public, no login: `GET /workspace/branding/{logo_dark|logo_light|icon}.png`. The
  site favicon and apple-touch-icon are `icon.png` (`apps/web/app/layout.tsx`).
- With no uploaded logo, `icon.png` serves the stock icon `apps/api/static/icon-default.png`.
  It ships inside the api image (`COPY apps/api`), so changing it needs an api rebuild.
- Editable by superadmins and workspace owners (Settings, Branding).
- Responses are cached for 5 minutes (`Cache-Control: max-age=300`, plus an ETag that
  changes on every branding save). A new icon can take up to 5 minutes to show.
- Before the first-time workspace setup is done, the favicon returns 503
  ("Workspace is not initialized"). Expected, not an outage.
