# Pickleball Social Session Manager

Web app for pickleball clubs. Hosts run social sessions (setup, live court rotation, final report); players only use a public phone check-in page (`/t/<tag>`, opened by the social's NFC sticker or QR code). A pure TypeScript engine recommends who plays next using continuous weighted fairness scoring. The live session is an append-only action log. Original plan: `docs/plans/session-manager-mvp.md`; its membership model is superseded by `docs/plans/session-only-participants.md` and ADR 0004. Roadmap: `docs/ROADMAP.md`. Decisions: `docs/decisions/`. UI rules: `DESIGN.md`.

@DESIGN.md

## Stack

- Next.js 16.4 (App Router, server actions), React 19.3, Tailwind CSS 4 (tokens in `src/app/globals.css` `@theme`), Outfit via `next/font`
- TypeScript 5.9 pinned (not 7: typescript-eslint doesn't support it yet)
- Supabase (Postgres + Auth) via `@supabase/supabase-js` + `@supabase/ssr`. No ORM. Generated types
- Tests: Vitest + fast-check (simulations) + `vitest bench`, Playwright (e2e), pgTAP (database)
- Sentry (`@sentry/nextjs`), production only
- QR codes: `uqr` (zero dependencies), rendered to SVG on the server in `src/server/checkin/checkinLink.ts`
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

- Socials (`docs/decisions/0003-socials-and-data-isolation.md`): an installation holds independent socials; one login = one social (`hosts.social_id`, immutable), as `manager` or `host`. Managers also invite/remove hosts, add courts and rename the social. No venue concept; nothing is shared between socials
- RLS on every table. A host reads only their own social's rows (`social_id = private.current_social_id()`; `authenticated` has SELECT only). The only public surface is the `/t/<tag>` check-in page (one tag per social, `socials.checkin_tag`), whose server code calls `get_checkin_page` / `submit_checkin`
- Players are session-only snapshots: no membership directory, member-device links or cross-session identity. First name, last name and Beginner/Intermediate/Advanced level are required for public check-in and host adds; normalised full names are unique per session. Public name clashes stay private to the host
- Check-in cookies are independent random session-specific tokens; only their SHA-256 reaches SQL. Ignore the legacy universal cookie. Submit binds the rendered session UUID and SQL locks/revalidates it and the tag-social before any write; turnover clears the form and reloads. Historical `isGuest` payload fields are accepted and ignored by replay
- All writes are server-only (`docs/decisions/0002-server-only-writes.md`): verify the user with `auth.getUser()` and their role, then write with the service-role client (`src/lib/supabase/admin.ts`), passing `p_actor_user_id`. Write functions are executable by `service_role` only; `anon` can execute nothing. They derive the actor's social from `p_actor_user_id` (never from the caller) and only touch its rows
- Review checklist: every admin-client query filters `.eq("social_id", host.socialId)` and every insert sets `social_id`; `session_events` and `matches` are scoped by a join to `sessions`
- Session flow: server action → validate with the engine (`applyEvent`) → one Postgres function (single transaction), via `src/server/submitSessionAction.ts`
- Every action carries a client-generated `event_id` (idempotency, looked up before the sequence check) and `expected_seq`
- The log is append-only. Undo appends a compensating action targeting a `target_seq`; rows are never edited or deleted. Undo actions are not undoable
- State is derived: `state = replay(events)`; recommendations are derived, never stored
- IDs are UUIDs. Never use names or list positions as identifiers. Snapshot names into session data (`session_participants`, `config_snapshot`, `matches`)
- Sessions are independent: scheduling uses only the current session's data, with no cross-session state
- No hard fairness rules: all objectives feed one bounded score. Hard constraints are validity only (one court per player, exactly k distinct players, host locks)
- Polling (5 s), not Realtime
- Secrets never in client bundles. Dev and prod use separate Supabase projects; CI uses a local Supabase stack, never a hosted one
