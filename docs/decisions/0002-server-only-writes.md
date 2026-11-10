# 0002. All database writes go through server code with the secret key

Status: Accepted · 2026-11-07 (amended 2026-11-10 for socials, `docs/plans/socials.md`) · Plan: `docs/plans/session-manager-mvp.md` (§3, §4.1) · Supersedes the write parts of 0001's "Supabase client + RLS" bullet

## Context

The first M3 database layer let signed-in hosts write some tables directly with their own session (RLS write policies plus column grants), and let `anon` call the two public check-in functions straight from the browser. A security review found three problems:

- Any host could call the log functions directly through the Data API and skip the engine validation done in server actions.
- The browser could pass made-up device and IP hashes, which defeats the per-phone and per-IP check-in rate limits.
- Write rules were split across RLS policies, column grants and server code, so they were harder to review.

## Decision

**Only server code writes, and it writes only with the secret key (`service_role`).** Nothing writes with a user's JWT, and the browser never calls a database function.

- **Reads:** server code reads with the signed-in host's cookie client, under RLS. A host reads only the rows of their own social: policies compare `social_id` with `private.current_social_id()` (the caller's `hosts.social_id`, null for non-hosts so nothing matches). `session_events` and `matches` are reached through their session.
- **Writes:** server code first verifies the user with `supabase.auth.getUser()` on the cookie client, then writes through `createSupabaseAdminClient()` (`src/lib/supabase/admin.ts`, server-only, `SUPABASE_SECRET_KEY`).
  - **Write functions** (session log, drafts, saved setups and check-in: `append_session_event`, `start_session`, `end_session`, `add_guest_mid_session`, `cancel_draft_session`, `remove_draft_participant`, `save_session_draft`, `set_draft_member_attendance`, `add_draft_guest`, `remove_draft_guest`, `apply_saved_setup`, `save_setup`, `approve_checkin`, `reject_checkin`, `close_checkin_already_checked_in`, `reissue_checkin_tag` (managers only), `create_social_with_manager`): `service_role` only. The host tray reads through `list_checkin_requests_for_open_session` (also actor-scoped, `service_role` only). Every one except the operator function takes `p_actor_user_id`, derives the actor's social with `private.require_host_social` (raises `NOT_A_HOST` unless that user is in `hosts`), and only touches that social's rows: a session, request or setup of another social is reported as not found. Functions never accept a social id from the caller. The session-log path is `submitSessionAction` in `src/server/submitSessionAction.ts`.
  - **Plain tables** (members, courts, hosts, the social's name): the server checks the user's role in code, then writes with the service-role client. Every service-role query filters `social_id` (inserts set it); `session_events` and `matches` are scoped by a join to `sessions`. Database triggers enforce what must hold no matter who writes:
    - append-only `session_events`
    - config snapshot locked after the draft
    - participants deletable only from a draft
    - at least one manager per social (`LAST_MANAGER`, a deferred constraint trigger)
    - `social_id` never changes (`SOCIAL_ID_IMMUTABLE`).
- **Public check-in:** `get_checkin_page`, `search_checkin_names` and `submit_checkin` are `service_role` only. The `/t/<tag>` server code (M5) calls them and passes:
  - the SHA-256 of the device token from the player's cookie (`hashDeviceToken`)
  - an HMAC-SHA256 of the client IP keyed with `CHECKIN_IP_HMAC_SECRET` (`hashClientIp`, `src/server/checkin/clientIdentity.ts`).

  Raw tokens and IPs never reach the database.

- **Grants:**
  - `anon`: nothing.
  - `authenticated`: `SELECT` on the readable tables, plus `EXECUTE` on `private.current_social_id()` for RLS.
  - Default privileges for objects created by `postgres` give `PUBLIC`, `anon` and `authenticated` nothing, so every grant is explicit. pgTAP (`supabase/tests/01_rls_and_grants.test.sql`) checks all of this.

Server environment variables (never `NEXT_PUBLIC_`): `SUPABASE_SECRET_KEY`, `CHECKIN_IP_HMAC_SECRET` (32+ random characters). Public: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.

## Consequences

- One write path to review. The engine validation in server actions can't be bypassed through the Data API, and rate limits use values the browser can't forge.
- Server code carries more responsibility: every server action that writes must verify the user, and check their role for manager-only actions, before it uses the service-role client. The service-role client must never reach a client bundle (`server-only`).
- Database functions authorise the actor id they are given. They trust the server to pass the verified user, not a value from the browser.
- The rule belongs in CLAUDE.md's "Data and architecture rules"; the coordinator updates that file.
