# Pickleball Social Session Manager

Web app for pickleball clubs. Hosts run social sessions (setup, live court rotation, final report); players only use a public phone check-in page (`/t/<tag>`, opened by a per-host NFC sticker or QR code). A pure TypeScript engine recommends who plays next using continuous weighted fairness scoring. The live session is an append-only action log. Plan: `docs/plans/session-manager-mvp.md`. Roadmap: `docs/ROADMAP.md`. Decisions: `docs/decisions/`. UI rules: `DESIGN.md`.

@DESIGN.md

## Stack

- Next.js 16.4 (App Router, server actions), React 19.3, Tailwind CSS 4 (tokens in `src/app/globals.css` `@theme`), Outfit via `next/font`
- TypeScript 5.9 pinned (not 7: typescript-eslint doesn't support it yet)
- Supabase (Postgres + Auth) via `@supabase/supabase-js` + `@supabase/ssr`. No ORM. Generated types
- Tests: Vitest + fast-check (simulations) + `vitest bench`, Playwright (e2e), pgTAP (database)
- Sentry (`@sentry/nextjs`), production only
- pnpm 12, Node 24 LTS

## Environment

- This machine's system Node is 26. Prefix every command with `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`
- Docker Desktop is installed but its CLI isn't on PATH: also prefix `/Applications/Docker.app/Contents/Resources/bin`
- Supabase CLI is a devDependency: use `pnpm exec supabase`. The local stack needs Docker running
- Next 16.4's own docs ship in `node_modules/next/dist/docs/`; check them for APIs changed since your training data

## Commands

`pnpm dev` · `build` · `start` · `lint` · `typecheck` · `test` · `test:watch` · `bench` · `e2e` · `format` · `format:check` · `db:start` · `db:stop` · `db:reset` · `db:types`

## Directory conventions

- `src/engine/` is PURE: no react, next or supabase imports, no `Date.now()`, no `Math.random()`. Time and a seeded RNG are passed in
  - `src/engine/schedule/` makes decisions; `src/engine/report/` measures fairness. The scheduler never imports `report`
- `src/lib/supabase/` holds the Supabase clients (browser, server)
- `supabase/migrations/` is the only place schema changes happen
- `e2e/` holds Playwright tests

## Data and architecture rules

- RLS on every table. Only users in the `hosts` allow-list can read; the only public surface is the `/t/<tag>` check-in page and the `submit_checkin` / `search_checkin_names` functions
- Clients never insert into `session_events` (INSERT revoked). Flow: server action → validate with the engine (`applyEvent`) → one Postgres function (single transaction)
- Every action carries a client-generated `event_id` (idempotency, looked up before the sequence check) and `expected_seq`
- The log is append-only. Undo appends a compensating action targeting a `target_seq`; rows are never edited or deleted. Undo actions are not undoable
- State is derived: `state = replay(events)`; recommendations are derived, never stored
- IDs are UUIDs. Never use names or list positions as identifiers. Snapshot names into session data (`session_participants`, `config_snapshot`, `matches`)
- Sessions are independent: scheduling uses only the current session's data, with no cross-session state
- No hard fairness rules: all objectives feed one bounded score. Hard constraints are validity only (one court per player, exactly k distinct players, host locks)
- Polling (5 s), not Realtime
- Secrets never in client bundles. Dev and prod use separate Supabase projects; CI uses a local Supabase stack, never a hosted one
