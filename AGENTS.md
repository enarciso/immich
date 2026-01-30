# Immich Agent Playbook

## Intent & Mindset
- Anchor every change to existing patterns: controllers/services/DTOs on the server, Svelte routes/stores on the web, Riverpod/blocs on mobile, FastAPI routers for ML, and commander commands for CLI.
- Prefer surgical diffs that solve the root cause; defer refactors, formatting sweeps, and dependency churn unless explicitly scoped.
- Step back often: reuse existing layers instead of inventing new ones, and mirror established naming and directory conventions.
- Validate in the smallest relevant scope first; expand only when the impact crosses packages.

## Toolchain Snapshot
- Node 24.11.0 (mise/Volta) • pnpm 10.20.x • TypeScript 5.x toolchains
- Flutter 3.35.7 for `mobile/`
- Python 3.10+ with `uv` for `machine-learning/`
- Docker + Docker Compose; Terragrunt/OpenTofu for `deployment/`
- Sudo/network available—use only when necessary and note why.

## Repository Atlas
### pnpm workspaces
- `server/` (NestJS API `immich`)
- `web/` (SvelteKit UI `immich-web`)
- `cli/` (TS CLI `@immich/cli`)
- `open-api/` (spec + generators) and `open-api/typescript-sdk/` (`@immich/sdk`)
- `e2e/` (Vitest + Playwright)
- `docs/` (Docusaurus `documentation`)
- `plugins/` (Extism JS plugin)
- `.github/` (workflow content; Prettier only)

### Other top-level directories
- `mobile/` Flutter app; `machine-learning/` FastAPI service; `docker/` Compose files; `deployment/` IaC
- Supporting roots: `design/`, `i18n/`, `readme_i18n/`, `fastlane/`, `misc/`, `install.sh`, `context.md`, `pnpm-lock.yaml` (treat as read-only unless scoped).

## Package & Pattern Notes
### Server (`server/`)
- NestJS 11 organized by domain: `controllers/`, `services/`, `repositories/`, `dtos/`; shared code in `cores/`, `utils/`, `storage/`. Background jobs in `workers/` (BullMQ/Valkey); CLI commands in `commands/` (nest-commander).
- Data access via Kysely under `queries/`, `schema/`, `sql-tools/`; migrations run through `dist/bin/migrations.js` (`pnpm --filter immich run migrations:*`). SQL formatting via `make sql`.
- Config flows from `dtos/env.dto.ts`, `config.ts`, and `database.ts`. Media handling relies on ffmpeg/sharp/exiftool and storage staging (local + S3). React Email templates live in `src/emails/`.
- Tests: Vitest (`test/vitest.config*.mjs`). Use `test:medium` only when external deps/jobs are involved.

### Web (`web/`)
- Svelte 5 + SvelteKit + Tailwind 4. Pages under `src/routes/`; shared components/stores/utils in `src/lib/`; service worker code under `src/service-worker/`; hooks in `hooks.*.ts`.
- Depends on `@immich/sdk`, `@immich/ui`, Socket.IO client, map/geo libs. i18n JSON lives at repo root under `i18n/`; sort via `format:i18n` only when translations change.
- Validation: `check:typescript`, `check:svelte`, `test`; `build` for production bundles.

### CLI (`cli/`)
- Commander-based commands under `src/commands/`; queue helpers in `src/queue.ts`; shared utils in `src/utils.ts`.
- Built with Vite; relies on `@immich/sdk`. Validate with `lint`, `check`, `test`; `build` produces the distributable for `bin/immich`.

### SDK & OpenAPI (`open-api/`)
- `open-api/bin/generate-open-api.sh` orchestrates spec sync + Dart/TS generation. Prefer `make open-api` (full) or `make open-api-typescript` (TS only).
- Treat `open-api/typescript-sdk/src/**/*` as generator inputs and `build/` outputs as generated—never hand edit generated artifacts.

### Machine Learning (`machine-learning/`)
- FastAPI service (`immich_ml`) with onnxruntime backends. Dependency management via `uv` (`uv.lock` authoritative) with extras (`cpu`, `cuda`, `openvino`, etc.).
- Tests with `uv run pytest`; lint `uv run ruff check` / `black --check`; types via `uv run mypy`. Scripts under `scripts/` and `ann/`; vendor fixes in `patches/`.

### Mobile (`mobile/`)
- Flutter 3.35.7 app. Sources under `lib/`; platform bindings in `pigeon/`; drift schemas in `drift_schemas/`; lint rules in `immich_lint/`; platform code under `android/` and `ios/`.
- Localization is generated from `/i18n` and mobile-specific scripts in `mise.toml` (`mobile:i18n:*`). Use `flutter test`, `dart analyze`, `dcm analyze`; regenerate pigeon bindings via `mise run mobile:pigeon:*`.

### E2E (`e2e/`)
- Vitest + Playwright suite. Stack launched via `make e2e` (tears down with `make e2e-down`). Tests: `pnpm --filter immich-e2e run test` and `test:web`.

### Docs (`docs/`)
- Docusaurus site. `pnpm --filter documentation run build` (copies OpenAPI via `copy:openapi`); format with Prettier. Preview with `npm run start` (port 3005).

### Plugins (`plugins/`)
- Extism JS plugin workspace. Build pipeline: `build:tsc` (tsc noEmit + esbuild) then `build:wasm` (extism-js). Treat `dist/` as generated output.

### Docker, Deployment, Misc
- Compose files under `docker/` (`docker-compose.dev|prod|codex.yml`, hwaccel overlays, env examples). `Makefile` drives dev/prod/e2e stacks and common tasks.
- IaC in `deployment/` (Terragrunt/OpenTofu via `mise run tg:*`); release scripts in `misc/release/`; translations in `i18n/`; multi-language READMEs in `readme_i18n/`.

## Workflows & Commands
- Install (skip docs): `pnpm -r --filter '!documentation' install`; targeted installs via `make install-<pkg>` or `pnpm --filter <pkg> install --frozen-lockfile`.
- Dev/prod stacks: `make dev` / `make dev-down`; `make prod` / `make prod-down`; attach to running server via `make attach-server`.
- Testing/build by package:
  - Server: `pnpm --filter immich run test` (add `check`, `lint`, or `test:medium` when needed).
  - Web: `pnpm --filter immich-web run check:typescript`, `check:svelte`, `test`, `build`.
  - CLI: `pnpm --filter @immich/cli run lint`, `check`, `test`, `build`.
  - SDK: `pnpm --filter @immich/sdk run build` (after regeneration).
  - E2E: `make e2e` → `pnpm --filter immich-e2e run test` / `test:web`.
  - Docs: `pnpm --filter documentation run build` or `format`.
  - Machine-learning: `uv sync`; `uv run pytest` + lint/type checks as appropriate.
  - Mobile: `flutter pub get`; `flutter test`; `dart analyze` / `dcm analyze`; regen assets via `mise run mobile:*`.
  - Plugins: `pnpm --filter plugins run build` when plugin code changes.
- OpenAPI regeneration: `make open-api` (full) or `make open-api-typescript` (TS SDK only). Manual fallback: server build → `pnpm --filter immich run sync:open-api` → `open-api/bin/generate-open-api.sh`.
- SQL sync/format: `make sql` (`pnpm --filter immich run sync:sql`).
- i18n sorting (only when changing translations): `pnpm --filter immich-web run format:i18n` or `mise run i18n:format`.

## Validation Matrix (run what you touch)
| Area | Minimum check(s) |
| --- | --- |
| Server | `pnpm --filter immich run test` (+ `check`/`lint`/`test:medium` when relevant) |
| Web | `pnpm --filter immich-web run check:typescript`, `check:svelte`, `test` |
| CLI | `pnpm --filter @immich/cli run lint`, `check`, `test` |
| SDK | `pnpm --filter @immich/sdk run build` after regen |
| Machine-learning | `uv run pytest` + lint/type checks as needed |
| Mobile | `flutter test` or targeted `dart analyze`/`dcm` |
| Docs | `pnpm --filter documentation run build` or `format` |
| E2E | `pnpm --filter immich-e2e run test` / `test:web` after stack up |
Document skipped checks with a brief reason.

## Generated Assets & Dependency Policy
- Regenerate, don’t edit: OpenAPI specs/SDKs, pigeon outputs, drift schemas, ML artifacts, plugin `dist/`, `docs/static/openapi.json`, translation bundles (`i18n/*.json` sorted), lockfiles (`pnpm-lock.yaml`, `uv.lock`, `pubspec.lock`).
- Keep dependency additions minimal and scoped; update lockfiles immediately when package manifests change.

## Process, Communication & Safety
- Read `context.md` at session start; append meaningful work (what changed, commands, decisions, next steps) before yielding.
- For non-trivial tasks, capture a 3–7 step plan via the plan tool with exactly one `in_progress` step; update as you proceed.
- Use `rg` for search and targeted file views (≤250 lines). Edit via `apply_patch`; avoid mass reformatting or moving code without need.
- Summaries must cite files with `path:line` and list tests run/skipped (with reasons).
- Never revert user changes or run destructive commands (e.g., `git reset --hard`) unless explicitly instructed. If repo state is unexpected, stop and ask.
- Use sudo/network only to unblock builds/tests and note the reason when you do.

Following this playbook keeps changes traceable, pattern-aligned, and easy to review across the entire monorepo.
