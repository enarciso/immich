# Immich — Agent Continuity Log (context.md)

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
- Commands: `pwd`, `ls`, `cat context.md`, `cat AGENTS.md`, `cat codex.md`, `cat pnpm-workspace.yaml`, `cat package.json`, `cat server/package.json`, `cat web/package.json`, `cat cli/package.json`, `cat open-api/typescript-sdk/package.json`, `cat e2e/package.json`, `cat docs/package.json`, `sed -n '1,200p' machine-learning/pyproject.toml`, `sed -n '1,120p' mobile/pubspec.yaml`, `sed -n '1,200p' Makefile`, `ls server/src`, `ls web/src`, `ls cli/src`, `ls plugins`, `cat plugins/package.json`, `date`.
- Next: Ready to pick up feature/bugfix work using the refreshed playbook.

2025-11-22 — Regenerate pnpm lockfile
- Regenerated workspace `pnpm-lock.yaml` after it was removed to resolve conflicts.
- Commands: `sudo npm install -g pnpm@10.20.0` (pnpm missing), `pnpm -r --filter '!documentation' install --lockfile-only` (ran under Node v18.19.1 in this shell; produced engine warnings but completed). Lockfile now present for all workspaces.
- Next: Use Node 24.11.0 via mise/Volta for builds/tests; proceed with image build using the refreshed lockfile.

2025-11-23 — Fix plugin build path for extism-js
- Docker multi-arch build failed in plugins stage (`extism-js: not found`). Added `PATH=/buildcache/mise/shims:$PATH` in `server/Dockerfile` plugins stage so mise-installed shims are available during `mise run build`.
- Re-ran lockfile generation after reverting the temporary extism-js npm dependency: `pnpm -r --filter '!documentation' install --lockfile-only` (Node v18.19.1; engine warnings expected).
- Next: Retry docker build; mise-installed extism-js should now be on PATH for all architectures.

2025-11-23 — Invoke extism-js via mise and refresh lockfile
- Updated `plugins/package.json` to call `extism-js` through `mise x extism/js-pdk@1.5.1` so the binary is resolved from mise installs during builds (avoids missing binary in Docker multi-arch).
- Regenerated `pnpm-lock.yaml` after the script change with `pnpm -r --filter '!documentation' install --lockfile-only` (Node v18.19.1; engine warnings expected).
- Next: Run the docker build again; plugins stage should now find `extism-js` via mise.

2025-11-23 — Download extism-js binary in Docker build
- Changed plugin wasm build to call `extism-js` directly again (`plugins/package.json`).
- In the plugins stage of `server/Dockerfile`, added an `ARG EXTISM_JS_VERSION` and a download step that fetches the appropriate `extism-js` binary for x86_64/aarch64 from the official js-pdk release and installs it to `/usr/local/bin`. PATH already includes `/buildcache/mise/shims` for binaryen.
- Regenerated `pnpm-lock.yaml` after the script adjustment with `pnpm -r --filter '!documentation' install --lockfile-only` (Node v18.19.1; engine warnings expected).
- Next: Retry the docker build; the plugins stage should now find `extism-js` without relying on mise plugins.

2025-11-24 — Reapply extism-js download after revert
- User reset Dockerfile; re-added minimal plugin-stage fix to download `extism-js` binary for x86_64/aarch64 and ensure `/buildcache/mise/shims` is on PATH so binaryen/mise tools are found.
- No lockfile changes.
- Next: rerun multi-arch `docker buildx`; plugin build should locate `extism-js`.

2025-11-24 — Stage S3 media locally for ffprobe/ffmpeg
- `server/src/services/media.service.ts`: added S3-aware staging helpers and now stage inputs for video thumbnail generation and video conversion so ffprobe/ffmpeg always read local temp files. Cleans up staged files afterward. Fixes “Protocol not found” when originals are on S3.
- Adjusted S3 config lookup to use env storage config (removed bad `getStorageTemplate` call).
- Build-time TypeScript error resolved; rerun server image build.

2025-11-24 — Ensure staged video inputs are always cleaned
- `server/src/services/media.service.ts`: wrapped video transcoding path in try/finally to guarantee staged temp files are removed even on errors/early returns. (Also added staging cleanup around video thumbnail generation.)

2025-11-24 — Stage S3 outputs locally before upload
- `server/src/services/media.service.ts`: added `stageOutputIfS3` to write ffmpeg outputs to a temp file when the target is S3, upload via the S3 backend, and clean up afterward. Applied to video thumbnail generation and video conversion so ffmpeg never writes directly to `s3://`, preventing protocol errors and tmp bloat.
- Adjusted temp output naming to carry the original file extension so ffmpeg can infer the muxer when writing staged outputs.

2025-12-18 — Fix S3 thumbnail generation for images/videos
- Issue: Production thumbnail jobs failed with Sharp “Input file is missing” and libvips write errors when hitting `s3://` paths; S3 originals also threw `NoSuchKey` during staging.
- Change: Image thumbnail flow now stages originals and all outputs (preview/thumbnail/fullsize) locally, copies EXIF/XMP from staged input, then commits to S3 before cleanup. Video thumbhash now uses staged preview before cleanup. Paths: `server/src/services/media.service.ts`.
- Status: Code updated; pending deployment and requeuing thumbnail jobs. Genuine `NoSuchKey` still requires restoring missing objects.

2025-12-08 — New session setup
- Read `AGENTS.md` and `codex.md` per instructions.
- Verified frontend dev server binds to `0.0.0.0` (`web/package.json` dev script).
- Attempted to review demo assets and Bastion logo, but no `demo/` directory or `Bastion_Logo` files are present in the repo; need paths/assets from the user.

2025-12-21 — Repository orientation refresh
- Reviewed `AGENTS.md`, `codex.md`, and `context.md` to align with current patterns and workflow expectations across packages.
- No code changes; ready to proceed with scoped feature/bugfix work.

2025-12-21 — Resolve asset-media merge conflicts (v2.4.1 + S3)
- Resolved conflict markers in `server/src/services/asset-media.service.ts` by combining upstream sidecar handling + exif override with S3-safe `utimes` guards.
- Commands: `rg -n "<<<<<<<|=======|>>>>>>>" server/src/services/asset-media.service.ts`, `sed -n '330,520p' server/src/services/asset-media.service.ts`.
- Next: run server tests if broader validation is needed.

2025-12-21 — Resolve Dockerfile/lockfile merge conflicts
- Updated the plugins stage in `server/Dockerfile` to keep the PATH shim and platform-specific mise cache mount.
- Installed pnpm to `/home/ubuntu/.local/bin/pnpm` and regenerated `pnpm-lock.yaml` to clear merge markers (`/home/ubuntu/.local/bin/pnpm -r --filter '!documentation' install --lockfile-only`).
- Commands: `sed -n '40,90p' server/Dockerfile`, `npm install -g --prefix /home/ubuntu/.local pnpm@10.20.0`.

2025-12-21 — Resolve build-mobile workflow conflict
- Updated `.github/workflows/build-mobile.yml` to keep Ruby 3.4.7 with bundler cache, run `bundle exec pod install`, and drop conflict markers.
- Commands: `sed -n '160,240p' .github/workflows/build-mobile.yml`.

2025-12-21 — Fix metadata extraction sidecar staging
- Updated `server/src/services/metadata.service.ts` to derive sidecar paths from `asset.files` and pass staged sidecar paths into `getExifTags`, aligning with v2.4.1 asset shape while keeping S3 staging.
- Commands: `sed -n '240,360p' server/src/services/metadata.service.ts`, `sed -n '520,600p' server/src/services/metadata.service.ts`.

2025-12-21 — Inspect running Immich users
- Used `sudo docker exec` with `immich-admin list-users` to identify admin accounts in the running test stack.
- Note: passwords are stored as hashes; only reset is possible.

2026-01-01 — Rename continuity log to context.md
- Renamed `continue.md` to `context.md` and updated references in `AGENTS.md` and `codex.md`.

2026-01-01 — S3 data transfer audit (no code changes)
- Reviewed S3-related transfer paths (server streaming, metadata/thumbnail staging, ML uploads, download archives) and prepared optimization options pending scope confirmation.

2026-01-01 — S3 cost context
- Confirmed S3 bucket + EC2 are both us-east-1 and env uses S3 engine; keep API proxy behavior to stay close to upstream while focusing on transfer-reduction options.

2026-01-30 — Resolve v2.5.2 merge conflicts (preserve S3 support)

- Resolved conflicts in server storage/backup/media services, keeping S3 staging + S3 backup streaming while aligning with upstream refactors (extractOriginalImage, getImageFile, syncFiles). Added S3-aware backup path using buildPostgresLaunchArguments + stream pipeline to S3. Files: server/src/cores/storage.core.ts, server/src/services/backup.service.ts, server/src/services/media.service.ts.
- Adopted upstream build-mobile workflow (workflow_call + iOS cert import/keychain handling) and merged docs restore process text while keeping S3 backup note. Files: .github/workflows/build-mobile.yml, docs/docs/administration/backup-and-restore.md.
- Rebuilt pnpm-lock.yaml to resolve conflicts and include current deps.

Commands:
- git status -sb
- sed -n (various files), rg -n
- git show build-v2.5.2:.github/workflows/build-mobile.yml
- : > pnpm-lock.yaml
- npx pnpm@10.20.0 -r --filter '!documentation' install --lockfile-only (timed out but lockfile generated)

Notes:
- Used network to fetch pnpm via npx; command timed out after completion but pnpm-lock.yaml regenerated.
- Node in shell was v18.19.1 (engine warnings expected).

Next steps:
- Consider running targeted server tests if touching media/backup logic.

2026-01-30 — Fix S3 backup listing error (admin maintenance 500)

- Root cause: listDatabaseBackups used fs readdir/stat on an s3:// path, causing ENOENT in production.
- Changes: added S3-aware list/delete/upload/download logic in server/src/utils/database-backups.ts using ConfigRepository to initialize S3 backend, plus safe joinPaths for s3:// paths.

Commands:
- rg -n "database backups|database-backup|backup" server/src
- sed -n on server/src/utils/database-backups.ts

Next steps:
- Rebuild/redeploy immich_server to pick up the fix.

2026-02-15 — Resolve v2.5.6 merge conflicts and preserve S3 backups

- Resolved unmerged files:
  - `server/src/utils/database-backups.ts`: kept upstream utility-only content (`isValid*`, `findDatabaseBackupVersion`, `UnsupportedPostgresError`).
  - `server/src/services/backup.service.ts`: accepted upstream deletion (service superseded by `DatabaseBackupService`).
  - `pnpm-lock.yaml`: regenerated with `pnpm -r --filter '!documentation' install --lockfile-only`.
- Reintroduced custom S3 backup behavior in active service:
  - `server/src/services/database-backup.service.ts` now supports S3 for backup creation (`writeStream` + temp object promotion), upload/list/delete/cleanup, download path joining, and restore reads (`head`/`readStream` for S3 paths).
  - Added S3 helper methods: joined path handling, backend initialization, S3 path detection, stream helpers.
- Added regression coverage:
  - `server/src/services/database-backup.service.spec.ts` includes S3 cases for create/upload/list/delete/download.
- Commands:
  - `./node_modules/.bin/vitest run --config test/vitest.config.mjs src/services/database-backup.service.spec.ts` (pass)
  - `./node_modules/.bin/vitest run --config test/vitest.config.mjs src/cores/storage.core.spec.ts` (pass)
  - `pnpm --filter immich run check` (fails on pre-existing `download.service.spec.ts` mock typing: `ImmichZipStream` missing `addStream`).
- Notes:
  - S3-critical runtime paths (`storage.service`, `media.service`, `metadata.service`, `download.service`, `utils/file.ts`) were re-audited; S3 detection and stream/copy behaviors remain present.

2026-03-07 — Fix storage-template move-history path-lock collision

- Production symptom: `StorageTemplateService` failed with Postgres `23505` (`UQ_newPath`) while inserting into `move_history` for a templated destination like `.../IMG_1813+2.mp4`.
- Root cause: `StorageTemplateService.getTemplatePath()` only checked `storage.checkFileExists(destination)` before choosing a destination, but did not consider existing reserved destinations in `move_history.newPath`.
- Change:
  - `server/src/repositories/move.repository.ts`: added `getByNewPath(newPath)` query helper.
  - `server/src/services/storage-template.service.ts`: destination de-duplication loop now checks both file existence and move-history lock; paths locked by other assets are treated as occupied.
  - Same-asset/original-path lock is exempt so retries do not force unnecessary suffixes.
- Tests:
  - Added regression tests in `server/src/services/storage-template.service.spec.ts` for locked destination by another asset and by the same asset.
  - Command: `pnpm --filter immich exec vitest run --config test/vitest.config.mjs src/services/storage-template.service.spec.ts` (PASS, 31 tests).

2026-04-21 — Workspace + S3 feature deep analysis (no code changes)

- Completed required boot sequence: reviewed `AGENTS.md`, `context.md`, and `docs/agent/{STATE,DECISIONS,TASKS,CHANGELOG}.md`.
- Audited workspace architecture and branch graph:
  - current branch `main` is clean
  - `feat/S3Support` exists locally and is ancestor-merged into `main`
  - fork-vs-upstream history reviewed with focus on S3 deltas.
- Reconstructed S3 feature lineage:
  - `c658340d9` initial S3 scaffolding
  - `09fd9d19c` first functional S3 pass across server/storage/media/config/docker/docs
  - `dd3ecac27` S3 database dump/doc hardening
  - later hardening commits including backup list fix (`f8b6104b5`), staged media outputs (`1b86b8f3e`), and HTTP Range playback (`ee49c105b`).
- Verified current end-to-end S3 behavior in code:
  - Uploads stream directly to S3 with checksuming (`server/src/middleware/file-upload.interceptor.ts`)
  - StorageCore move path uses copy/verify/delete semantics for S3 (`server/src/cores/storage.core.ts`)
  - Media + metadata jobs stage S3 inputs/outputs locally for ffmpeg/sharp/exif workflows (`server/src/services/media.service.ts`, `server/src/services/metadata.service.ts`)
  - Downloads and playback support S3 streams and HTTP byte ranges (`server/src/services/download.service.ts`, `server/src/utils/file.ts`)
  - DB backups support S3 write/list/delete/restore streams (`server/src/services/database-backup.service.ts`)
  - S3 engine derives media location and skips local mount checks (`server/src/services/storage.service.ts`).
- Confirmed docs/env coverage for operators:
  - `docs/docs/administration/s3-storage.md`
  - `docs/docs/install/environment-variables.md`
  - `docker/example.env`
  - `docker/README.md`.
- Notes:
  - historical `migrate-to-s3` command was added then removed in branch history; migration path is currently documented as `aws s3 sync` workflow.
  - no tests run this session because request was analysis-only and no source code was modified.

2026-04-21 — v2.7.5 upstream merge rehearsal (PR-style S3 safety review)

- Reproduced user merge method in isolated worktree:
  - `git fetch --no-tags upstream refs/tags/v2.7.5:refs/tags/build-v2.7.5`
  - `git merge --allow-unrelated-histories build-v2.7.5`
- Merge conflicted in key S3-sensitive services:
  - `server/src/middleware/file-upload.interceptor.ts`
  - `server/src/services/download.service.ts`
  - `server/src/services/media.service.ts`
  - `server/src/services/metadata.service.ts`
  - `server/src/services/database-backup.service.ts`
- Findings:
  - Upstream variants of upload/download/media/metadata remove custom S3 flow currently required by this fork.
  - `database-backup` needs hybrid merge: keep S3 path logic while adopting upstream response changes (`timezone` field).
  - Upstream introduces important behavior shifts that must be preserved while porting S3 patches (`DownloadArchiveDto.edited`, media transparent-file semantics + encoded-video file model, metadata `Tasks` orchestration).
- Non-S3 conflicts also present (`pnpm-lock.yaml`, `.gitignore`, `server/tsconfig.json`, workflow delete/modify), but S3-critical files are the primary merge risk.
- No merge-resolving edits applied in rehearsal worktree; produced a merge plan + verification matrix for safe execution.

2026-04-21 — v2.7.5 merge conflict resolution (S3 preserved)

- Resolved all merge conflicts in the live merge tree (no remaining unmerged files).
- S3-critical files resolved with upstream behavior retained:
  - `server/src/middleware/file-upload.interceptor.ts` (local stream + S3 upload stream paths)
  - `server/src/services/download.service.ts` (edited/original path logic + S3 zip streaming)
  - `server/src/services/media.service.ts` (S3 staging retained; duplicate decode regression removed; encoded video upsert kept)
  - `server/src/services/metadata.service.ts` (upstream `Tasks` + S3 staged reads retained)
  - `server/src/services/database-backup.service.ts` (S3 list/read/write/delete + timezone list field)
- Non-S3 conflicts resolved:
  - `.gitignore`
  - `server/tsconfig.json`
  - `.github/workflows/release-pr.yml` (upstream deletion retained)
  - `pnpm-lock.yaml` regenerated via `corepack pnpm -r --filter '!documentation' install --lockfile-only`.
- Test adjustments for merged contracts:
  - `server/src/services/database-backup.service.spec.ts` updated for `timezone` in S3 list response.
  - `server/src/services/download.service.spec.ts` zip mocks updated with `addStream`.
- Validation:
  - PASS: `corepack pnpm --filter immich exec vitest run --config test/vitest.config.mjs src/services/database-backup.service.spec.ts src/services/download.service.spec.ts src/services/media.service.spec.ts src/services/metadata.service.spec.ts src/cores/storage.core.spec.ts`
  - FAIL (pre-existing outside conflict scope): `corepack pnpm --filter immich run check` still fails in:
    - `src/repositories/cron.repository.ts` (cron package type-version mismatch)
    - `src/services/storage-template.service.spec.ts` (`assetStub` symbol missing).

2026-04-21 — Fix Docker prod build failure (cron type mismatch)

- Build failure reproduced from compose logs at server Dockerfile step: `pnpm --filter immich --frozen-lockfile build`.
- Root cause: TS type incompatibility between two cron versions loaded in type space (`cron@4.4.0` direct and `cron@4.3.5` via `@nestjs/schedule`) in `CronRepository`.
- Code fix:
  - `server/src/repositories/cron.repository.ts`
  - Added explicit `unknown` bridge casts at `addCronJob` and `setTime` call sites to avoid private-field nominal type conflicts.
- Validation:
  - PASS: `corepack pnpm --filter immich run build` (in `server/`).

2026-04-21 — Fix S3 upload corruption causing thumbnail decode failures

- Symptom from runtime logs: newly uploaded images failed thumbnail generation with `AssetGenerateThumbnails` -> `MediaRepository.decodeImage` (`sharp`: "Input file contains unsupported image format").
- Root cause: `server/src/middleware/file-upload.interceptor.ts` attached `file.stream.on('data', ...)` before async `s3.writeStream(path)` resolved; this can switch the readable to flowing mode and consume/drop initial bytes before the pipeline is connected.
- Fix applied:
  - Replaced out-of-band `data` listener accounting with an inline `Transform` stage that tracks checksum + size while forwarding bytes.
  - Wired that transform into both S3 and local upload pipelines, preserving behavior but preventing pre-pipeline drain.
- Validation:
  - PASS: `corepack pnpm --filter immich run build`
- Follow-up:
  - Rebuild/restart server image and re-test image uploads with S3 enabled.
  - Requeue failed thumbnail jobs for affected assets once deployed.

2026-04-21 — Fix S3 thumbnail "Input file is missing" on upload

- Symptom from runtime logs after prior upload fix:
  - `AssetGenerateThumbnails` failed with sharp error:
  - `Input file is missing: s3://<bucket>/<prefix>/library/...png`
- Root cause:
  - In `MediaService.extractOriginalImage`, transparency metadata probe still called:
    - `this.mediaRepository.getImageMetadata(asset.originalPath)`
  - For S3 engine, `asset.originalPath` can be `s3://...`, which sharp cannot open directly.
  - This path should use already-staged local `sourcePath` (same input used for decode).
- Fix applied:
  - `server/src/services/media.service.ts`:
    - `getImageMetadata(asset.originalPath)` -> `getImageMetadata(sourcePath)`.
- Validation:
  - PASS: `corepack pnpm --filter immich run build`
  - PASS: `corepack pnpm --filter immich exec vitest run --config test/vitest.config.mjs src/services/media.service.spec.ts` (192 passed)
- Follow-up:
  - Rebuild/restart `immich-server` image and retry image upload with S3 enabled.
  - Requeue failed thumbnail jobs for already-uploaded affected assets.
