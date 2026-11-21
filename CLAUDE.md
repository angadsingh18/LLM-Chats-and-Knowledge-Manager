# AI Manager: context for Claude

A unified AI workspace: web app + Chrome MV3 extension + Node/TS backend. It unifies conversations across AI providers and accounts (ChatGPT and Claude first), organizes them, and will add a source-cited knowledge layer and BYOK multi-model comparison.

Read only when needed (both are long):
- `PROJECT_SPEC.md`: what and why. Roadmap phases, open decisions OD1–OD27 in §20.
- `TECHNICAL_GUIDE.md`: how it's built, step by step. Latest Build Log entry = current state.

## Stack
pnpm workspaces monorepo, TypeScript strict. `apps/api` Fastify 5 modular monolith (`src/modules/*` plugins under `/v1/*`) + Drizzle ORM + `pg`, on Neon Postgres. `apps/web` Vite + React 19 + Tailwind v4 + React Router + TanStack Query. `apps/extension` WXT (MV3). `packages/schemas` shared Zod, `packages/provider-adapters` (`PageAdapter`/`Normalizer` interfaces + registry), `packages/ui`.

## Run / verify (Windows, run from repo root)
- API: `pnpm --filter @ai-manager/api start` (port 3001; NOT watch mode, restart after changes; `dev` watches). Web: `pnpm dev:web` (port 5173, proxies `/v1` to the API).
- Checks (integration, real Neon DB, create/delete their own test users): `pnpm --filter @ai-manager/api auth:check` (36), `ingest:check` (49), `db:check`. Also `pnpm typecheck`.
- Migrations: `pnpm --filter @ai-manager/api db:generate` then `db:migrate`. Hand-written SQL files `0002_*` and `9999_rls_and_fts.sql` also run, in name order.
- If port 3001 is stuck after stopping a task, the old `node` child survived. Find it with `Get-NetTCPConnection -LocalPort 3001` and stop that pid.

## Rules that matter
- **Every query on user data goes through `withUser(userId, tx => …)`** (`db/client.ts`). It sets `SET LOCAL ROLE aimanager_app` + `app.user_id` so Postgres RLS enforces isolation. Only auth code uses plain `db` (users/sessions/pairing tables are outside RLS and denied to `aimanager_app`).
- New user-data tables need: a `user_id` column, an RLS policy, and explicit grants to `aimanager_app` (no default privileges are set).
- Hand-written SQL uses DB column names, not Drizzle property names (`firstCapturedAt` is column `created_at`).
- Auth: Google OAuth (arctic) → own server-side sessions, only SHA-256 token hashes stored. Cookie `aim_session` for web (state-changing requests need `Origin == WEB_ORIGIN`); Bearer tokens with scopes (`ingest`/`read`/`suggest`) for the extension via device-code pairing.
- Ingestion is idempotent (upsert keys `(provider_account_id, external_id)` and `(conversation_id, ordinal)`, message `content_hash`); it never deletes.
- Never print or log values from `.env` (Google secret, Neon URLs); check presence/length only. `.env` is gitignored, and `samples/` (real provider exports) is too. Never log request bodies (conversation content).
- **After every implementation step, update `TECHNICAL_GUIDE.md`** (Build Log entry, file map, API reference, testing notes, status line) and say honestly what is not verified.
- Don't build later-phase features early; follow the spec's roadmap.

## Working with the user
They are learning the stack but are not a beginner. Be concise and direct, not patronizing. Explain before big changes. Answer their question first, then act. Don't re-run checks they've rejected.

## Status (2026-11-21)
Done: spec; monorepo scaffold; Neon DB + RLS; Google sign-in (verified live); sessions + extension pairing; accounts CRUD, idempotent ingestion, conversation list/search/detail (all API, tested); Settings → "Connected accounts" UI (add/rename/archive/delete); `/` is a landing page (sign-in card, or "Welcome back" + "Open AI Manager" button when signed in), the app lives at `/inbox`, `/chats`, `/import`, `/settings`, `/pair` (Step 5, documented in the guide; typechecked, user-testing it).

Blocked: ChatGPT/Claude **normalizers + import parsers** need the user's real export files (they're waiting on the export emails). Put them in `samples/` (gitignored).

Next (suggested): All Chats list with search + conversation view in the web app (optionally seed fake data), then normalizers/parsers when exports arrive, pg-boss minimal jobs, Vitest + adapter fixtures, real extension adapters (against saved HTML fixtures), load the extension in Chrome, data export/delete endpoints.

Known gaps: web UI beyond Settings/Pair is placeholder; extension not yet loaded in Chrome; rate limiting is in-memory; ordinals for partial captures are the extension adapters' responsibility.
