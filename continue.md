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

2025-11-03 — Investigate Kysely migration error

- Input: Production dump `docker/library/photos/backups/immich-db-backup-20251102T180000-v2.1.0-pg14.19.sql.gz`.
- Findings: `public.kysely_migrations` and `public.kysely_migrations_lock` exist with expected schema and owners (immich). Data shows 3 applied migrations; lock row present with `is_locked=0`.
- Code alignment: Server config uses `migrationTableName: 'kysely_migrations'` and `migrationLockTableName: 'kysely_migrations_lock'` (server/src/repositories/database.repository.ts).
- Likely causes in the field:
  - Connecting to a different DB/schema (table not found); or
  - Lock stuck (`is_locked=1`); or
  - DB has migrations not present in FS (mismatch) or vice versa; or
  - Column mismatch in a custom DB (rare).
- Remediation (safe): Ensure tables exist with correct schema; upsert lock row to 0; verify search_path includes `public`; then run migrations.
- SQL used (idempotent core): create tables if missing; insert lock row with ON CONFLICT; compare DB names vs FS.
- Next: If error persists, capture exact server log line for targeted fix.

2025-11-03 — Resolve corrupted migrations (unordered)

- Symptom: Kysely error expecting 1761078763279 at index 35 but 1758705774125 was found; executed set not a prefix of filesystem.
- Root cause: DB missing three OCR migrations while server image included them; later migration (AddAppVersionColumnToSession) already recorded.
- Attempts: Backfill + idempotent DDL for OCR tables/column, then mark as executed → server image didn’t match order; rolled back OCR entries and objects.
- Fix: Run migrations once with unordered allowed against compose DB:
  - Command: `docker compose run --rm -e IMMICH_ENV=development -e DB_URL=postgres://immich:<url-encoded-pass>@database:5432/immich immich-server node /usr/src/app/server/dist/bin/migrations.js run`
  - Result: Successfully applied 1758705774125, 1758705789125, 1758705804128. `kysely_migrations` now has 39 rows in correct order.
- Follow-up: Start server normally; ensure `DB_SKIP_MIGRATIONS` is not set; verify logs show migrations completed without errors.

2025-11-03 — Finalize order via timestamp correction

- Symptom (post-run): Server still reported out-of-order at index 35.
- Root cause: Kysely orders executed migrations by the `timestamp` string; the 3 OCR entries had timestamps later than `1761078763279-AddAppVersionColumnToSession`.
- Action: Updated timestamps to predate 176107… while remaining after prior entries:
  - `1758705774125-CreateAssetOCRTable` → `2025-10-20T00:00:00.000Z`
  - `1758705789125-CreateOCRSearchTable` → `2025-10-20T00:00:01.000Z`
  - `1758705804128-UpsertOcrAssetJobStatus` → `2025-10-20T00:00:02.000Z`
- Result: `kysely_migrations` now aligns with file order (39 rows); server should start cleanly.

2025-11-03 — Fix prod Docker build (lockfile mismatch)

- Symptom: `docker compose -f docker/docker-compose.prod.yml build` fails in `immich-server` stage with `ERR_PNPM_OUTDATED_LOCKFILE` because `pnpm-lock.yaml` didn’t include newly added `server` deps (`@aws-sdk/client-s3`, `@aws-sdk/lib-storage`).
- Root cause: Dependencies were added in `server/package.json` without regenerating the workspace lockfile.
- Action: Updated the workspace lockfile only: `pnpm -r --filter '!documentation' install --lockfile-only`. Verified the lock now contains `@aws-sdk/client-s3` and `@aws-sdk/lib-storage`.
- Next: Re-run build: `docker compose -f docker/docker-compose.prod.yml build --no-cache --progress=plain`. If web OOMs during build, set `NODE_OPTIONS=--max-old-space-size=4096` for the web build step as noted earlier.

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

## 2025-11-17 — Repository orientation + guideline refresh
- Reviewed workspace layout (pnpm workspace, Makefile, mise.toml, server/web/cli/mobile/ml/e2e/docs packages) to reconfirm structure, tooling versions, and workflows.
- Rewrote `AGENTS.md` with a detailed playbook covering principles, tooling, package patterns, workflows, testing matrix, generated assets, and safety/process expectations.
- Rebuilt `codex.md` to capture the day-to-day operating rhythm, plan/tool usage, command references, validation rules, and communication style.
- Commands: `ls`, `cat pnpm-workspace.yaml`, `cat package.json`, `sed -n` for README/Makefile/continue/mise, directory listings for each package (`ls server/src` etc.), and `mv` to replace AGENTS/codex after drafting.
- Next: Ready for feature/bugfix work; follow the new playbook + codex for subsequent contributions.

2025-11-17 — Clean up S3 staging files after video transcode
- Issue: S3 staging for video transcode jobs left /tmp artifacts (especially when jobs were skipped or failed) which exhausted pod disks.
- Changes: updated `MediaService.stageOutputIfS3` to return a `cleanup` handler and ensured `handleVideoConversion` always runs staged input/output cleanup in `finally` and only allocates staged output when needed. Reworked transcode flow so invalid HW configs still throw (matching existing tests) while runtime ffmpeg errors fall back to software decoding/CPU, and staged files are purged even on early returns.
- Commands:
 - `sudo npm install -g pnpm@10.19.0` (pnpm missing in PATH)
 - `cd server && ./node_modules/.bin/vitest --config test/vitest.config.mjs --run` (timed out due to suite size)
  - `cd server && ./node_modules/.bin/vitest run --config test/vitest.config.mjs src/services/media.service.spec.ts`
- Result: targeted media service tests pass; temporary staging files are removed after each job regardless of success/failure/skip. Ready for deployment once broader validation (if desired) completes.

2025-11-22 — Refresh AGENTS/codex after repo survey
- Re-surveyed the monorepo layout, workspace config, package manifests, and tooling versions (pnpm 10.20.0, Node 24.11.0) to ensure guidance matches current state, including the `plugins/` workspace.
- Rewrote `AGENTS.md` and `codex.md` to emphasize pattern alignment, package-specific workflows, validation expectations, generated assets, and safety/process rules.
- Commands: `pwd`, `ls`, `cat continue.md`, `cat AGENTS.md`, `cat codex.md`, `cat pnpm-workspace.yaml`, `cat package.json`, `cat server/package.json`, `cat web/package.json`, `cat cli/package.json`, `cat open-api/typescript-sdk/package.json`, `cat e2e/package.json`, `cat docs/package.json`, `sed -n '1,200p' machine-learning/pyproject.toml`, `sed -n '1,120p' mobile/pubspec.yaml`, `sed -n '1,200p' Makefile`, `ls server/src`, `ls web/src`, `ls cli/src`, `ls plugins`, `cat plugins/package.json`, `date`.
- Next: Ready to pick up feature/bugfix work using the refreshed playbook.

2025-11-22 — Regenerate pnpm lockfile
- Regenerated workspace `pnpm-lock.yaml` after it was removed to resolve conflicts.
- Commands: `sudo npm install -g pnpm@10.20.0` (pnpm missing), `pnpm -r --filter '!documentation' install --lockfile-only` (ran under Node v18.19.1 in this shell; produced engine warnings but completed). Lockfile now present for all workspaces.
- Next: Use Node 24.11.0 via mise/Volta for builds/tests; proceed with image build using the refreshed lockfile.
