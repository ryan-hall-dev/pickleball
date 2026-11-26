# Pickleball Social Session Manager

Web app for pickleball clubs. Hosts run social sessions (setup, live court rotation, final report); players only use a public phone check-in page (`/t/<tag>`, opened by the social's NFC sticker or QR code). A pure TypeScript engine provides the fixed wait-first doubles policy (`simple-social-v1`); the older weighted policy remains for legacy compatibility. The approved phone workflow and current progress are in `docs/plans/simple-social-mvp.md`. The live session is an append-only action log. Original plan: `docs/plans/session-manager-mvp.md`; its membership model is superseded by `docs/plans/session-only-participants.md` and ADR 0004. Roadmap: `docs/ROADMAP.md`. Decisions: `docs/decisions/`. UI rules: `DESIGN.md`.

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
- Players are session-only snapshots: no membership directory, member-device links or cross-session identity. First name, last name, male/female and Beginner/Intermediate/Advanced level are required for public check-in and host adds; normalised full names are unique per session, except people a host adds on the live screen (`allows_same_name`; UUID and event id tell them apart). Public name clashes stay private to the host
- Reclub roster (`docs/plans/reclub-to-court-v1.md`, migration `20261126090000`): the host pastes the list in the Arrivals section of Session setup (also under Check-ins on Live courts; no separate page); each line is a `session_roster_entries` row with its own UUID (same names are numbered, never merged). A phone claims an entry with no approval (one phone, one entry; the claim creates the participant, `allows_same_name`, and in a live session a `PlayerJoined` recorded with `actor_session_participant_id`, never a borrowed host id). One-word roster names have an empty last name. "That's my name" (`roster_transfer_requests`) moves a taken entry only when a host agrees. Walk-ins still need a host tap and can be closed (`sessions.walk_ins_open`)
- Check-in cookies are independent random session-specific tokens; only their SHA-256 reaches SQL. Ignore the legacy universal cookie. Submit binds the rendered session UUID and SQL locks/revalidates it and the tag-social before any write; turnover clears the form and reloads. Historical `isGuest` payload fields are accepted and ignored by replay
- All writes are server-only (`docs/decisions/0002-server-only-writes.md`): verify the user with `auth.getUser()` and their role, then write with the service-role client (`src/lib/supabase/admin.ts`), passing `p_actor_user_id`. Write functions are executable by `service_role` only; `anon` can execute nothing. They derive the actor's social from `p_actor_user_id` (never from the caller) and only touch its rows
- Review checklist: every admin-client query filters `.eq("social_id", host.socialId)` and every insert sets `social_id`; `session_events` and `matches` are scoped by a join to `sessions`
- Session flow: server action → validate with the engine (`applyEvent`) → one Postgres function (single transaction), via `src/server/submitSessionAction.ts`
- Every action carries a client-generated `event_id` (idempotency, looked up before the sequence check) and `expected_seq`
- The log is append-only. Undo appends a compensating action targeting a `target_seq`; rows are never edited or deleted. Undo actions are not undoable
- State is derived: `state = replay(events)`; recommendations are derived, never stored
- IDs are UUIDs. Never use names or list positions as identifiers. Snapshot names into session data (`session_participants`, `config_snapshot`, `matches`)
- Sessions are independent: scheduling uses only the current session's data, with no cross-session state
- Simple-policy selection prioritises the oldest feasible waiting players; variety cannot displace them outside the approved waiting bound. Valid doubles are four men, four women, or mixed teams with one of each. These rules apply to manual assignments too. Earlier weighted objectives and legacy events remain compatible with old logs
- simple-social-v2 (new sessions since Phase 2 of `docs/plans/reclub-to-court-v1.md`; v1 logs replay unchanged): Up next confirmations (`NextGroupSeatConfirmed`; a replacement starts unconfirmed, the rest keep theirs), open breaks with a reason (wait frozen), host move/swap (`NextGroupMoved`), "Close after this game" (`CourtCloseScheduled`, undoable). "Head to court" is derived (court free + four confirmed), never stored. The app's own writes (prepare a due court, refill an emptied seat, close a court after its game) are recorded with no actor (`actorId` "system"); a player's own taps (`src/server/checkin/playerActions.ts`) with `actor_session_participant_id`. Both go through `append_session_event_without_host`, which only allows those actions
- In v2, busy courts are lined up too (default as soon as the game starts, `upNextAfterMinutes` 0); the live screen has no prepare/call/release buttons, and Undo releases the groups in its way (`undoWithReleases.ts`)
- Free courts are prepared automatically on the server (`src/server/live/autoPrepare.ts`, run from `readLiveSession`): ordinary `NextGroupCalled` events with deterministic event ids, so polling, reloads and several hosts never duplicate them. Only Start game starts play; a host release holds that court until a game next starts or finishes there
- Polling (5 s), not Realtime. Host background refreshes POST to `/api/host-poll` (`src/app/(host)/hostPolls.ts`), never server actions: a browser runs actions one at a time, so a refresh would queue ahead of the host's tap
- Secrets never in client bundles. Dev and prod use separate Supabase projects; CI uses a local Supabase stack, never a hosted one
