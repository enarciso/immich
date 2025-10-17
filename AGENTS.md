Immich Agent Guidelines (AGENTS.md)

Scope: Applies to the entire repository.

Purpose: Provide clear, project-specific conventions for this AI coding agent when reading, changing, testing, and operating within the Immich monorepo.

Key Principles

- Small, surgical changes: Only modify files directly related to the request. Avoid broad refactors.
- Preserve style: Match existing patterns, naming, and structure in each package (server, web, cli, e2e, docs, machine-learning).
- Validate locally: Build and test the smallest affected scope first (package-level), then broader when warranted.
- Keep noise low: Don’t add unrelated dependencies, files, or formatting changes.
- No license headers: Do not add or alter license/copyright headers unless explicitly requested.
- Focus on root cause: Prefer fixes that resolve the underlying issue rather than band-aids.

Repository Overview

- Package manager: pnpm (monorepo) with workspace config in `pnpm-workspace.yaml`.
- Node: 22.20.0 (Volta/mise), pnpm: 10.18.1 (`mise.toml`).
- Packages (pnpm workspaces):
  - `server` (NestJS 11 + Kysely + PostgreSQL + Redis/Valkey + BullMQ) — main API and jobs.
  - `web` (Svelte 5 + SvelteKit + Vite 7 + Tailwind 4) — web client UI.
  - `cli` (TypeScript + Vite) — Immich CLI.
  - `open-api/typescript-sdk` — TypeScript SDK (`@immich/sdk`).
  - `open-api` — OpenAPI spec and generators (Dart + TypeScript) and templates.
  - `machine-learning` (Python, uv, onnxruntime) — ML microservice.
  - `e2e` (Vitest + Playwright) — end-to-end tests, dockerized.
  - `docs` (Docusaurus) — documentation site.
  - `.github` — Prettier formatting-only package for workflows content.
  - `docker` — compose files for dev/prod and examples.

Common Tasks & Commands

- Install all (excluding docs): `pnpm -r --filter '!documentation' install`
- Build server: `pnpm --filter immich build`
- Build web: `pnpm --filter immich-web build`
- Run dev stack (Docker): `make dev` (tears down on exit) | stop `make dev-down`
- E2E environment: `make e2e` | `make e2e-down` | run tests `pnpm --filter immich-e2e run test`
- OpenAPI: `make open-api` (builds server, syncs spec, generates Dart + TS) | TS only `make open-api-typescript`
- SQL sync (format SQL from Kysely): `make sql`
- Hygiene (format/lint/check across repo): `make hygiene-all`

Package-Specific Notes

- Server (`server`)
  - Tech: NestJS 11, Kysely, Socket.IO, Redis/Valkey, Sharp, ffmpeg via fluent-ffmpeg, OpenTelemetry metrics.
  - Scripts: `build`, `start:dev`, `test`, `test:medium`, migrations via `dist/bin/migrations.js`.
  - Validate: `pnpm --filter immich run check:all` or selectively `format`, `lint`, `check`, `test`.
  - When changing API contracts, regenerate OpenAPI (see OpenAPI section).
  - Storage: supports local filesystem and S3 (see env in `server/src/dtos/env.dto.ts`).

- Web (`web`)
  - Tech: Svelte 5, SvelteKit tooling, Vite 7, Tailwind 4.
  - Scripts: `dev`, `build`, `test`, `check:svelte`, `check:typescript`, `lint:p`.
  - Validate minimal set: `check:typescript`, `check:svelte`, `test`.

- CLI (`cli`)
  - Tech: TypeScript, Vite build; depends on `@immich/sdk`.
  - Validate: `build`, `lint`, `test`.

- Machine Learning (`machine-learning`)
  - Tech: Python 3.10+, managed with `uv` (see `machine-learning/README.md`).
  - Extras: `cpu`, `cuda`, `openvino`, `armnn`, `rknn` via `pyproject.toml`.
  - Run in Docker for parity; see `docker/docker-compose.yml` (service `immich-machine-learning`).

- E2E (`e2e`)
  - Tech: Vitest + Playwright; uses its own compose stack `e2e/docker-compose.yml`.
  - Start: `make e2e`; tests: `pnpm --filter immich-e2e run test` and `test:web`.

- Docker (`docker`)
  - Dev: `docker/docker-compose.dev.yml` (used by `make dev`).
  - Prod: `docker/docker-compose.prod.yml` (local images) or `docker/docker-compose.yml` (release images).
  - Hardware acceleration: see `docker/hwaccel.*.yml` and docs.
  - Env example: `docker/example.env`.

OpenAPI Workflow

- Recommended: `make open-api` (builds server, syncs spec, generates Dart + TS SDKs)
- Typescript only: `make open-api-typescript`
- Manual steps (if needed):
  1) Build server: `pnpm --filter immich build`
  2) Sync OpenAPI: `pnpm --filter immich run sync:open-api`
  3) Generate via `open-api/bin/generate-open-api.sh`

Testing Strategy

- Prefer targeted tests:
  - Server changes: `pnpm --filter immich run test` (or `test:medium` if relevant).
  - Web changes: `pnpm --filter immich-web run test`.
  - CLI changes: `pnpm --filter @immich/cli run test`.
  - E2E flows: `make e2e && pnpm --filter immich-e2e run test` and `test:web`.
- Only run broader checks when needed or before finalization: `make check-all`, `make test-all`.

Coding Conventions

- TypeScript/JS: Follow existing ESLint and Prettier configs in each package.
- Svelte: Follow established component structure and conventions in `web/src`.
- NestJS: Organize by domain modules and services; keep DTOs in `server/src/dtos`.
- SQL: Use Kysely; sync and format SQL via `make sql` when relevant.
- Python (ML): Keep dependency changes inside `pyproject.toml` and regenerate `uv.lock` via `uv lock` when needed.
- SDK: Treat `open-api/typescript-sdk` as generated code; do not hand-edit `build/` outputs.

Docker & Environment

- Use `make prepare-volumes` or `make dev` to initialize volumes with proper ownership.
- Configure `.env` in `docker/` or use `docker/example.env` as a baseline.
- Core services: Postgres, Redis/Valkey, Server, Machine Learning, Web.
- Hardware acceleration: enable via `hwaccel.*.yml` extension files; consult docs.

When Modifying Dependencies

- Prefer existing workspace packages; keep lockfiles (`pnpm-lock.yaml`, `uv.lock`) in sync.
- Avoid introducing heavy or novel dependencies without a clear need.
- For Node: use `pnpm` and respect `pnpm-workspace.yaml` overrides (notably `sharp` is pinned to `^0.34.4`).
- For ML: use `uv` and update `pyproject.toml` + `uv.lock`.

File Touch Rules

- Do not rename or move files unless it’s part of the task.
- Avoid adding new top-level packages without discussion.
- Keep exports stable unless the change is required.
- Only edit generated SDK files when regenerating via OpenAPI workflow.

Review & Verification Checklist (per change)

- Build succeeds for affected packages.
- Lint/format pass for affected packages.
- Unit tests pass for affected packages.
- E2E passes for user-facing flows when relevant.
- OpenAPI regenerated if API changed (rebuild server + sync + generate).
- No unrelated diffs in git.

Privileges & Tooling

- The agent has sudo and network access and may:
  - Install OS packages (apt/yum/apk) when needed.
  - Install Node/Python tooling.
  - Use Docker and Docker Compose to run or build environments.
  - Perform limited web research for solutions (cite source in discussions if used).

Communications & Process

- Keep messages concise and actionable.
- Before running grouped commands, briefly state intent.
- For multi-step or ambiguous work, maintain a plan and update it as steps complete.

Escalation & Safety

- Avoid destructive operations (e.g., removing volumes, dropping schemas) unless explicitly required.
- Prefer reversible changes and make backups when touching data-related paths.

Notes on Recent Changes (v2.x)

- Node updated to 22.20.0; pnpm to 10.18.1 (mise).
- `sharp` pinned to `^0.34.4` across workspace; ensure optional runtime deps are present in deploy builds.
- S3 storage support wired throughout server (streaming reads, staged writes, path joins, move/copy semantics).
- Database images updated to VectorChord 0.4.x (dev) with pgvectors 0.2.0; E2E uses VectorChord 0.3.x image.
- OpenTelemetry metrics expanded; enable via `IMMICH_TELEMETRY_INCLUDE`.
