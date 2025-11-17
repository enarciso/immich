# Immich Agent Playbook (AGENTS.md)

## Scope & Intent
These instructions govern every change within the Immich monorepo. They exist to keep contributions small, pattern-aligned, and verifiable across server, web, mobile, ML, and supporting tooling.

## Core Principles
- Step back before writing code: confirm how the repo already solves similar problems and mirror that structure (controllers vs services vs DTOs, Svelte stores vs endpoints, Flutter blocs, etc.).
- Ship surgical diffs that solve the root cause; avoid opportunistic refactors, formatting churn, or dependency drift.
- Match existing style, naming, and directory conventions per package; never invent new layers while an established one exists.
- Validate locally at the narrowest scope first, then fan out only if impact crosses package boundaries.
- Keep generated assets, lockfiles, and translations in sync when you must touch them; otherwise leave them alone.

## Toolchain Snapshot
- Node 24.11.0 (mise/Volta) • pnpm 10.19.x (workspace) • TypeScript 5.x toolchains
- Flutter 3.35.7 for the mobile app (plus Fastlane metadata under `fastlane/`)
- Python 3.10+ with `uv` for the machine-learning service
- Docker + Docker Compose for dev/prod/e2e stacks, Terragrunt/OpenTofu for infrastructure under `deployment/`
- Global access: sudo + network are available but only use them when required and document why.

## Repository Atlas
### pnpm workspaces (`pnpm-workspace.yaml`)
- `server/` → NestJS API (`immich`)
- `web/` → SvelteKit UI (`immich-web`)
- `cli/` → TypeScript CLI (`@immich/cli`)
- `open-api/typescript-sdk/` → `@immich/sdk` (generated SDK)
- `open-api/` → OpenAPI specs + generators (Dart & TS targets)
- `e2e/` → Vitest + Playwright suite (`immich-e2e`)
- `docs/` → Docusaurus documentation site (`documentation`)
- `.github/` → Prettier-only package for workflow content

### Additional top-level directories
- `mobile/` Flutter app (pigeon-generated platform bindings, drift schemas, scripts)
- `machine-learning/` Python FastAPI microservice (`immich_ml`)
- `docker/` Compose files (`docker-compose.dev|prod|codex.yml`, hwaccel overlays, env examples)
- `deployment/` Terragrunt modules (Cloudflare, OpenTofu state)
- `design/`, `readme_i18n/`, `i18n/`, `fastlane/`, `misc/release/`, `install.sh`, `continue.md`, etc.—treat as read-only unless a task is scoped there.

## Package & Pattern Notes
### Server (`server/`)
- NestJS 11 structured by domain modules under `controllers/`, `services/`, `repositories/`, and `dtos/`. Shared logic lives in `cores/`, `utils/`, and `storage/` (local FS + S3 backends). Jobs run from `workers/` via BullMQ/Valkey; CLI commands reside in `commands/` using `nest-commander`.
- Data access goes through Kysely (`queries/`, `schema/`, `sql-tools/`) and migrations handled by `dist/bin/migrations.js` (driven via `pnpm --filter immich run migrations:*`). SQL formatting syncs via `make sql` → `pnpm --filter immich run sync:sql`.
- Configuration flows from `dtos/env.dto.ts`, `config.ts`, and `database.ts`. Media handling depends on ffmpeg, sharp, exiftool, and storage staging; React Email templates live in `src/emails/` with the `email:dev` script.
- Tests use Vitest (`test/vitest.config*.mjs`). Prefer `pnpm --filter immich run test` (unit) or `test:medium` in docker when jobs/external deps are involved.

### Web (`web/`)
- Svelte 5 + SvelteKit + Tailwind 4. `src/routes/` power each page, `src/lib/` holds components/stores/utils, and `hooks.*.ts` customize session handling. Service worker code lives under `src/service-worker/`.
- Depends on `@immich/sdk`, `@immich/ui`, Socket.IO client, and map/geo libs. Formatting includes `format:i18n` which sorts JSON inside the root `i18n/` folder—only run when translations change.
- Validation flow: `pnpm --filter immich-web run check:typescript`, `check:svelte`, and `test` (Vitest + happy-dom). Use `build` for production-ready output.

### CLI (`cli/`)
- TypeScript CLI built with Vite. Commands live in `src/commands/`, queue helpers under `src/queue.ts`, and common utils/test fixtures beside them.
- Uses Commander, chokidar, fast-glob, etc. Validate with `pnpm --filter @immich/cli run lint`, `check`, and `test` (Vitest). `build` emits the distributable consumed by `bin/immich`.

### SDK & OpenAPI (`open-api/`)
- `open-api/bin/generate-open-api.sh` drives spec sync + codegen. Preferred flow: `make open-api` (build server → sync spec → generate Dart & TS) or `make open-api-typescript` for SDK-only. Treat `open-api/typescript-sdk/src/**/*` as generator inputs and `build/` outputs as generated; never hand-edit generated files.

### Machine Learning (`machine-learning/`)
- FastAPI + onnxruntime service under `immich_ml/`. Dependency management uses `uv` with extras (`cpu`, `cuda`, `openvino`, etc.) and `uv.lock`. Tests run through `uv run pytest`, lint via `uv run ruff check` / `black --check`, typing via `mypy`.
- Scripts under `scripts/` and `ann/` manage model assets; `patches/` houses vendor fixes.

### Mobile (`mobile/`)
- Flutter 3.35.7 app with `lib/`, `pigeon/` (platform channel generation), `drift_schemas/`, `immich_lint/`, and platform-specific code under `android/` + `ios/`. Translation sources come from `/i18n` and `mobile/`-specific localization code is generated via scripts in `mise.toml` (e.g., `mobile:i18n:*`). Tests use `flutter test`; analysis via `dart analyze` and `dcm`.
- Release tooling sits in `fastlane/` and `mobile/scripts/`.

### E2E (`e2e/`)
- Vitest + Playwright with its own docker-compose stack (`e2e/docker-compose.yml`). Bring the stack up via `make e2e` (tears down on exit) or `make e2e-down`. Tests: `pnpm --filter immich-e2e run test` (Vitest) and `test:web` (Playwright) once the stack is ready.

### Docs (`docs/`)
- Docusaurus site under `docs/` (Tailwind + Prettier). Use `pnpm --filter documentation run build` or `docs:start` (port 3005) per `mise`. Format with Prettier; keep OpenAPI JSON in `docs/static/openapi.json` synced via `make open-api` or the jq line in `docs` build.

### Docker, Deployment, Misc
- Compose definitions live in `docker/` (`docker-compose.dev.yml`, `.prod.yml`, `.codex.yml`, hwaccel overlays). `Makefile` provides `dev`, `dev-down`, `dev-update`, `prod`, `e2e`, etc. Use `make prepare-volumes` equivalents when new volumes are needed.
- Infrastructure-as-code under `deployment/` uses Terragrunt/OpenTofu tasks defined in `mise.toml` (e.g., `mise run tg:fmt`). Release scripts under `misc/release/` (version bump + notes). Localization JSON under `i18n/`; multi-language READMEs under `readme_i18n/`.

## Workflows & Commands
- Install everything except docs: `pnpm -r --filter '!documentation' install`. Targeted installs via `make install-<pkg>` or `pnpm --filter <pkg> install --frozen-lockfile`.
- Build packages with `pnpm --filter <pkg> run build`. Use `make build-all` sparingly.
- Dev stack: `make dev` (auto tears down with `make dev-down` on exit). Prod stack: `make prod`. Attach to running services via `make attach-server` or direct docker commands.
- E2E stack/tests: `make e2e`, then `pnpm --filter immich-e2e run test` / `test:web`.
- OpenAPI regeneration: `make open-api` (full) or `make open-api-typescript` (TS-only). Manual fallback: `pnpm --filter immich build` → `pnpm --filter immich run sync:open-api` → `open-api/bin/generate-open-api.sh`.
- SQL formatting/sync: `make sql` (calls `pnpm --filter immich run sync:sql`).
- Machine-learning: `uv sync`, `uv run pytest`, `uv run ruff check`, `uv run black --check`, `uv run mypy` as needed. Keep `uv.lock` aligned with `pyproject.toml`.
- Mobile: `flutter pub get`, `flutter test`, `dart analyze`, `dcm analyze`, `mise run mobile:pigeon:*` for regenerated bindings, and `mise run mobile:i18n:*` for localization assets.

## Validation Matrix (run what you touch)
| Area | Minimum check(s) |
| --- | --- |
| Server | `pnpm --filter immich run test` (add `check`, `lint`, or `test:medium` if touching infra/jobs/storage) |
| Web | `pnpm --filter immich-web run check:typescript`, `check:svelte`, `test` |
| CLI | `pnpm --filter @immich/cli run lint` + `test` (include `check` for types) |
| SDK | `pnpm --filter @immich/sdk run build` (after regen) |
| Machine-learning | `uv run pytest` + targeted linting/typing |
| Mobile | `flutter test` or relevant `dart analyze` tasks |
| Docs | `pnpm --filter documentation run build` or `format` depending on the change |
| E2E | `pnpm --filter immich-e2e run test` / `test:web` once docker stack is up |

Document skipped checks with a reason if runtime constraints prevent running them.

## Generated Assets & Dependency Policy
- Regenerate, don’t edit: OpenAPI specs/SDKs, Flutter pigeon outputs, drift schemas, ML model artifacts, `docs/static/openapi.json`, translation bundles (`i18n/*.json` sorted via `web` scripts), lockfiles (`pnpm-lock.yaml`, `uv.lock`, `pubspec.lock`).
- Keep dependency additions minimal and scoped; update the relevant lockfile(s) immediately when a package.json/pyproject/pubspec changes.

## Communication, Memory & Safety
- Keep `continue.md` current after meaningful work (what changed, commands run, decisions, next steps). Read it at session start.
- For any task beyond a trivial edit, capture a 3–7 step plan via the plan tool with exactly one `in_progress` step; update it as you work.
- Use `rg`/targeted file views to explore; avoid dumping entire files. Apply edits with `apply_patch` and never mass-reformat unaffected code.
- Summaries must link changes back to files (`path:line`). Explain test coverage or why it was skipped.
- Stop and ask when encountering unexpected repo state (dirty files you didn’t touch, failing builds unrelated to your change, etc.). Never revert user work.
- Leverage sudo/network only to unblock builds/tests (document why). Avoid destructive commands (`git reset --hard`, dropping DBs) unless explicitly asked.

Following this playbook keeps contributions consistent with the existing Immich patterns while allowing rapid, confident iteration.
