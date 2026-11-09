# M4.5 — Socials and data isolation

Status: **approved by Ryan 2026-11-09; in progress**. Runs before M5. Implements `docs/decisions/0003-socials-and-data-isolation.md` with Ryan's answers and clarification of 2026-11-09. Nothing is in production; local and dev data move into one default social.

## 0. Decisions this plan rests on

**Product principle (Ryan, 2026-11-09):** each social operates independently; players check in to the session they are physically attending. The QR/NFC check-in identifies which social's session the player is attending, not membership of any central system. No global player identity, and no cross-social membership, attendance checks, restrictions or coordination. A player can attend any number of socials; each social records them, their contact details and their attendance independently. The only restriction is within one social: no duplicate check-in for the same player in the same session.

- An installation holds several independent socials. The app has **no venue entity, role or relationship**: socials may share a physical venue, but the app doesn't model it.
- One login belongs to exactly one social, as `manager` (Social Manager) or `host` (operational host). A manager has every host right plus: invite and remove hosts, add courts, rename the social, and (M5) reissue the check-in link.
- Each social owns its members directory, the phones it recognises, its courts, saved setups, sessions and everything under a session. A player who attends two socials simply appears in each social's directory; nothing links the two.
- **Courts belong to one social.** The Social Manager records the courts the venue gave their social (name and formats); the social's hosts use them in setups, matches and rotations. Names are unique per social. No bookings, availability, clash checks or links between socials' courts.
- One check-in tag per social (`socials.checkin_tag`). A host can show the QR on screen (M5).
- At most one open session (draft or live) per social; every host of the social can edit it, run it and approve its check-ins.
- `socials.name` replaces `club_settings.club_name` (table dropped).
- Ryan (operator) creates socials and their first manager with `pnpm create-social` (secret key). No operator UI.

## 1. Schema (`supabase/migrations/20261110090000_socials_schema.sql`)

Additive, no `db:reset`. Order: create `socials`; rename the enum value; add nullable `social_id` columns; backfill; then `NOT NULL`, foreign keys, indexes, triggers, RLS; drop `club_settings` and `hosts.checkin_tag`. On an empty database the backfill does nothing; the first social comes from the script.

**New `public.socials`:** `id uuid pk`; `name public.short_label` (not unique: the operator script warns on duplicates, so no error can leak another social's name); `checkin_tag text unique` (moved from `hosts`, same default and `^[a-z0-9_-]{16,64}$` check); `created_at`, `updated_at` with the `set_updated_at` trigger.

| Table                                      | Change                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `host_role` enum                           | `rename value 'admin' to 'manager'` (existing admins become managers; manager stays first in order)                                                                                                                                                                                                                            |
| `hosts`                                    | Kept as the membership table. `user_id` stays the primary key, which enforces one login = one social. Add `social_id not null references socials on delete restrict`, index `(social_id)`. Drop `checkin_tag` (the default social gets a fresh tag; none printed yet)                                                          |
| `members`                                  | Add `social_id not null`, `unique (id, social_id)` (composite FK target). Prefix search indexes become `(social_id, lower(first_name\|\|' '\|\|last_name) text_pattern_ops)` and `(social_id, lower(last_name) text_pattern_ops)` where `is_active`; directory-order index `(social_id, is_active, first_name, last_name, id)` |
| `member_devices`                           | Add `social_id not null`; primary key becomes `(social_id, token_hash)` so one phone links to a different member per social; FK `(member_id, social_id) → members (id, social_id)` on delete cascade                                                                                                                           |
| `courts`                                   | Add `social_id not null`; drop the installation-wide name uniques; add `unique (social_id, lower(name))` and `(social_id, sort_order)`. Only the social's manager adds courts; no logic between socials                                                                                                                        |
| `saved_setups`                             | Add `social_id not null`; `host_id` becomes nullable "saved by" with `on delete set null` (today `cascade` would delete the social's setups when a host is removed); uniques become `(social_id, lower(btrim(name)))` and index `(social_id, last_used_at desc)`                                                               |
| `sessions`                                 | Add `social_id not null`, `unique (id, social_id)`; `host_id` stays "created by"; replace one-open-per-host with **`sessions_one_open_per_social_idx on (social_id) where status in ('draft','live')`**; index `(social_id, status, planned_start desc)`                                                                       |
| `session_participants`, `checkin_requests` | Add `social_id not null`; composite FKs `(session_id, social_id) → sessions` and `(member_id, social_id) → members` (guests with null `member_id` skip the member check). The database then refuses any cross-social link                                                                                                      |
| `session_events`, `matches`                | No column: ownership via the session (the append-only log is never rewritten). RLS joins `sessions`                                                                                                                                                                                                                            |
| `checkin_attempts`, `login_attempts`       | Unchanged (no read policy; rate limits stay per device/IP/session)                                                                                                                                                                                                                                                             |
| `club_settings`                            | Name copied into the default social, then dropped with its policy, grant and trigger                                                                                                                                                                                                                                           |

**Backfill** (only if hosts, members, courts, saved_setups or sessions have rows), in this order:

1. **Choose survivors first**, before any update fires `set_updated_at` (which would set every `updated_at` to the same `now()`): save into a temp table, per future social, the one open session to keep, ordered `(status = 'live') desc, (host_id is not null) desc, updated_at desc, id`. Disable the `*_set_updated_at` triggers for the backfill so real `updated_at` values survive.
2. Create the default social (`coalesce(club_name, 'Pickleball Social')`) and set `social_id` everywhere.
3. Close the other open sessions **through the log**, so `state = replay(events)` stays true: drafts become `cancelled`; live sessions get a real `SessionEnded` event appended exactly as `end_session` does (payload `{}`, `seq = last_seq + 1`, `occurred_at = greatest(last event time, now())`, a documented migration actor id, `last_seq` bumped, match rows closed) and status `ended`. `raise notice` every id.
4. Saved setups with the same name in one social: the most recently used keeps the name; the others become `left(name, 74) || ' (n)'`, looping `n` until unique (stays within `short_label`'s 80 characters).

**Integrity triggers:**

- `private.keep_one_manager_per_social()` replaces `keep_one_admin` (drop the old trigger and function first: its body contains the literal `'admin'`, which fails after the enum rename). It is a **constraint trigger `after update or delete … deferrable initially deferred`**, so it checks once at commit (a row-level BEFORE trigger would pass or fail depending on row order when a statement deletes a manager and hosts together). It locks the `socials` row `for update` and raises `LAST_MANAGER` if a social still has hosts but no manager. Emptying a social entirely is allowed (operator, test cleanup).
- `private.reject_social_id_change()` raises `SOCIAL_ID_IMMUTABLE` on any `social_id` update.

**Migration order and details** (from review):

- Migration 1 drops all 11 old policies (including `saved_setups_select_own`) and revokes the `is_host` grant before migration 2 drops `private.is_host`.
- `unique (id, social_id)` on members and sessions is created before the composite FKs. The composite FKs **replace** the single-column FKs on `session_participants` (member_id, session_id), `checkin_requests` (member_id, session_id) and `member_devices` (member_id); keeping both would make PostgREST embeds such as `members(is_active)` ambiguous (PGRST201) and break Setup.
- `courts (social_id, sort_order)` is a plain (non-unique) index. Members and sessions get no extra ordering indexes yet (not needed at this scale); `sessions_status_planned_start_idx` stays.
- Policies are written `social_id = (select private.current_social_id())` so the function runs once per query.
- Old function bodies that reference dropped columns or indexes fail only when called; migration 2 replaces every one of them.
- Write functions **never accept a social id from the caller**; they always derive it from `p_actor_user_id`.

**Operator function:** `public.create_social_with_manager(p_name, p_manager_user_id, p_manager_display_name) returns uuid`, one transaction, `service_role` only.

## 2. RLS

- `private.current_social_id()` (`stable security definer`): the caller's `hosts.social_id`, null for non-hosts (so policies match nothing). Replaces `private.is_host()`; the only function `authenticated` may execute.
- Policies: `socials` → `id = current_social_id()`; hosts, members, courts, saved_setups, sessions, session_participants, checkin_requests → `social_id = current_social_id()`; session_events, matches → `exists` on the owning session. member_devices, checkin_attempts, login_attempts keep no read policy. `grant select on socials to authenticated`.
- Saved setups become social-wide (see decision D2).

**pgTAP `supabase/tests/11_social_isolation.test.sql`:** socials A and B with a manager, host, member, same phone `token_hash`, a "Court 1", a "Tuesday" setup and a session each (A draft with participant and pending request; B live with an event and a match). Checks:

- every public table except socials, session_events, matches, checkin_attempts and login_attempts has `social_id uuid not null`; every policy references `current_social_id`;
- host A (and manager A) see exactly A's rows in every readable table, none of B's; and vice versa;
- every write function called by A's actor on B's ids fails with its code and B's rows are unchanged;
- cross-social participant, request or device rows → `23503`;
- "Court 1"/"Tuesday" allowed in both; a duplicate within A → `23505`; a second open session in A → `23505`;
- `search_checkin_names` with A's tag never returns B's members; `submit_checkin` with A's tag and B's member → `member_not_found`;
- `LAST_MANAGER` and `SOCIAL_ID_IMMUTABLE` cases.

Existing pgTAP files gain a social in every fixture; `LAST_ADMIN` → `LAST_MANAGER`; "another host" cases split into **same social → allowed** (co-editing, shared setups) and **other social → `DRAFT_NOT_OPEN` / `SAVED_SETUP_NOT_FOUND`**; `01` lists `socials`, drops `club_settings`, and adds `create_social_with_manager`.

## 3. Write functions (`20261110090100_socials_functions.sql`)

New helpers replace `require_host`, `lock_session`, `lock_own_open_draft` (old ones dropped):

- `private.require_host_social(actor) returns uuid` — actor's social or `NOT_A_HOST`.
- `private.lock_social_session(social, session)` — `for update` filtered by social; `SESSION_NOT_FOUND` if missing **or another social's** (existence not revealed).
- `private.lock_social_open_draft(social, session)` — plus `status = 'draft'`, else `DRAFT_NOT_OPEN`. **No `host_id` check** (co-editing; the M4.4 revision check protects it).
- `private.find_open_session_by_checkin_tag` joins `socials`.

| Function                                                                                                          | Change                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `append_session_event`, `start_session`, `end_session`, `cancel_draft_session`                                    | `require_host_social` + `lock_social_session` (any host of the social)                                                                               |
| `add_guest_mid_session`, `remove_draft_participant`                                                               | Same; lookups and inserts scoped to the social                                                                                                       |
| `save_session_draft`, `set_draft_member_attendance`, `add_draft_guest`, `remove_draft_guest`, `apply_saved_setup` | `lock_social_open_draft`; members/setups looked up within the social; inserts carry `social_id`                                                      |
| `save_setup`                                                                                                      | Inserts `social_id`, `host_id = actor`; conflict on `(social_id, lower(btrim(name)))`                                                                |
| `approve_checkin`, `reject_checkin`                                                                               | Request looked up within the social (`CHECKIN_REQUEST_NOT_FOUND` otherwise); new member gets `social_id`; device upsert on `(social_id, token_hash)` |
| `search_checkin_names`, `submit_checkin`                                                                          | Members filtered by the session's social; request carries `social_id`                                                                                |
| `record_login_attempt`, `insert_session_event`, `write_match_row`, `record_checkin_attempt`                       | Unchanged                                                                                                                                            |

Grants restated at the end: every public function revoked from public/anon/authenticated and granted to service_role; private helpers revoked from all.

## 4. Server code (`src/server`)

- `auth/hostAccess.ts`, `auth/currentHost.ts`: `SignedInHost` gains `socialId`, `socialName`; role `'manager' | 'host'`; `NOT_AN_ADMIN` → `NOT_A_MANAGER` ("Only the social manager can do this."); not-a-host copy "Ask your social manager for an invite."
- **Rule:** cookie-client reads rely on RLS; **every service-role query filters `.eq("social_id", host.socialId)` and every insert sets `social_id`** (added to CLAUDE.md as a review checklist item).
- `hosts/hostActions.ts`: invites go into the manager's social; `removeHost` refuses to remove a manager (`CANNOT_REMOVE_MANAGER`: "Only the operator can remove a social manager."); an email that already has a login → "That email can't be invited here. Use a different email." (neutral: doesn't reveal another social); `removeHost` reads, counts managers and deletes within the social, and deletes the auth user only if a row was deleted (today it would delete any user id given).
- `hosts/hostRules.ts`: manager count, `LAST_MANAGER` copy.
- New `socials/socialActions.ts`: `updateSocialName` (manager only, `short_label` rules).
- `members/memberActions.ts`: insert `social_id`; reads/updates/duplicate check scoped (another social's member → `MEMBER_NOT_FOUND`).
- `setup/setupDraft.ts`: `readSocialOpenSession(socialId)`, `listSocialSavedSetups(socialId)`.
- `setup/setupActions.ts`: draft reads by social (co-editing); `startSessionDraft` reuses the social's draft if a co-host already started one; `snapshotCourts` scoped to the social (today any court id is accepted); `addClubCourt` manager-only; saved setups scoped; conflict copy "…changed by another host, tab or device…".
- `submitSessionAction.ts`, `sessionLog.ts`: comments only. `pnpm db:types`.

## 5. UI (minimal)

- Header brand shows the social's name; role label "Social manager" / "Host". "Pickleball Social Manager" stays on `/login` and in tab titles (decision D1).
- Hosts page: scoped list; "MANAGER"/"HOST" badges; manager-only invite/remove and a new "Social name" card (`SocialNameForm.tsx`).
- Setup: the social's open draft; court picker and Add court show only the social's courts; Add court is manager-only.
- Copy: "admin" → "social manager" throughout. No sticker/QR UI (M5).

## 6. Operator script and seed

- `scripts/create-social.mts` replaces `create-admin.mts` (`pnpm create-social --name … --manager-email … --manager-name …`; `--social-id` adds a manager to an existing social). Refuses non-local databases unless `--production` (needs Ryan's OK). Prints `/t/<tag>`; warns on a duplicate social name; safe to re-run.
- `scripts/seed.mts`: one social ("Riverside Pickleball Club") for `host@example.test` as manager, plus a second social ("Riverside Morning Social", manager `manager2@example.test`, 2 courts, 10 members) for checking isolation by hand.

## 7. Effects on other docs

- `docs/plans/m5-player-checkin.md`: social name = `socials.name` (done in M4.5); tag reissue manager-only on `socials.checkin_tag`; AC 2 "the social has no open session"; recognition per social; search this social only; tray visible to every host of the social; **delete AC 13** (a member can't be live in another social); AC 14 other socials see nothing; AC 15 one link/QR per social, shown full-screen for a player to scan; replace the "roles today" section with a pointer here.
- `docs/plans/session-manager-mvp.md`: §4 table rows; an M4.5 row in §7; remove the "one live session per player" carried note.
- `CLAUDE.md`: reads limited to the host's own social; per-social sticker; write functions derive the actor's social and only touch its rows; admin-client queries always filter `social_id`; no venue concept.
- ADR 0002 (`current_social_id`, `LAST_MANAGER`), ADR 0003 (Accepted), `docs/auth.md`, `docs/ROADMAP.md`.

## 8. Increments (each tested and committed separately)

Split vertically (review), so every increment has its own migration, pgTAP, server scoping and two-social tests. The in-between states are harmless locally (one social).

**Before the first migration touches Ryan's DB:** a full dump (schema + data) to a durable gitignored path (`backups/pre-socials-<commit>.sql`), the commit hash recorded; a **dry run** on Ryan's DB inside `begin; … rollback;` running the migrations plus assertions (row counts unchanged, no null `social_id`, at most one open session per social, the list of sessions it would close) — CI only ever runs the empty-DB branch. Rollback: with Ryan's OK, reset to the pre-migration commit and restore the dump. The hosted dev project is not touched in M4.5; applying it later needs its own backup and Ryan's approval.

**A1. Socials and hosts.** `socials` table, `hosts.social_id`, enum rename (`admin` → `manager`) with every UI label, copy and test that depends on it (header role, Hosts badges, `hostAccess.ts`, `LoginPanel` `pnpm create-social` copy, `package.json`), the `LAST_MANAGER` and immutable-`social_id` triggers, `current_social_id()` RLS on socials and hosts, drop `club_settings`, move the tag to `socials`, `create_social_with_manager` + `scripts/create-social.mts`, social name in the header and the manager's "Social name" card, `removeHost`/`inviteHost` scoping. Test fixtures create their own social per test. pgTAP 04 (`hosts_keep_one_admin` name, deletes socials) and 01 updated.

**A2. Directory.** members, member_devices, courts: columns, composite FKs, per-social uniques, RLS; check-in search/submit/approve scoped for members and devices; `memberActions`, `addClubCourt` (manager only, scoped `max(sort_order)`), `snapshotCourts`. Two-social tests: B's member/court invisible and rejected; duplicate-name check ignores B; same "Court 1" in both.

**A3. Sessions.** sessions, participants, check-in requests, saved setups: columns, one open session per social, backfill with log-consistent closing, co-editing helpers (`lock_social_session`, `lock_social_open_draft`), every session/draft/setup function, server reads by social, `startSessionDraft` reusing a co-host's draft. Two-social tests: co-host saves the same draft; two saves at one revision → exactly one conflict; other social refused everywhere; `submitSessionAction` on another social's session → not found; setups shared within a social. `e2e/socials.spec.ts` (two browser contexts).

**A4. Seed, operator docs, plan and decision edits.** Seed re-runnable on the migrated DB (social taken from the existing `host@example.test` row; second social's seed ids namespaced; demo draft respects one open session per social); `pnpm seed` prints two socials and tags; docs (§7); screenshots of header and Hosts page for Ryan.

**Acceptance for every increment:** `supabase migration up` on Ryan's local DB without reset (after the dry run); `supabase db diff` reports no changes (shadow DB from empty); pgTAP, typecheck, lint, format, tests ×3, build, full e2e green; every `createSupabaseAdminClient` query reviewed for `social_id` scoping (`session_events`/`matches` via a join to `sessions`); a repo-wide grep finds no `'admin'`, `LAST_ADMIN`, `NOT_AN_ADMIN`, `club_settings` or `hosts.checkin_tag` left.

**Extra tests from review:** `create_social_with_manager` atomic and refusing an existing host (23505); deleting a manager and host in one statement; anon and non-host `authenticated` see nothing in `socials`; the full function inventory (17 public functions plus the unchanged private helpers, listed as reviewed).

## 9. Risks and scope

**Risks**

- Backfill closes extra open sessions on local/dev (data dump first; notice lists them).
- A missed `social_id` filter on an admin-client query is the main leak risk: composite FKs and function checks are the backstop; two-social tests and the CLAUDE.md checklist catch it.
- Co-editing has no live refresh: a co-host sees changes on reload or when a stale save is refused (M4.4 behaviour).
- Renaming the enum value breaks every `'admin'` literal (typecheck and grep).
- Test socials accumulate locally (sessions with logs can't be deleted), like today's leftover sessions.

**Out of scope**

- Any venue entity, role or management: no venue table, bookings, availability or clash prevention.
- Anything shared or related between socials, including linking one person's member records.
- Operator UI, self-service social creation, deleting socials; switching socials or one login in several.
- Promoting/demoting hosts in the UI (managers come from the operator script).
- Editing, renaming or deactivating courts (managers can only add, as today).
- Check-in page, tray, sticker/QR page and tag reissue (M5).

## Decisions (Ryan, 2026-11-09)

- **D1 Header:** the host header shows the social's name; "Pickleball Social Manager" stays on `/login` and in browser tab titles.
- **D2 Saved setups:** any host of the social can save, replace and apply them. Existing private setups merge into one list per social (duplicate names get " (n)").
- **D3 Managers:** a social can have one or more managers with equal rights. Managers cannot remove (or demote) another manager in the app; only the operator can, with the script (`--social-id` adds a manager to an existing social). Existing admins all become managers of the default social.
- **D4 Members:** any host (and the manager) can add, edit and deactivate the social's members.
- Decided on review (technical, no product change): leftover open sessions are closed through the log (`SessionEnded` / cancel), not silently; increments split A1–A4; the cross-social invite message is neutral and reveals nothing.

Status: approved 2026-11-09.
