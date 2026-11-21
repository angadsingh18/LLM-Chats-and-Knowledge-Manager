# TECHNICAL_GUIDE.md — How AI Manager Is Built (living document)

> **Purpose:** A running, technical explanation of everything built in this project: what each piece of code does, which technologies we use, why, and how the parts connect. `PROJECT_SPEC.md` says *what* we're building; this file says *how it works in code*.
>
> **Maintenance rule:** After every implementation step, a new entry is appended to the [Build Log](#4-build-log) and the stack, file map and concept sections are updated.
>
> **Current status:** Step 5 done — accounts CRUD, idempotent ingestion and conversation list/search/detail are built and tested against the real database (Step 4); Settings has an accounts UI and `/` is now a landing page (Step 5). Real Google sign-in works (verified by hand). Still to come: All Chats list + conversation view, ChatGPT/Claude normalizers and import parsers (blocked on the user's export files), real extension adapters.

---

## 1. The Big Picture in One Page

```
AI site tab ──(content script reads page)──► Extension service worker ──HTTPS──► Fastify API
                                                                                    │
                      Web app (React) ◄───────────── HTTPS ─────────────────────────┤
                                                                                    ▼
                                                              PostgreSQL (rows + full-text + vectors)
                                                                                    ▲
                                                           Background worker (pg-boss jobs):
                                                           chunk → embed → categorize → extract insights
```

Flow: the extension captures a conversation → the API validates and normalizes it into a provider-independent shape → it is saved idempotently → background jobs index it → the web app and extension query it → (later phases) the knowledge module retrieves messages and an LLM synthesizes an answer where every claim cites a real message.

**What exists today (Step 1):** every box in the top row exists as a compiling, runnable skeleton. The database schema and RLS policies are written as SQL. The pg-boss worker box is not built yet.

---

## 2. Technology Glossary

| Technology | What it is | Why we chose it | Where used (as of Step 1) |
|---|---|---|---|
| **pnpm workspaces** | Package manager with a monorepo feature; packages reference each other as `workspace:*` | One repo, shared code, fast installs, strict dependency isolation | `pnpm-workspace.yaml`, every `package.json` |
| **TypeScript (strict)** | JavaScript plus static types | Shapes (messages, captures) are checked at compile time and shared across API, web, extension | `tsconfig.base.json`, all packages |
| **Zod** | Runtime schema validation that also infers TS types | One definition validates API input and gives the TS type | `packages/schemas`, `apps/api/src/config.ts`, ingestion route |
| **Fastify 5** | Node HTTP framework with a plugin system | Each module is an encapsulated plugin = a boundary we can extract later; fast; good validation story | `apps/api/src/app.ts`, `modules/*` |
| **pino** | JSON logger (built into Fastify) | Structured logs; we redact the Authorization header and never log bodies | `apps/api/src/app.ts` |
| **PostgreSQL on Neon** | Managed serverless Postgres (scale-to-zero, branching). Project `damp-hill-24018838`, branch `production`, region ap-southeast-1 | Docker isn't available locally; Neon gives Postgres + pgvector with no install. Only the `postgres` service is enabled (no Neon Auth, Data API, Functions, storage, AI Gateway, realtime) | `apps/api/src/db`, `neon.ts`, `.env` |
| **Neon CLI (`neon`)** | CLI for linking/deploying a Neon project and pulling env vars | Declarative `neon.ts` policy + `neon deploy` + `neon env pull` | root `neon.ts`, `.neon` link file |
| **Pooled vs direct connection** | Pooled URL (`-pooler`) goes through PgBouncer in transaction mode; direct URL talks to Postgres | Neon's guidance: pooled for app traffic, direct for migrations/session state | `config.ts`, `db/migrate.ts`, `drizzle.config.ts` |
| **Google OAuth 2.0 / OpenID Connect** | Authorization-code flow with PKCE; Google returns an ID token with `sub`, `email`, `email_verified` | No passwords to store; Google verifies the email | `modules/auth/index.ts` |
| **arctic** | Small OAuth client library (builds auth URL, exchanges code, decodes ID token) | We use the library for protocol details instead of hand-rolling it | `modules/auth/index.ts` |
| **@fastify/cookie** | Cookie parsing/setting for Fastify | HttpOnly session cookie | `app.ts`, auth module |
| **@fastify/rate-limit** | Per-IP request throttling (in-memory; `global: false`, opted in per route) | Slows brute-forcing of pairing codes and token endpoints | `app.ts`, auth routes |
| **Fastify `inject`** | Runs requests through the app in-process, no network port | Used by the auth integration test | `modules/auth/check.ts` |
| **PostgreSQL (local, docker-compose)** | Unused now | Kept as an optional local alternative; untested | `docker-compose.yml` |
| **Drizzle ORM + drizzle-kit** | Typed SQL query builder; kit generates SQL migrations from the TS schema | Close to SQL (needed for FTS/pgvector/RLS), unlike heavier ORMs. *Provisional pick for spec OD10* | `apps/api/src/db/schema.ts`, `drizzle.config.ts` |
| **node-postgres (`pg`)** | Postgres driver with connection pool | What Drizzle runs on | `apps/api/src/db/client.ts` |
| **Full-text search** | `tsvector` column + GIN index | Keyword search without a separate engine | `drizzle/9999_rls_and_fts.sql` |
| **pg_trgm** | Trigram extension for fuzzy matching | Typo-tolerant title search | `9999_rls_and_fts.sql` (index on `conversations.title`) |
| **pgvector** | Vector type and nearest-neighbor search | Semantic search later; extension is enabled now, no vector columns yet | `9999_rls_and_fts.sql`, Docker image `pgvector/pgvector:pg16` |
| **Row-Level Security** | DB-enforced per-row access policies | User isolation even if app code forgets a filter | `9999_rls_and_fts.sql`, `withUser()` in `db/client.ts` |
| **tsx** | Runs TypeScript directly in Node | Dev server and migration runner with no build step | `apps/api` scripts |
| **React 19** | UI library | Shared components across web and extension | `apps/web`, `apps/extension`, `packages/ui` |
| **Vite 6** | Dev server and bundler | Fast HMR; also what WXT builds on | `apps/web/vite.config.ts` |
| **Tailwind CSS v4** | Utility-first CSS, via the `@tailwindcss/vite` plugin | Fast, consistent UI; v4 needs only `@import "tailwindcss"` | `apps/web/src/index.css` |
| **React Router 7** | Client-side routing | Sidebar-driven navigation | `apps/web/src/App.tsx` |
| **TanStack Query** | Server-state cache for React | Caching and invalidation for list-heavy UI; provider wired in, unused yet | `apps/web/src/main.tsx` |
| **WXT 0.19** | Framework for building browser extensions | Generates the MV3 manifest from `entrypoints/`, handles content-script bundling, HMR. *Provisional pick for spec OD11* | `apps/extension` |
| **Chrome MV3** | Current extension platform | Required; service worker replaces the persistent background page | `entrypoints/background.ts` |
| **Content scripts** | JS injected into a page, isolated from page JS | Reads the AI site's rendered conversation | `entrypoints/*.content.ts` |
| *(not yet used)* | pg-boss, IndexedDB, shadcn/ui, Vitest, embeddings, RRF | Planned per spec | — |

---

## 3. Core Concepts Explained

### 3.1 Provider adapters (implemented as interfaces)
Each AI site has a different page structure and export format. Two interfaces in `packages/provider-adapters/src/types.ts` isolate that:
- **`PageAdapter`** runs in the browser. It knows one provider's DOM: `matchesUrl`, `detectAccount`, `extractConversation`, `isHealthy`.
- **`Normalizer`** runs on the backend. `normalize(raw)` converts that provider's payload into the common `NormalizedConversation`, and an optional `parseExport()` handles uploaded exports.

`registry.ts` keeps in-memory maps of both, so core code looks up adapters by provider id and never imports a provider directly. Adding a provider means writing one `PageAdapter`, one `Normalizer` and registering them.

### 3.2 Normalized schema (`packages/schemas`)
`NormalizedConversation` / `NormalizedMessage` (Zod) are the single provider-independent shape. Highlights:
- `contentParts` is a discriminated union (`text | code | image | citation | other`). The plain `content_text` used for search is derived from it.
- `partial: true` flags conversations captured from a virtualized DOM where only part of the thread was visible.
- Provider-specific leftovers go in `rawMetadata`, never in core fields.
- `CaptureBatch` is the envelope the extension and importers send to the API; `CaptureResult` is what comes back.

### 3.3 Idempotency (implemented in Step 4, `modules/ingestion/upsert.ts`)
The unique index `conversations_account_external_uq (provider_account_id, external_id)` and `messages_conv_ordinal_uq (conversation_id, ordinal)` let the same capture be applied any number of times with `INSERT … ON CONFLICT DO UPDATE` and produce no duplicates. Details of how Step 4 uses them:
- Each message has a `content_hash` (SHA-256 of role + structured parts). The upsert has `setWhere: messages.content_hash IS DISTINCT FROM excluded.content_hash`, so an unchanged row is not touched at all and isn't returned. Rows that *are* returned are either new or edited.
- To tell new from edited, the `RETURNING` clause includes `xmax = 0`. `xmax` is a hidden Postgres system column; it is 0 for a freshly inserted row and non-zero for a row rewritten by the upsert's UPDATE branch. That gives the per-conversation `newMessageCount` the extension uses for delta-sync. (It is an implementation detail of Postgres, not a documented contract, but is a widely used idiom.)
- Nothing is ever deleted by ingestion. A partial capture (virtualised DOM, only some messages visible) can therefore never shrink a stored conversation; `coalesce(excluded.x, existing.x)` stops it erasing title/url/timestamps; `is_partial` stays true only while every capture so far was partial.
- `message_count` and the conversation `content_hash` are recomputed from the stored rows after each conversation, not from the batch.

### 3.4 Row-Level Security and `withUser()`
Every user-owned table has `user_id`. In `9999_rls_and_fts.sql`, a loop enables and **forces** RLS on `provider_accounts`, `conversations`, `messages`, `attachments` with the policy:
`user_id = nullif(current_setting('app.user_id', true), '')::uuid`.
`withUser(userId, fn)` in `db/client.ts` opens a transaction and runs `set_config('app.user_id', …, true)` (transaction-local), so the policy sees the right user for every query inside. If a request forgets to set it, the setting is empty, the cast yields NULL, and **no rows match** (fail closed). Caveat: Postgres superusers bypass RLS, so the app must connect with a normal role in real deployments (to be handled in the auth/deploy step).

### 3.3b Why the migration is split in two
`drizzle-kit generate` produces `0000_*.sql` from `schema.ts`. Things Drizzle can't express (generated tsvector column, GIN indexes, extensions, RLS, seed rows) live in the hand-written `9999_rls_and_fts.sql`, which sorts last. `src/db/migrate.ts` is a tiny runner that applies `.sql` files in name order and records them in a `_migrations` table. The `fts` column is declared in `schema.ts` as a plain `tsvector` so TS knows it exists; the SQL file drops and re-adds it as `GENERATED ALWAYS AS (to_tsvector('simple', content_text)) STORED`. **Do not write to `fts`.**

### 3.5 Three data tiers, hybrid retrieval, citation verification (later phases)
Unchanged from the spec: L0 source / L1 index / L2 knowledge; keyword + vector search merged with Reciprocal Rank Fusion; every synthesized claim verified against supplied source ids. None of this is implemented yet.

### 3.8 Authentication model
**Identity:** Google-only sign-in. The user's identity key is Google's `sub` (stable), stored in `users.google_sub`; email is stored but never used as the key. Login requires `email_verified === true`. An optional `ALLOWED_EMAILS` env var restricts who may sign in.

**OAuth flow (`GET /v1/auth/google` → Google → `GET /v1/auth/google/callback`):** the server generates `state` and a PKCE `code_verifier`, stores both in short-lived HttpOnly cookies scoped to `/v1/auth/google`, and redirects to Google. On callback it checks `state` equals the cookie (CSRF/login-CSRF defence), exchanges the code using the verifier, decodes the ID token, upserts the user (`ON CONFLICT (google_sub)`), creates a session, sets the session cookie, and redirects to the web app. The redirect URI is the *web origin* (`http://localhost:5173/v1/auth/google/callback`) and Vite proxies `/v1` to the API, so the browser only ever talks to one origin and cookies are first-party.

**Sessions (`sessions` table):** a credential is a random 256-bit token (`aimw_…` web, `aime_…` extension). Only its SHA-256 hash is stored, so a database leak does not yield usable tokens (a fast hash is fine because the token is high-entropy). A session is valid if not revoked, not expired, and the user is not deleted. `last_seen_at` updates at most every 5 minutes. Revocation is immediate because every request checks the table (no JWT to outlive revocation).

**Two credential types, one guard (`modules/auth/guard.ts`):**
- *Web:* HttpOnly, SameSite=Lax cookie (`Secure` in production). Because cookies are sent automatically, state-changing cookie requests must also carry `Origin` equal to `WEB_ORIGIN` (otherwise 403), a second CSRF layer.
- *Extension:* `Authorization: Bearer` token with **scopes** (`ingest`, `read`, `suggest`). Bearer requests carry no ambient cookie, so no CSRF concern. `requireAuth({ kind, scope })` can require web-only (session management, approving pairings) or a scope (ingest needs `ingest`).

**Extension device-code pairing:** (1) extension `POST /extension/pair/start` gets a secret `deviceCode` (hashed in DB) and a short `userCode` (8 chars from an unambiguous alphabet, ~40 bits, 10-minute life); (2) it opens the web `/pair?code=…` page, where a *logged-in* user confirms the code (`/approve`, web-only, rate limited); (3) the extension polls `/poll` with the device code and receives a token exactly once (an atomic `UPDATE … WHERE status='approved'` claims it). The extension never sees Google credentials, and the user can revoke the token in Settings.

**Why auth tables are outside RLS:** a request's user is unknown until the session is looked up, so `users`, `sessions` and `pairing_requests` can't be guarded by the `app.user_id` policy. Instead the RLS-bound role `aimanager_app` is *denied* all access to them (migration `0002`), and they're only touched through the owner connection in auth code. Rule: user-data queries go through `withUser()`; auth code is the only place using the plain `db`.

### 3.7 MV3 service worker lifecycle
Chrome can terminate the service worker at any time. `background.ts` therefore keeps no state in variables. It registers a `chrome.alarms` timer (`flush-queue`, every minute) that will drive retries of the IndexedDB queue, because alarms survive worker restarts.

---

## 4. Build Log

### Step 0 — Specification (2026-11-15)
Wrote `PROJECT_SPEC.md` and this guide. Documentation only.

### Step 1 — Monorepo scaffolding (2026-11-16)
**Goal:** Stand up the whole Phase 1 skeleton so later steps only fill in logic. Spec refs: Phase 1 workstreams 1, 2 (schema), partial 4/5/7/8 as stubs.

**Provisional decisions made (reversible; spec §20 still open):** Drizzle (OD10), WXT (OD11), ChatGPT + Claude as first providers (OD6), `simple` FTS config (OD14), Tailwind without shadcn yet.

**Files created**

| Path | Purpose |
|---|---|
| `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.env.example` | Workspace root: scripts (`dev:api`, `dev:web`, `dev:ext`, `build`, `typecheck`), shared strict TS config, env template |
| `docker-compose.yml` | Postgres 16 with pgvector for local dev |
| `packages/schemas/src/{conversation,capture}.ts` | Zod schemas: normalized conversation/message, capture batch/result |
| `packages/provider-adapters/src/{types,registry}.ts` | `PageAdapter`, `Normalizer`, `RawCapture` interfaces and adapter registry |
| `packages/ui/src/ProviderBadge.tsx` | First shared React component (proves web + extension can share UI) |
| `apps/api/src/config.ts` | Zod-validated env; process exits at boot if config is invalid |
| `apps/api/src/app.ts`, `server.ts` | Builds the Fastify app, registers CORS and the four module plugins under `/v1/...`; `server.ts` listens |
| `apps/api/src/modules/{auth,providers,ingestion,conversations}/index.ts` | Module plugins. `providers` lists registered provider ids; `ingestion` validates a `CaptureBatch` and returns 400 on bad input or 501 on valid input (upsert not written yet); `auth` and `conversations` are stubs |
| `apps/api/src/db/schema.ts` | Drizzle schema: `users`, `providers`, `provider_accounts`, `conversations`, `messages`, `attachments` |
| `apps/api/src/db/client.ts` | `pg` pool, Drizzle instance, `withUser()` RLS helper |
| `apps/api/src/db/migrate.ts` | Minimal SQL migration runner (`pnpm --filter @ai-manager/api db:migrate`) |
| `apps/api/drizzle/0000_*.sql` | Generated tables/indexes/FKs |
| `apps/api/drizzle/9999_rls_and_fts.sql` | Extensions, generated `fts` column + GIN index, trigram index, provider seed, RLS policies |
| `apps/web/*` | Vite + React + Tailwind shell: sidebar (Inbox, All Chats, Import, Settings) with placeholder pages |
| `apps/extension/wxt.config.ts` | Manifest: permissions `storage`, `alarms`; host permission only for the API origin |
| `apps/extension/entrypoints/background.ts` | Service worker: receives `capture` messages, alarm for queue flush (both TODO bodies) |
| `apps/extension/entrypoints/{chatgpt,claude}.content.ts` | One content script per provider, matched only to that provider's hosts |
| `apps/extension/lib/runAdapter.ts` | Generic content-script runtime: `MutationObserver` + 1.5 s debounce, calls the adapter, sends result to the service worker, swallows errors |
| `apps/extension/adapters/{chatgpt,claude}.ts` | **Stub** `PageAdapter`s (return null). Real selectors will be written against saved HTML fixtures, not guessed |
| `apps/extension/entrypoints/popup/*` | React popup placeholder |

**How the pieces connect:** `apps/*` depend on `packages/*` via `workspace:*`, and the packages export TypeScript source directly (`"main": "./src/index.ts"`), so there is no separate build step for them. The API's ingestion route and the extension both import `@ai-manager/schemas`, so the wire format is defined in exactly one place.

**Key decisions & trade-offs**
- Packages export `.ts` source: simplest for a solo monorepo. Trade-off: every consumer's bundler must compile TS (all of ours do).
- Module plugins under `/v1/<module>` mirror the spec's module boundaries, so extracting one later is mechanical.
- Logging redacts the Authorization header and Fastify doesn't log bodies by default, which matters because bodies contain conversation text.
- RLS is created now, before any feature code, so every future query is written against it.
- pnpm 12 blocks dependency build scripts by default; `pnpm-workspace.yaml` allows `esbuild` (needed) and denies `spawn-sync`.

**How to run / verify (what I actually ran)**
- `pnpm install` then `pnpm typecheck`: all 6 packages pass.
- `pnpm --filter @ai-manager/api start`: `GET /health` → `{"status":"ok"}`; `GET /v1/providers` → `{"providers":[]}` (no adapters registered yet); `POST /v1/ingest/captures` with `{}` → 400 `invalid_capture` with Zod issues.
- `pnpm --filter @ai-manager/web build` and `pnpm --filter @ai-manager/extension build` both succeed; the extension output is `apps/extension/.output/chrome-mv3` (loadable via chrome://extensions → Load unpacked).
- To run the web app: `pnpm dev:web`. API needs a `.env` (copy `.env.example`; I already created one).

**Not verified yet:** The SQL migrations have **not** been run against a database. Docker isn't installed on this machine, so `docker-compose.yml` is untested. You'll need a local Postgres with the `vector` extension (Docker, or an installed Postgres + pgvector, or a hosted dev DB) before the next step. Nothing from the extension has been loaded into Chrome either.

**Concepts to understand:** §3.1–3.4, 3.7.

**What's next:** (a) get a Postgres running and apply migrations, (b) auth, (c) idempotent ingestion upsert + a real normalizer, (d) import parser, (e) dashboard queries.

### Step 2 — Neon database wired in (2026-11-18)
**Goal:** Put the schema on a real Postgres and prove the security model works. Covers Phase 1 workstream 2 (schema + RLS) verification.

**What was done (in order)**
1. `npm i -g neon@latest`. I first checked the package metadata (repo `neondatabase/neon-pkgs`, maintainer `neonteam`) before installing globally. CLI version 9.6.3.
2. `neon init -y --org-id … --project-id … --branch production --services postgres`: linked the repo to the existing Neon project (`.neon`), created `neon.ts` (declares only Postgres; `auth: false`), added `@neon/config` and `@neon/env` to the workspace root, and installed Neon's agent plugin/skills (Claude Code, VS Code, Copilot CLI, Kilo Code).
3. `neon login` needed a browser; it timed out the first time and succeeded when run by the user in their own terminal.
4. `neon config plan` → "No changes"; `neon deploy` → no changes needed, and it pulled `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `NEON_BRANCH`, `NEON_BRANCH_ID`, `NEON_FUNCTION_HOST_SUFFIX` into the existing `.env` (our original keys were preserved).
5. Wiring (code changes below).
6. `pnpm db:migrate` applied both migration files; `pnpm db:check` and a live API run verified everything.

**Files changed**

| Path | Change |
|---|---|
| `apps/api/src/db/migrate.ts` | Now uses its own `pg.Client` on `DATABASE_URL_UNPOOLED` (direct), runs each migration file in a transaction, and splits drizzle-kit's `--> statement-breakpoint` markers |
| `apps/api/drizzle.config.ts` | drizzle-kit uses the unpooled URL, falling back to `DATABASE_URL` |
| `apps/api/src/config.ts` | Adds optional `DATABASE_URL_UNPOOLED` |
| `apps/api/package.json` | Scripts load the root `.env` via `tsx --env-file=../../.env` (previously env had to be exported by hand); new `db:check` script |
| `apps/api/drizzle/9999_rls_and_fts.sql` | Appended: creates NOLOGIN role `aimanager_app` (`nobypassrls`), grants table privileges (providers read-only), grants it to the connecting role |
| `apps/api/src/db/client.ts` | `withUser()` now runs `SET LOCAL ROLE aimanager_app` before setting `app.user_id` |
| `apps/api/src/db/check.ts` | New end-to-end verification script (see below) |
| `apps/api/src/app.ts` | New `GET /health/db` (runs `select 1` through the pooled pool) |
| `.env.example`, `.gitignore` | Env template documents pooled/direct URLs; `.env.local` ignored |
| `neon.ts`, `.neon`, root `package.json` | Created/changed by `neon init` |

**How it works / key decisions**
- **Driver:** kept `node-postgres` (`pg`). Neon's installed skill recommends it for long-running Node servers (our Fastify app holds a pool across requests); `@neondatabase/serverless` is for serverless/edge runtimes and isn't needed.
- **Pooled for the app, direct for migrations:** PgBouncer transaction pooling doesn't preserve session state, so migrations use the direct URL. Our `withUser()` is safe on the pooler because `SET LOCAL` and `set_config(..., true)` only last for the transaction.
- **Why the `aimanager_app` role:** the connection role `neondb_owner` can create roles and may bypass RLS. Rather than trusting that, each user-scoped transaction drops to a role that cannot bypass RLS (`SET LOCAL ROLE`). This avoids managing a second credential. Trade-off: any code that queries user tables *outside* `withUser()` runs as the owner and is not isolated, so all user-data queries must go through `withUser()` (auth lookups are the likely exception and need care).
- **SSL:** the Neon URL has `sslmode=require&channel_binding=require`. `pg` treats `require` as full certificate verification and prints a deprecation-style warning about future semantics; harmless, and not silenced.
- `.env` is managed by `neon env pull`; do not hand-edit the Neon-written values.

**Verification (actual output)**
- `pnpm db:migrate`: `applying 0000_silent_doomsday.sql`, `applying 9999_rls_and_fts.sql`.
- `pnpm db:check` (connects as `neondb_owner` via the pooled URL): extensions `pg_trgm, pgcrypto, vector` present; providers seeded; user A sees own conversation; **user B sees nothing of user A**; **user B cannot insert rows as user A**; **no user context returns zero rows**; full-text search finds the message; test users cleaned up; `ALL CHECKS PASSED`.
- `npm run build` (runs `pnpm -r build`): web and extension build; `pnpm typecheck`: all 6 packages pass.
- Live API against Neon: `GET /health` → 200 `{"status":"ok"}`; `GET /health/db` → 200 `{"status":"ok","db":true}`; invalid `POST /v1/ingest/captures` → 400. API log contained no connection strings.

**Not wired (deliberately):** Neon Auth, Data API, Functions, Object storage, AI Gateway, Realtime. They aren't enabled and nothing in Phase 1 needs them. Declared services remain Postgres only.

**Not verified:** pgvector is only checked as an installed extension; no vector columns/queries exist yet. Neon's skill also describes a separate "Lakebase" vector/BM25 search offering; we are using standard pgvector + built-in full-text search as the spec says. The Neon plugin is installed into Claude Code, which I did not exercise.

**Concepts to understand:** §3.4 (RLS and `withUser()`), plus pooled vs direct connections (§2).

**What's next:** auth (users, sessions, extension pairing; must resolve how auth queries interact with RLS), then idempotent ingestion upsert + normalizers, import parsers, dashboard queries.

### Step 3 — Authentication (2026-11-18)
**Goal:** Real user accounts, sessions and extension pairing, with the security model from spec §14. Covers Phase 1 workstream 3.

**Decisions made (reversible):** Google-only sign-in (no passwords); own sessions on the `arctic` library rather than Better Auth (its own user/session tables would conflict with our `users` table and RLS design); device-code pairing for the extension (spec OD9 was open).

**Files**

| Path | Purpose |
|---|---|
| `apps/api/src/db/schema.ts` | `users` gains `google_sub` (unique), `name`, `avatar_url`; new tables `sessions`, `pairing_requests` |
| `apps/api/drizzle/0001_*.sql` | Generated: the above |
| `apps/api/drizzle/0002_auth_privileges.sql` | Revokes `aimanager_app` access to `users`, `sessions`, `pairing_requests`. **This fixed a real flaw**: the earlier blanket grant let an RLS-bound query read every user's email from the un-RLS'd `users` table. Found by checking the grants, then verified by test |
| `apps/api/src/config.ts` | New env: `GOOGLE_CLIENT_ID/SECRET`, `GOOGLE_REDIRECT_URI`, `ALLOWED_EMAILS`, `SESSION_TTL_DAYS` (30), `EXTENSION_TOKEN_TTL_DAYS` (90) |
| `apps/api/src/modules/auth/tokens.ts` | Token generation (`crypto.randomBytes`), SHA-256 hashing, user-code generator (`crypto.randomInt`) |
| `apps/api/src/modules/auth/sessions.ts` | `createSession`, `resolveSession`, `revokeSession` |
| `apps/api/src/modules/auth/guard.ts` | `requireAuth({kind, scope})` preHandler: bearer or cookie, CSRF Origin check, scope checks |
| `apps/api/src/modules/auth/index.ts` | Routes: Google login/callback, `/me`, `/logout`, `/sessions`, pairing start/approve/poll |
| `apps/api/src/modules/auth/check.ts` | 36-assertion integration test (`pnpm --filter @ai-manager/api auth:check`) |
| `apps/api/src/app.ts` | Registers `@fastify/cookie` and `@fastify/rate-limit` |
| `ingestion`, `conversations` modules | Now protected: ingest needs scope `ingest`, conversations needs `read` |
| `apps/web/src/lib/{api,useMe}.ts` | Same-origin fetch client; `useMe` hook (null on 401) |
| `apps/web/src/pages/{Login,Pair,Settings}.tsx`, `App.tsx` | Sign-in gate (resumes `/pair?code=` after login), pairing approval page, Settings with device list/revoke/sign-out |
| `apps/extension/lib/pairing.ts`, `entrypoints/popup/main.tsx` | Extension pairing client and popup UI; token kept in `chrome.storage.local` |
| `.env.example` | Documents the Google variables |

**Verification (actual)**
- `pnpm --filter @ai-manager/api auth:check` → 36 checks passed, including: no/garbage token → 401; Google redirect carries PKCE S256 + HttpOnly state cookie, redirect URI via web origin; mismatched/missing OAuth state → 400; cookie POST without/with foreign Origin → 403; only a SHA-256 hash is stored; full pairing lifecycle (pending → approve → token issued once → second poll 410); extension token can't manage sessions or approve pairings; read-only token refused on ingest; revoked token dead immediately; one user can't revoke another's session; expired and logged-out sessions → 401; rate limiting returns 429; RLS-bound role cannot read `users`.
- `db:check` still passes; `npm run build` and `pnpm typecheck` pass for all packages.
- Live API (no Google creds in `.env`): `/health/db` 200; `/v1/auth/google` → 503 `google_not_configured`; `/v1/auth/me` → 401; ingest without credential → 401.

**Not verified (be aware)**
- **Update (Step 4 session): the real Google sign-in now works** (verified by hand in the browser after fixing a `redirect_uri_mismatch`: the redirect URI must be listed under the OAuth client's *Authorized redirect URIs* exactly as `http://localhost:5173/v1/auth/google/callback`). The automated test still uses fake credentials, so the live exchange is only covered by that manual run.
- The web UI pages and extension popup compile but haven't been clicked through in a browser; the extension hasn't been loaded into Chrome.
- The `ALLOWED_EMAILS` allowlist and the 503 "not configured" path are not covered by the automated test (the 503 was seen live).
- The ID token is decoded without verifying its signature. That's acceptable because it arrives directly from Google's token endpoint over TLS in the code exchange (the OIDC-sanctioned case), but it's a deliberate shortcut to know about.
- Rate limiting is in-memory per process, so it doesn't work across multiple API instances.
- Extension pairing polls from the popup, so it stops if the popup closes (planned: move to the service worker).
- CSRF/cookie `Secure` behaviour in production isn't tested; there is no HTTPS locally.

**To enable Google sign-in:** Google Cloud Console → APIs & Services → OAuth consent screen (External, Testing; add your email as a test user) → Credentials → Create OAuth client ID → Web application → Authorized redirect URI `http://localhost:5173/v1/auth/google/callback` → put the client ID/secret in `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, and set `ALLOWED_EMAILS` to your email.

**Concepts to understand:** §3.8 (new), §3.4.

**What's next:** accounts CRUD, idempotent ingestion upsert with real normalizers, import parsers (needs your export files), dashboard queries.

### Step 4 — Accounts, idempotent ingestion, conversation list/search (2026-11-18)
**Goal:** The backend half of Phase 1's "capture → store → find" loop, so that once real data exists (extension or exports) it has somewhere correct to go. Normalizers and import parsers are deliberately **not** in this step: they need real export files, which haven't arrived yet.

**Files**

| Path | Purpose |
|---|---|
| `apps/api/src/modules/accounts/index.ts` | CRUD for labelled provider accounts. `GET` (scope `read`, so the extension can list them), `POST`/`PATCH`/`DELETE` web-session only. `PATCH {archived}` sets/clears `archived_at`; `DELETE` is a hard delete that cascades |
| `apps/api/src/modules/ingestion/content.ts` | `scrub` (strips NUL characters, which Postgres rejects in `text`/`jsonb`), `partsToText` (derives `content_text`, what FTS indexes), `hashMessage` |
| `apps/api/src/modules/ingestion/upsert.ts` | `ingestBatch(tx, userId, batch)`: the idempotent write (see §3.3). Throws `IngestError` mapped to 404/409/400 |
| `apps/api/src/modules/ingestion/index.ts` | `POST /v1/ingest/captures`: validates with the shared `CaptureBatch` Zod schema, runs `ingestBatch` inside `withUser`, rate-limited to 120/min |
| `apps/api/src/modules/conversations/index.ts` | `GET /` list + search + filters + keyset pagination; `GET /:id` detail with messages and attachments; `PATCH /:id` bookmark |
| `apps/api/src/modules/ingestion/check.ts` | 49-assertion integration test (`pnpm --filter @ai-manager/api ingest:check`) |
| `.gitignore` | Now ignores `samples/` (real exports may contain sensitive data) |

**How it works**
- *Isolation:* every route calls `withUser(req.auth.userId, …)`. Another user's account id is invisible under RLS, so ingesting into it returns `404 account_not_found`, indistinguishable from a nonexistent id (no existence leak).
- *Ingestion order inside one transaction:* verify the account (exists, not archived, provider matches) → upsert conversation → upsert messages in chunks of 500 rows (stays under Postgres' 65,535 bind-parameter limit) → replace attachments of new/edited messages → recompute `message_count` and conversation `content_hash`. A failure rolls the whole batch back.
- *Search:* `q` is matched two ways: a title `ILIKE` (LIKE wildcards in user input are escaped, so `%` is literal) or any message whose generated `fts` column matches `websearch_to_tsquery('simple', q)` (supports quoted phrases, `or`, `-exclude`). Each hit includes a `snippet` from the best-ranking message via `ts_headline`. Matches are wrapped in `[[ ]]`, **not** HTML tags, because message content is untrusted and the UI must not render it as HTML.
- *Pagination:* keyset, not offset. Sort key is `coalesce(updated_at_source, created_at)` then `id`; the cursor carries the last row's sort key **as text** (`::text`), because JavaScript `Date` only has millisecond precision and Postgres has microseconds; round-tripping through `Date` would skip or repeat rows.
- *Raw SQL vs Drizzle:* the list query is hand-written SQL via `tx.execute(sql\`…\`)` because of the lateral join and row-value comparison; everything else uses the Drizzle builder.

**Verification (actual)**
- `ingest:check` → 49 checks passed against Neon: auth/CSRF/scope gates; unknown provider, bad label, empty patch, empty batch, duplicate ordinals, provider mismatch → 400; another user's account → 404 for read, rename, delete and ingest; first capture inserts 2 messages, identical re-send inserts 0 and creates no duplicate conversation/message/attachment rows; same `externalId` under a different account is a separate conversation; an appended message counts as new (1) and an edited one is rewritten but not counted as new; partial re-capture changes nothing and keeps title/completeness; NUL characters are scrubbed; a 1,200-message conversation exercises chunking; search finds by content (with `[[ ]]` snippet) and by partial title, `%` is literal, no cross-user results; cursor pagination returns each of 4 conversations exactly once, bad cursor → 400; bookmark + filter; archived account → 409; deleting an account cascades to conversations and messages.
- `auth:check` (36) and `db:check` still pass; `typecheck` clean.

**Not verified / known limitations**
- **Ordinals for partial captures.** `ordinal` is the message's position in the thread. If the extension captures only the visible slice of a virtualised page, it must still supply the true positions; otherwise a slice would overwrite the wrong rows. This is the extension adapters' job and will need fixture tests.
- Messages are never deleted, so if a provider deletes or rewrites history, we keep the old rows beyond the new end. Reconciling edits/deletions is a later decision.
- `xmax = 0` is an undocumented-but-standard Postgres idiom (see §3.3).
- Search uses the `simple` text-search config (no stemming), so `index` won't match `indexes`. It's a provisional choice (spec OD14).
- Web UI for accounts/conversations is not built yet; the new endpoints are tested only through `inject`, not clicked through.
- The running API process must be restarted to pick up new routes (`start` is not in watch mode).

**Concepts to understand:** §3.3 (idempotency), §3.4 (RLS).

**What's next:** web UI (accounts + All Chats list + conversation view), then normalizers/parsers when the export files arrive, pg-boss jobs, Vitest, real extension adapters.

### Step 5 — Web: accounts UI and landing page (2026-11-21)
**Goal:** Make Step 4's accounts API usable from the browser, and stop the site dropping straight into Inbox. Frontend only; no API changes.

**Files**

| Path | Purpose |
|---|---|
| `apps/web/src/pages/AccountsSection.tsx` | "Connected accounts" block in Settings: list with provider + conversation count, add (provider select + label), inline rename (Enter saves, Esc cancels), archive/unarchive, delete with a confirm that states how many stored conversations go with it. TanStack Query mutations invalidate the `["accounts"]` query |
| `apps/web/src/pages/Settings.tsx` | Renders `AccountsSection` above the device list |
| `apps/web/src/pages/Home.tsx` | New landing page at `/`. Signed out: reuses `Login` (Google button). Signed in: avatar (or initial), "Welcome back, {first name}", email, an **Open AI Manager** button (link to `/inbox`) and "Not you? Sign out" |
| `apps/web/src/App.tsx` | Routing restructured: `/` → `Home` (no sidebar, always shown first); a `Shell` **layout route** (sidebar + `<Outlet/>`, shows `Login` if signed out) wraps `/inbox`, `/chats`, `/import`, `/pair`, `/settings`; unknown paths redirect to `/`. Inbox moved from `/` to `/inbox`; the sidebar title links back to `/` |

**How it works**
- A *layout route* is a route with an `element` but no `path`; its children render where it places `<Outlet/>`. That is how the sidebar is shared by several pages while `/` stays outside it.
- Signing in still redirects the browser to `/` (the API's `redirect(WEB_ORIGIN)`), so you now land on the welcome card and click through. The `postLogin` mechanism is unchanged: if you were headed to `/pair?code=…` when you had to sign in, `App` still resumes it from `/`.
- Avatar `<img>` uses `referrerPolicy="no-referrer"` because Google's avatar host can reject requests carrying a Referer.

**Verification (actual):** `pnpm --filter @ai-manager/web typecheck` clean; Vite serves `/`, `/inbox` and the new modules (HTTP 200); API routes the UI calls are covered by `ingest:check`.
**Not verified:** none of the new UI has been click-tested by me in a browser (no browser automation here); the user tests it. The Home → Inbox flow, sign-out from Home, and the Settings account actions are the things to try. No web test framework exists yet.

**What's next:** All Chats list + search + conversation view; normalizers/parsers once exports arrive.

---

## 5. File & Folder Map

```
.
├── PROJECT_SPEC.md / TECHNICAL_GUIDE.md
├── package.json, pnpm-workspace.yaml, tsconfig.base.json, docker-compose.yml, .env.example
├── apps/
│   ├── api/          Fastify backend (src/app.ts, modules/, db/, drizzle/ SQL)
│   ├── web/          React + Vite + Tailwind web app
│   └── extension/    WXT MV3 extension (entrypoints/, adapters/, lib/)
└── packages/
    ├── schemas/            Zod schemas shared by everyone
    ├── provider-adapters/  PageAdapter / Normalizer interfaces + registry
    └── ui/                 Shared React components
```
Not yet created from the spec: `packages/ai`, `packages/extension-core` (runtime currently lives in `apps/extension/lib`).

## 6. Data Model Reference
Tables present in Phase 1 (see `apps/api/src/db/schema.ts`): `users`, `providers` (seeded: chatgpt, claude, gemini, perplexity), `provider_accounts` (user-labelled), `conversations` (unique per account + external id), `messages` (unique per conversation + ordinal; `content_parts` JSONB + derived `content_text` + generated `fts`), `attachments` (metadata only). Categories, tags, projects, embeddings and knowledge tables arrive with their phases.

## 7. API Reference
| Method | Path | State |
|---|---|---|
| GET | `/health` | works |
| GET | `/health/db` | works; pings Neon through the pooled connection |
| GET | `/v1/providers` | works; returns registered adapter ids (currently empty) |
| GET | `/v1/auth/google`, `/v1/auth/google/callback` | Google OAuth login (503 until credentials are configured) |
| GET | `/v1/auth/me` | any credential |
| POST | `/v1/auth/logout` | web only |
| GET / DELETE | `/v1/auth/sessions`, `/v1/auth/sessions/:id` | web only; list / revoke own sessions |
| POST | `/v1/auth/extension/pair/start` | no auth, rate limited |
| POST | `/v1/auth/extension/pair/approve` | web only, rate limited |
| POST | `/v1/auth/extension/pair/poll` | no auth (device code); returns token once |
| GET | `/v1/accounts` | `read` scope or web session; own accounts + `conversationCount` |
| POST / PATCH / DELETE | `/v1/accounts`, `/v1/accounts/:id` | web only; create / rename, recolour, archive / hard delete (cascades) |
| POST | `/v1/ingest/captures` | `ingest` scope or web session; idempotent upsert; returns `{results:[{externalId, conversationId, newMessageCount}]}`; errors 400 (invalid, `provider_mismatch`, `duplicate_ordinal`), 404 `account_not_found`, 409 `account_archived`; 120/min |
| GET | `/v1/conversations` | `read` scope or web session; query `q`, `providerAccountId`, `providerId`, `bookmarked`, `limit` (≤100), `cursor`; returns `{conversations, nextCursor}` |
| GET | `/v1/conversations/:id` | detail with ordered messages + attachment metadata |
| PATCH | `/v1/conversations/:id` | web only; `{isBookmarked}` |

## 8. Testing & Verification Notes
`pnpm --filter @ai-manager/api auth:check` runs the 36-assertion auth suite (see Step 3) through Fastify `inject` against the real database, creating and deleting its own test users.
`pnpm --filter @ai-manager/api ingest:check` runs the 49-assertion accounts/ingestion/conversations suite (see Step 4), same approach, own users created and deleted.
`pnpm --filter @ai-manager/api db:check` runs a live integration script against the configured database (RLS isolation, WITH CHECK, fail-closed, full-text search; cleans up after itself). It is a script, not yet a Vitest suite.
No other automated tests yet. Planned next: Vitest, schema tests, RLS cross-tenant tests (need a DB), adapter fixture tests.

## 9. Troubleshooting & Lessons Learned
- **`ERR_PNPM_IGNORED_BUILDS` on install:** pnpm 12 won't run dependency build scripts unless allowed. Fix: `allowBuilds` in `pnpm-workspace.yaml` (the older `onlyBuiltDependencies` key did not take effect on this version).
- **`tsc` not found in library packages:** `typescript` was only a devDependency of the apps. Fix: added it to the workspace root.
- **`column c.first_captured_at does not exist`:** in `schema.ts` the property `firstCapturedAt` reuses the shared `createdAt()` helper, so the real column is `created_at`. Hand-written SQL must use database column names, not Drizzle property names.
- **`redirect_uri_mismatch` from Google:** the redirect URI sent by the app must be listed, character for character, under the OAuth client's *Authorized redirect URIs* (not "JavaScript origins"), and the change must be saved; it can take a few minutes to apply.
- **New routes return 404 on the running API:** `pnpm --filter @ai-manager/api start` doesn't watch files. Restart it (or use `dev`).
