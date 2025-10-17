# Immich — Agent Continuity Log (continue.md)

This file captures durable context, decisions, and next steps so work can resume smoothly after restarts.

Last updated: 2025-10-17

Repository Map (high level)

- server — NestJS 11 API, Kysely + Postgres, Redis/Valkey, BullMQ, Sharp, ffmpeg (fluent-ffmpeg)
- web — Svelte 5/SvelteKit, Vite 7, Tailwind 4
- cli — TypeScript CLI with Vite
- open-api — OpenAPI spec + generators; TypeScript SDK at `open-api/typescript-sdk`
- machine-learning — Python service (uv-managed), onnxruntime backends
- e2e — Vitest + Playwright, dockerized stack for tests
- docs — Docusaurus site
- docker — Compose files for dev/prod, env examples, hw accel overlays
- .github — Prettier-only package for workflow content

Environment & Versions

- Node 22.20.0, pnpm 10.18.1 (see `mise.toml`, `pnpm-workspace.yaml`)
- Python 3.10+ for ML with uv (`machine-learning/pyproject.toml`)
- Docker & Docker Compose available
- Datastores: Postgres (VectorChord images), Redis via Valkey

Core Dev Workflows

- Install all (no docs): `pnpm -r --filter '!documentation' install`
- Dev stack (Docker):
  - Start: `make dev`
  - Stop: `make dev-down`
- OpenAPI:
  - Preferred: `make open-api` (builds server, syncs spec, generates Dart + TS)
  - TS only: `make open-api-typescript`
- Tests:
  - Server: `pnpm --filter immich run test` (or `test:medium`)
  - Web: `pnpm --filter immich-web run test`
  - CLI: `pnpm --filter @immich/cli run test`
  - E2E: `make e2e && pnpm --filter immich-e2e run test`

Key Files/Configs

- pnpm workspace: `pnpm-workspace.yaml`
- Make targets: `Makefile`
- Compose files: `docker/docker-compose.dev.yml`, `docker/docker-compose.yml`, `docker/docker-compose.prod.yml`
- Example env: `docker/example.env`
- OpenAPI generator script: `open-api/bin/generate-open-api.sh`
- Server env schema: `server/src/dtos/env.dto.ts`
- Server storage core: `server/src/cores/storage.core.ts`

Recent Changes (from git: v2.0.0 → v2.1.0)

- Runtime/tooling: Node 22.20.0; pnpm 10.18.1; dependency refreshes across packages.
- Database: dev/prod images updated to VectorChord 0.4.x (pgvectors 0.2.0); e2e uses 0.3.x.
- Server: new metric `immich.users.total`; OpenTelemetry updates; Kysely/Postgres deps updated.
- Web: Svelte/Vite/Tailwind updates and multiple UX fixes/refactors.
- CLI: adds debug development config; maintenance fixes.
- Redis: images switched to Valkey in compose files.
- OpenAPI: TS SDK generation via `oazapfts`; `make open-api` builds, syncs, and generates.
- Storage: S3 support integrated (S3-aware path joins, staged I/O for media operations, native copy/move).

Session Notes (2025-10-17 audit)

- Verified workspace layout, Makefile targets, and compose files; captured current versions.
- Confirmed package scripts for build/test/check per package.
- Noted workspace overrides: `sharp@^0.34.4` across workspace; ensure deploy builds include runtime optional deps.
- Documented preferred OpenAPI workflow via `make open-api`.

Decisions & Assumptions

- Follow minimal-diff policy; regenerate OpenAPI only when API contracts change.
- Validate within changed package first; expand to e2e if change is user-facing.
- Avoid destructive operations by default; prefer reversible changes.

Open Questions / TODOs

- [ ] On first functional change, run package-level checks before submitting.
- [ ] If touching storage or media pipelines, run `make sql` and relevant server tests.

2025-10-17 — Fix S3 video playback (HTTP Range)

- Symptom: Remote (not locally stored) videos fail to play when `IMMICH_STORAGE_ENGINE=s3`.
- Root cause: S3 streaming path in `sendFile` did not implement HTTP Range requests; many players (AVPlayer/ExoPlayer) require 206 Partial Content for seeking/streaming.
- Changes:
  - Implemented Range support in `server/src/utils/file.ts` for S3 paths: parses `Range` header, sets `Accept-Ranges`, `Content-Range`, `Content-Length`, responds with 206, and calls `s3.readStream` with byte range.
  - Added AWS SDK dependencies to `server/package.json` and fixed a TS implicit-any in `server/src/storage/s3-backend.ts`.
- Validation: Static analysis + build. Fixed TS type error (avoid returning Response from `sendFile`) and ensured S3 backend compiles. Playback endpoint `GET /asset/:id/video/playback` uses `sendFile` so clients receive proper 206 responses.

2025-10-17 — Docker web build OOM mitigation

- Symptom: `vite build` for `immich-web` aborted with "JavaScript heap out of memory" in Docker build stage.
- Root cause: Node default heap (~2GB) too low for SSR + client builds inside constrained builder image.
- Change: set `NODE_OPTIONS=--max-old-space-size=4096` for the web build RUN step in `server/Dockerfile`.
- Validation: should allow the web build stage to complete without OOM; no runtime impact since it’s only applied during the build step.
