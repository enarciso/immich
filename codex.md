# Codex Operating Manual

## Mission
Operate as a pragmatic teammate: keep diffs small, mirror existing patterns, and verify what you touch. Step back regularly to confirm alignment with established layers before adding code.

## Working Rhythm
1. Rebuild context: read `continue.md`, the task, and relevant files/instructions.
2. Clarify scope: decide which package(s) and layers are involved.
3. Plan (3–7 steps) with exactly one `in_progress` step; update the plan as you work.
4. Explore intentionally: prefer `rg`, targeted `sed -n` ranges (≤250 lines), and directory lists over large dumps.
5. Implement surgically: use `apply_patch`, match local style/imports, avoid touching unrelated lines or formatting.
6. Validate at the smallest level that covers the change; note any skipped checks with reasons.
7. Summarize and log: cite files with `path:line`, list tests run/skipped, and append decisions/commands/next steps to `continue.md`.

## Pattern Guardrails
- Server: keep logic in services/repositories/DTOs; reuse existing validators/config flows; migrations via `dist/bin/migrations.js`; Kysely in `queries/`/`schema/`.
- Web: keep data flows consistent with existing stores/routes; use `@immich/sdk` + `@immich/ui`; sort `i18n/*.json` only when translations change.
- CLI: new behavior belongs in `cli/src/commands` with commander patterns and shared helpers in `queue.ts`/`utils.ts`.
- Mobile & ML: follow Flutter Riverpod/bloc patterns and FastAPI router/service layouts; regenerate pigeon/i18n or keep `uv.lock` in sync when deps shift.
- E2E/Docs/Plugins: maintain current test/layout patterns; treat plugin `dist/`, SDK builds, OpenAPI outputs, drift/pigeon files, and docs OpenAPI copy as generated.
- API contract changes must be followed by OpenAPI + SDK regeneration and updates to all consumers (web/CLI/mobile/docs).

## Commands & Workflows (quick reference)
- Install (no docs): `pnpm -r --filter '!documentation' install`; targeted: `pnpm --filter <pkg> install --frozen-lockfile`.
- Dev/prod stacks: `make dev` / `make dev-down`; `make prod` / `make prod-down`; attach via `make attach-server`.
- OpenAPI: `make open-api` (full) or `make open-api-typescript`.
- SQL sync: `make sql`.
- Tests/build by package:
  - Server `immich`: `pnpm run test` (add `check`/`lint`/`test:medium` as needed).
  - Web `immich-web`: `pnpm run check:typescript`, `check:svelte`, `test`, `build`.
  - CLI `@immich/cli`: `pnpm run lint`, `check`, `test`, `build`.
  - SDK `@immich/sdk`: `pnpm run build` after regen.
  - E2E: `make e2e` → `pnpm --filter immich-e2e run test` / `test:web`.
  - Docs: `pnpm --filter documentation run build` or `format`.
  - Machine-learning: `uv sync`; `uv run pytest` + lint/type checks.
  - Mobile: `flutter pub get`; `flutter test`; `dart analyze` / `dcm analyze`; regen via `mise run mobile:*`.
  - Plugins: `pnpm --filter plugins run build` when plugin code changes.
- i18n sorting only when needed: `pnpm --filter immich-web run format:i18n` or `mise run i18n:format`.

## Validation Rules
Run the smallest set covering touched code (see matrix above) and record skipped checks with a short reason. Do not broaden scope unnecessarily.

## Change Management
- Use `rg` for search; avoid multi-thousand-line outputs.
- Keep edits in the existing layer; do not reorganize files unless required by the task.
- Avoid mass formatting or dependency changes unless explicitly requested; update lockfiles immediately when manifests change.
- Treat generated assets as read-only; regenerate instead of hand-editing.

## Communication
- Final responses lead with what changed and why, citing `path:line`; include tests run/skipped.
- Offer concise next-step suggestions only when there is a clear action a maintainer might want.
- No destructive commands or reverting user work unless explicitly instructed; if repo state looks off, pause and ask.

## Logging & Safety
- Update `continue.md` after meaningful work (summary, files, commands, decisions, next steps).
- Mention any use of sudo/network and why it was needed.
- If instructions conflict, stop and resolve before proceeding.
