# Codex Operating Manual (codex.md)

## Mission & Mindset
Operate as a pragmatic teammate: keep diffs minimal, respect existing patterns, and verify every change you touch. Step back frequently to confirm the architecture (Nest controllers/services, Svelte routes/stores, Flutter blocs, ML FastAPI endpoints, etc.) before implementing anything new.

## Working Rhythm
1. **Reconstruct context** – Read `continue.md`, issue/task text, and any linked files.
2. **Clarify the goal** – Restate scope in your head/output so you target the right files.
3. **Plan** – For any task beyond a trivial edit, create a 3–7 step plan via the plan tool and keep exactly one step `in_progress`. Update it as you complete steps.
4. **Explore intentionally** – Use `rg`, `ls`, and targeted `sed -n` ranges (≤250 lines) to inspect code; avoid dumping large files.
5. **Implement surgically** – Use `apply_patch` for file edits when feasible. Match existing style, imports, and naming; do not reformat untouched code or shuffle files.
6. **Validate locally** – Run the smallest practical checks/tests that cover your change (see validation table below). Explain any skipped checks.
7. **Summarize & log** – Report what changed, where, and why; cite tests. Append decisions/commands/next steps to `continue.md` before yielding.

## Tooling & Environment
- Node 24.11.0 (mise/Volta) • pnpm 10.19.x • TypeScript 5.x across packages
- Flutter 3.35.7 for `mobile/`
- Python 3.10+ with `uv` for `machine-learning/`
- Docker, Docker Compose, Terragrunt/OpenTofu (deployment) available
- Network + sudo allowed; only invoke when needed and mention why.

## Repository Orientation
- pnpm workspaces: `server` (Nest API), `web` (SvelteKit), `cli` (TS CLI), `open-api` + `open-api/typescript-sdk`, `e2e`, `docs`, `.github`.
- Other key roots: `mobile` (Flutter), `machine-learning` (FastAPI/onnxruntime), `docker`, `deployment`, `design`, `i18n`, `readme_i18n`, `fastlane`, `misc/release`, `install.sh`, and `continue.md`.
- Respect generator outputs (OpenAPI SDK, pigeon bindings, drift schemas, ML assets) and lockfiles (`pnpm-lock.yaml`, `uv.lock`, `pubspec.lock`).

## Commands & Workflows
- Install (no docs): `pnpm -r --filter '!documentation' install`. Targeted install: `pnpm --filter <pkg> install --frozen-lockfile` or `make install-<pkg>`.
- Build/test per package:
  - Server: `pnpm --filter immich run build|test|test:medium|check|lint`.
  - Web: `pnpm --filter immich-web run build|check:typescript|check:svelte|test`.
  - CLI: `pnpm --filter @immich/cli run build|lint|check|test`.
  - SDK: `pnpm --filter @immich/sdk run build` (after running `make open-api`).
  - Docs: `pnpm --filter documentation run build|format` (use `docs:start` via mise for local preview).
  - E2E: `make e2e` → `pnpm --filter immich-e2e run test`/`test:web`.
  - Machine-learning: `uv sync`, `uv run pytest`, `uv run ruff check`, `uv run black --check`, `uv run mypy`.
  - Mobile: `flutter pub get`, `flutter test`, `dart analyze`, `dcm analyze`, pigeon/i18n generators via `mise run mobile:*`.
- Dev/Prod stacks: `make dev`, `make dev-down`, `make prod`, `make prod-down` (Compose files in `docker/`).
- OpenAPI regen: `make open-api` (full) or `make open-api-typescript` (TS only). Manual fallback: server build → `pnpm --filter immich run sync:open-api` → `open-api/bin/generate-open-api.sh`.
- SQL sync: `make sql` (`pnpm --filter immich run sync:sql`).
- Release helpers: scripts in `misc/release/`; infrastructure via `mise run tg:*` / `tf:*`.

## Validation Matrix
Run the smallest set covering touched code:
| Scope | Commands |
| --- | --- |
| Server | `pnpm --filter immich run test` (+ `check`/`lint`/`test:medium` if needed) |
| Web | `pnpm --filter immich-web run check:typescript`, `check:svelte`, `test` |
| CLI | `pnpm --filter @immich/cli run lint`, `test`, optionally `check` |
| SDK | `pnpm --filter @immich/sdk run build` |
| Machine-learning | `uv run pytest` plus lint/type checks relevant to the change |
| Mobile | `flutter test` or `dart analyze`/`dcm` depending on touched code |
| Docs | `pnpm --filter documentation run build` or `format` |
| E2E | `pnpm --filter immich-e2e run test` / `test:web` (after `make e2e`) |
Document skips with a short reason.

## Implementation Notes
- Prefer existing abstractions: server logic belongs in services/repositories, not ad-hoc helpers; web data access goes via existing stores/services; CLI commands follow the commander wrappers already in `cli/src/commands`.
- When changing API contracts, regenerate OpenAPI + SDK and update all consumers (web, CLI, mobile, docs) as needed.
- Storage/S3 changes often require both backend (`server/src/storage/**`) and media handling utilities—verify against S3/local modes.
- Translation updates should flow through `/i18n` JSON (sorted) and Flutter’s generated loaders; avoid manual edits to generated localization artifacts.
- Use `rg` for search, `node --loader ts-node` style commands only if already established. Keep chunked file views ≤250 lines.
- No mass formatters unless package formatting is the actual task; never edit `dist/`, `build/`, or other compiled outputs.

## Communication & Summaries
- Final responses: start with the core change, cite files with `path:line`, list validation commands/results, and call out follow-up steps if any remain.
- Provide actionable suggestions only when there are natural next steps. Avoid filler.
- If a command must run with sudo/network, state the intent before executing (and only do so when necessary).

## Memory & Hand-off
- Treat `continue.md` as the durable log. After meaningful work record: date/time, summary, files touched, commands (with purpose/outcome), open questions, and next steps. Read it whenever you resume work.

## Safety & Escalation
- Never revert user changes or run destructive commands (`git reset --hard`, wiping volumes) unless explicitly asked.
- If repo state looks wrong (unexpected dirty files, failing installs unrelated to your task), stop and ask how to proceed.
- Use sudo/network installs only when required for builds/tests; mention the reason in your notes/summary.

Keeping to this manual ensures every contribution remains traceable, pattern-aligned, and easy for maintainers to review.
