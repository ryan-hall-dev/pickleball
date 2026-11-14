# Session-only participants: removing the membership system

Status: **Approved (Ryan, 2026-11-11)**, all four decisions as recommended. Supersedes the member-based parts of `m5-player-checkin.md`.

## Requirements (Ryan, 2026-11-11)

- Session participants are the only player records. No phone numbers, player accounts, persistent player profiles or cross-session identity.
- Device tokens are random, session-scoped and contain no personal information. A player starts with a fresh form for every session, including on the same device.
- Duplicate-name checks cover approved participants and host-added players alike. A duplicate-name check-in request never exposes attendance information to the player. The host cannot approve a conflicting name until the player provides a distinguishing name.
- Rejected players can submit a fresh request. Same-device resubmissions never create duplicate requests.
- Approval is atomic and enforces session-level name uniqueness server-side, including when two hosts act concurrently.
- All existing session history, matches, events, scheduling behaviour and social isolation are preserved.
- Migration safeguards: fresh, verified local backup; the migration is run against a separate scratch database first; report exactly what is preserved and removed; no local reset; nothing applied to the hosted development project; the 19 leftover test socials stay; existing session logs are verified to replay.
- No features or abstractions beyond what the session-only model requires.

## Superseded decisions

The M5 decisions of 2026-11-10 that depended on persistent member or phone identity are superseded (recorded here explicitly, per Ryan):

- **D-A** (`already_checked_in` as a separate request outcome for a member already attending), **D-B** (telling the requesting phone after a host closed such a request) and **D-C** (never linking that phone to the member): there are no members or phone links. The status value and the close action are removed. "You're already checked in" remains only as the answer to the phone whose own request in this session was approved.
- **D-D** (advisory possible-duplicate warning on new-player requests, host decides): replaced by the hard rule that names are unique within a session. The host cannot approve a clashing name; the player re-submits with a distinguishing name.
- The recognised-phone card, member search, confirm sheet and "Update your level" (M5 decisions #9, #10, #12-#15) are removed.

## The product change (Ryan, 2026-11-11)

- No membership system at this stage. A player scans the social's QR code or taps its NFC tag, sees "Welcome to <Social name>. Please enter your details to check in.", enters name and playing level, and submits. A host approves or rejects.
- No member lookup, no recognised-phone versus new-player distinction, no "check in as a guest", no requirement to be a member, no reuse of details from earlier sessions.
- Every session has its own participants and attendance. Attending tonight and tomorrow means entering details twice. Historical attendance stays with the session in which it happened.
- Duplicate protection applies within a session: **no two participants in one session may have the same name.**
- Preserve: social isolation, host approval/rejection, privacy, session history and scheduling integrity, the QR/NFC link.

## 1. What depends on members today

**Database** (latest definitions; `core` = 20261107120000, `directory` = 20261110120000, `sessions` = 20261110150000, `m5` = 20261111090000, `names` = 20261111120000)

| Object                                      | Dependency                                                                                                                                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `members`                                   | The directory: name, skill, active flag, generated `search_name`, `last_checked_in_at`, `social_id`, RLS select for the social's hosts.                                                                         |
| `member_devices`                            | Phone → member link per social (recognised phone). Service-role only.                                                                                                                                           |
| `session_participants.member_id`            | Composite FK to `members (id, social_id)`; unique `(session_id, member_id)`: the only attendance uniqueness today; check `is_guest or member_id is not null`.                                                   |
| `session_participants.is_guest`             | Guest vs member split; copied into the `PlayerJoined` / `SessionStarted` log payloads (`private.player_joined_payload`).                                                                                        |
| `checkin_requests.member_id`                | Composite FK; check "first-timer has skill" lets member requests omit a level.                                                                                                                                  |
| `checkin_request_status.already_checked_in` | Added in M5 for the "member already attending" closure (an enum value cannot be dropped; the type must be recreated).                                                                                           |
| `search_checkin_names`                      | Member-only (search the directory).                                                                                                                                                                             |
| `submit_checkin`                            | Member path: `p_member_id`, member names, `member_not_found`, `already_checked_in` answered to the member's linked phone.                                                                                       |
| `get_checkin_page`                          | `recognised_member` via `member_devices`.                                                                                                                                                                       |
| `approve_checkin`                           | The most coupled: creates or updates a member, sets `last_checked_in_at`, upserts `member_devices`, inserts the participant with `member_id`, refuses `ALREADY_IN_SESSION` by member.                           |
| `close_checkin_already_checked_in`          | Member-only.                                                                                                                                                                                                    |
| `list_checkin_requests_for_open_session`    | `member_id`, `saved_skill_level`, `is_already_attending` (by member), `is_possible_duplicate` (by name, new players only).                                                                                      |
| `set_draft_member_attendance`               | Member-only (snapshots selected members into participants).                                                                                                                                                     |
| `add_draft_guest`, `remove_draft_guest`     | Insert/delete `is_guest` participants.                                                                                                                                                                          |
| `add_guest_mid_session`                     | Live-session add (M7), `is_guest`.                                                                                                                                                                              |
| Not dependent                               | `start_session`, `append_session_event`, `end_session`, `remove_draft_participant`, `reject_checkin`, `reissue_checkin_tag`, `matches`, `session_events`: they reference participants by session-level id only. |

**Engine** (`src/engine`): nothing reads members or `member_id`. `Participant` is `{participantId, firstName, lastName, skill, isGuest}`; the scheduler uses id and skill, replay uses id and name. `isGuest` is declared and never read.

**Server**: `src/server/members/*` (directory CRUD, search, rules); shared helpers that live there but are used by check-in and setup (`personNameSchema`, `memberInputSchema`, `normalizeMemberSearchText`, `SKILL_LEVELS`/labels); `setupActions` (`setDraftMemberAttendance`, guests); `setupDraft` (participant select embeds `members(is_active)`); public and host check-in actions/results; `deleteTestSocials`; `scripts/seed.mts`.

**UI**: Members page and nav item; Setup "Who's playing" (member grid, search, skill filters, select all/clear, "Showing N of M", quick-add guest), `SessionSummary` "(N members + N guests)"; the tray's Member/NEW PLAYER chip, "level changed from", already-attending and possible-duplicate rows, Close action; the public page's recognised card, name search, confirm sheet, "Not a member? Check in as a guest", P09b.

**Tests**: pgTAP 01, 03, 04, 05, 06 (whole file), 08, 11 (49 lines of composite-FK and device checks), 12; vitest member suites, check-in, setup and tray tests; e2e `members.spec.ts` (whole), `setup.spec.ts`, `checkin*.spec.ts`, `support/localHostSession.ts` (seeds members).

**Docs**: DESIGN.md (Members page, Who's playing, tray, player screens), ADR 0003 (per-social member directory), MVP plan (data model, M4.1, M4.3), M5 plan (D-A to D-D), socials plan, `docs/designs/m5/README.md`.

**Local data**: 161 members (seed/test), 1 device link; 909 participant rows with `member_id`, 579 host-added guests; 1 approved check-in request. No session has two participants with the same normalised full name, so a per-session uniqueness rule can be added without conflicts.

## 2. Proposed change: session-only participants

The smallest change that removes the dependency rather than hiding it. Participants already carry a name and level snapshot per session and a session-level id that the log and engine use, so the data model shrinks instead of growing.

**Data model after the change**

- `session_participants`: `id, session_id, social_id, first_name, last_name, skill_level, created_at`. Drop `member_id` (and its FK, index, the member-unless-guest check and the per-member unique) and `is_guest`.
- New **unique index** on `(session_id, private.normalise_name_for_search(first_name || ' ' || last_name))`: the database guarantee that no session has two participants with the same name (case, accents and spacing ignored). This reuses the M5 normaliser, which is immutable, as Postgres requires for an index.
- `checkin_requests`: drop `member_id`; `skill_level` becomes required; status values `pending | approved | rejected | withdrawn` (the type is recreated without `already_checked_in`; no row uses it).
- Drop `members` and `member_devices` with their policies, triggers and grants.
- Each session uses its own independent 32-byte random HttpOnly cookie (`checkin_session_<session UUID>`, one-day lifetime, path `/t/<tag>`); SQL stores only its SHA-256. No long-lived universal device token or deterministic cross-session derivation. The legacy `checkin_device` cookie is ignored. Existing request rows and history are preserved; legacy-cookie requests are not automatically resumed.
- The page header includes the session UUID. Submit carries that rendered UUID, validates it server-side, and passes it to SQL. SQL locks and revalidates that session and its tag/social before any write. Turnover returns `session_changed`; the client clears entered details and reloads a fresh form. A cookie from one session cannot create a request in another.

**Functions**

| Function                                                                   | After                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_checkin_names`                                                     | Dropped.                                                                                                                                                                                                                                                            |
| `submit_checkin(tag, expected_session_id, device, ip, first, last, skill)` | Level required. Rate limits unchanged. Same phone, same session → the existing pending request; if this phone's request in this session is already approved → `already_checked_in` (the phone's own request, never a name lookup). Otherwise a new pending request. |
| `get_checkin_page`                                                         | Header (social name, session name, times, courts, checked-in count) and this phone's current request. No `recognised_member`.                                                                                                                                       |
| `approve_checkin`                                                          | Inserts the participant from the request's name and level and marks the request approved. If the name is already in the session: raise `NAME_ALREADY_IN_SESSION` (the unique index is the backstop). No member, no device link.                                     |
| `close_checkin_already_checked_in`                                         | Dropped (the member case no longer exists).                                                                                                                                                                                                                         |
| `list_checkin_requests_for_open_session`                                   | `id, created_at, first_name, last_name, skill_level, is_name_already_in_session`.                                                                                                                                                                                   |
| `set_draft_member_attendance`                                              | Dropped.                                                                                                                                                                                                                                                            |
| `add_draft_guest` → `add_draft_participant`                                | Name + level; refuses a duplicate name with `NAME_ALREADY_IN_SESSION`. `remove_draft_participant` (exists) replaces `remove_draft_guest`.                                                                                                                           |
| `add_guest_mid_session` → `add_participant_mid_session`                    | Same, for live sessions (M7).                                                                                                                                                                                                                                       |
| `private.player_joined_payload`                                            | Drops `isGuest`.                                                                                                                                                                                                                                                    |
| Unchanged                                                                  | `start_session`, `append_session_event`, `end_session`, `reject_checkin`, `reissue_checkin_tag`, rate limiting, `require_host_social`, every RLS policy on the remaining tables.                                                                                    |

**Duplicate names (Ryan: none within a session)**

- Guarantee: the unique index above. Every write path (approve, host add, mid-session add) reports it as `NAME_ALREADY_IN_SESSION`.
- Host adds a player: inline error "Someone named <name> is already in this session. Add something to tell them apart, like an initial."
- Check-in request with a name already in the session: the request is accepted as pending; the host's tray row is flagged "This name is already checked in to this session. They can't be added twice." with **Reject only**. The host speaks to the player (the rejected screen already says "Please speak to the host"); if it is a different person, they check in again with a distinguishing name. This keeps the privacy rule: a phone never learns whether a name is attending.
- Same phone after approval: "You're already checked in" (keyed on the phone's own request).

**Engine and history**

- `Participant.isGuest` is removed from the engine type. The event parser accepts and ignores `isGuest` in old `PlayerJoined` / `SessionStarted` events, so every existing log still replays. Proof: `pnpm verify-migrated-logs` (the 9 migrated logs) and the replay tests.
- Scheduling, fairness and the report use participant id, name and skill only: unaffected.

**Host side**

- Setup "Who's playing" becomes the session's **Players** list: approved check-ins and host-added players, each removable, with the add form (first name, last name, level) kept. The member grid, search, skill filters, Select all / Clear and "Showing N of M" go. Session summary shows "N players". Saved setups are untouched (configuration only).
- Members page and nav item are removed.
- Tray rows: name, level, time, Approve / Reject; the only flag is the name clash (Reject only). Member/NEW PLAYER chip, "level changed from", the Close action and the advisory possible-duplicate go.
- Sticker and QR, Issue new link: unchanged.

## 3. Migration and data preservation

One additive-then-destructive migration, applied locally after a fresh backup (hosted dev untouched until Ryan says so; there is no production yet):

1. Assert no session has two participants with the same normalised name (true locally) and create the unique index.
2. Assert no `checkin_requests` row has status `already_checked_in`; recreate the status type without it.
3. Drop `checkin_requests.member_id` (FK, index, skill check), set `skill_level` not null (the one existing row has one).
4. Drop `session_participants.member_id` and `is_guest` with their constraints and index.
5. Drop `member_devices`, then `members` (policies, triggers, grants go with them).
6. Replace the functions above; restate grants (`service_role` only; `anon` nothing).

Preserved: socials, hosts, courts, sessions, every `session_participants` row (names and levels are already snapshotted, so history keeps who attended which session), `session_events`, `matches`, `checkin_requests` (name and level stay), saved setups. Lost: the member directory rows and the one device link, which are seed/test data. A clean database built from all migrations is checked against the local one as usual.

## 4. The player journey after the change

1. Scan the QR code or tap the NFC sticker → `/t/<tag>`.
2. "Welcome to <Social name>. Please enter your details to check in." with the session card beneath (LIVE NOW, session name, times, courts, checked in, time to first game).
3. Form: first name, last name, playing level (all required; inline orange errors). "A host approves each check-in before you're added to today's players." Button: CHECK IN.
4. Waiting for the host (updates every 5 s; reload returns here).
5. Approved: "You're in, <first name>". Rejected: "The host didn't approve this check-in. Please speak to the host." + Try again (a fresh form, new request). Already checked in: only when this phone's own request in this session was approved.
6. Unchanged: too many attempts, link not active, no session open, something went wrong.

Removed: recognised-phone card, name search, confirm sheet, "Update your level", "Not a member? Check in as a guest", "No one matches… check the spelling", P09b. Tomorrow's session on the same phone starts with an empty form.

## 5. Work plan (approved; coordinator owns commits)

1. Database migration, engine `isGuest` removal, pgTAP, regenerated types, seed script.
2. Public page: single form, states, server actions, unit/integration/e2e.
3. Host: Players list on Setup, tray, Members page and nav removal, shared name/skill helpers moved out of `src/server/members`, tests.
4. Docs: ADR 0004 (session-only participants), CLAUDE.md, DESIGN.md, ADR 0003, MVP and M5 plans, design README.

## Decisions for Ryan

1. **Members page and directory removed entirely** (recommended; keeping a host-only roster would leave the persistent directory in place).
2. **Duplicate name at check-in handled by the host only** (recommended; telling the player at submit would let anyone test whether a name is attending).
3. **Level required for host-added players too** (recommended, one rule for everyone; today the host form treats it as optional).
4. **Keep the session card under the welcome line** (recommended) or show the welcome line only.

## Resumed foundation (2026-11-15)

Implemented the public fresh-name/required-level form and session card, request polling/reload, neutral rejection with a fresh retry, and retry recovery. Removed public member search/confirmation adapters and directory helpers; name validation and skill labels now live in shared participant modules. Host setup lists only this session's participants; required-level add/remove and pending approvals retain server-only writes and social isolation. Old `isGuest` event payload fields remain accepted and ignored by replay.

Migrations:

- `20261112090000`: session-only schema and per-session normalised-name uniqueness.
- `20261112100000`: session UUID in the page header and null participant-ID guard. Independent random cookies replace the proposed persistent-cookie/HMAC design; no hash rewrites or private-schema USAGE grant.
- `20261112110000`: seven-argument submit bound to the rendered session; removes the unbound six-argument overload, locks/revalidates the session and tag-social before writes, service-role execution only.

The coordinator reports all three applied locally after backup/scratch rehearsal; history and participant checksums preserved. The coordinator replayed all 243 logs / 1,415 events with zero errors. No seed, reset, hosted migration or production action was run by this implementation agent. Parent-owned broader documentation remains outside this task.

Verification is recorded in the implementation handback. Database suites require `REQUIRE_LOCAL_SUPABASE=1`; browser tests use the local stack and real session-only public/host flows. Independent review and schema diff belong to the coordinator before committing or starting the simpler-app feature.

### Verification record (implementation agent)

Commands use Node 24 and the Docker CLI PATH prefixes from the project instructions.

- `pnpm typecheck`: passed.
- `pnpm lint`: passed.
- `pnpm bench`: 2 files / 8 benchmark tests passed (26.81 s); existing performance targets passed.
- `pnpm test --exclude '**/*.integration.test.ts'`: 51 files / 663 tests passed after the closed-state regression fix.
- `REQUIRE_LOCAL_SUPABASE=1 pnpm test --maxWorkers=1`: 57 files / 768 tests passed before the final two closed-state unit assertions (those assertions passed in the subsequent 663-test unit run and focused review). Serial workers avoid concurrent Supabase CLI status/telemetry contention.
- `pnpm exec supabase test db`: 12 files / 449 assertions passed, including null participant-ID rejection and removal of the unbound submit overload.
- Touched source, browser tests, seed source and this plan/ADR: Prettier check passed. Generated database types are excluded by the project's formatter config and regenerated from the applied local schema.
- Full `CI=1 REQUIRE_LOCAL_SUPABASE=1 pnpm e2e --workers=2`: initial production-build run passed 51 tests, with five existing desktop-only project exclusions. Final production-build run also passed 51 tests with the same five project duplicates excluded. Request-time `connection()` removed prerender warnings; fixture cleanup accepts only the exact already-absent invitee result.
- Coordinator: clean all-migrations schema diff; 243 historical logs / 1,415 events replay with zero errors; audit policy passed with zero high/critical and one moderate dev-only minimatch advisory (GHSA-g3hv-75wg-m249). No dependency changes.

Kepler's independent review signed off the rendered-session binding and fresh-form regressions. The final full browser run completed successfully. Foundation implementation is ready for the coordinator’s commit; no simpler-app features were started.
