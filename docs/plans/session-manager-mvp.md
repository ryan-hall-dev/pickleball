# Plan: Social Session Manager — MVP

Status: **Proposed (rev 3), awaiting approval** · 2026-11-07. Rev 3 adds NFC self check-in and makes clear that sessions are independent and several run at once.
Source brief: the "Scalable Pickleball Web App" spec Ryan pasted on 2026-11-07, plus rev-2 feedback: continuous fairness scoring with no hard guard, no exhaustive search, benchmarks, compensating-action undo, and no keep-alive infrastructure.
Designs: `Reference Designs/*.png` for now. The HTML exports (`design/Setup.dc.html`, `SetupConfirm.dc.html`, `Volley.dc.html`) are still to come and become the source of truth for appearance.

Principle: **correctness first, maintainability second, effort third. Nothing that isn't needed for the MVP.**

---

## 1. Decisions already made

| Topic                 | Decision                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Users                 | Hosts run everything. Players only use a public phone check-in page (no accounts, no live view)                                                                                                                                                                                                                                                                                                                                       |
| Sessions              | Socials run daily, and 3–4 can run at once at the club, each with its own host. Attendance differs every session. **Every session is independent:** scheduling uses only that session's data, and nothing carries over between socials                                                                                                                                                                                                |
| Check-in              | Each host has a permanent NFC sticker (with a printed QR code fallback). Scanning opens a check-in page for whatever session that host has open. New players enter name + skill; returning players (recognised by their phone) confirm or edit their saved details. The check-in lands in the host's **pending tray** and the host approves it. If the session is already live, approved players join the waiting queue straight away |
| Platform              | Web app, desktop-first, usable on tablet and phone                                                                                                                                                                                                                                                                                                                                                                                    |
| Hosting               | Vercel (app) + Supabase (Postgres, Auth). Free tiers; separate dev and prod projects. Upgrade only when real usage needs it. No keep-alive jobs                                                                                                                                                                                                                                                                                       |
| Auth                  | One club, several hosts. Invite-only; email 6-digit code login                                                                                                                                                                                                                                                                                                                                                                        |
| Baseline              | Prettier + ESLint, GitHub Actions CI, dev/prod env split, `.nvmrc`, Sentry                                                                                                                                                                                                                                                                                                                                                            |
| Extra pages           | A simple Members page (reuses the setup list and edit form) and a History list of past session reports, as shown in the design's nav                                                                                                                                                                                                                                                                                                  |
| Live updates          | No Realtime. Host screens check for new actions and pending check-ins every 5 s (one tiny query), and on focus or conflict                                                                                                                                                                                                                                                                                                            |
| Designs still to come | HTML exports of the 3 existing screens, plus new designs for the player check-in page (new and returning) and the host pending-check-in tray. Ryan adds them to the reference folder                                                                                                                                                                                                                                                  |
| Folder                | Rename to `/Users/ryan/Projects/apps/pickleball` before scaffolding                                                                                                                                                                                                                                                                                                                                                                   |

## 2. Tech stack (versions checked 2026-11-07)

| Layer     | Choice                                                                                               | Why                                                                        |
| --------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Runtime   | Node 24 LTS (`.nvmrc`), pnpm 12                                                                      | LTS with long support; pnpm is fast and strict about dependencies          |
| Framework | Next.js 16.4 (App Router), React 19.3                                                                | One codebase for the UI and server actions; first-class on Vercel          |
| Language  | TypeScript, pinned to 5.9.x/6.0.x                                                                    | TS 7 isn't supported by typescript-eslint yet                              |
| Styling   | Tailwind CSS 4.3, design tokens in CSS `@theme`, Outfit via `next/font`                              | Tokens from the brief map 1:1                                              |
| UI parts  | Hand-built components + `@dnd-kit/core` 6 / `sortable` 10                                            | The design is bespoke; dnd-kit has keyboard drag and screen-reader support |
| Data      | Supabase Postgres, `@supabase/supabase-js` 2 + `@supabase/ssr` 0.12, generated types. No ORM         | Row-level security works automatically with the host's login               |
| Engine    | Pure TypeScript in `src/engine/`, no React or DB imports                                             | Testable in isolation                                                      |
| Tests     | Vitest 5 (+ `vitest bench`), fast-check 4 simulations, React Testing Library, Playwright 1.65, pgTAP | Simulations and benchmarks across many club sizes                          |
| Errors    | `@sentry/nextjs` 11, production only                                                                 | Know when a live session breaks                                            |
| CI        | GitHub Actions: lint, typecheck, test, build, audit; e2e job on a local Supabase stack               | Never points at a hosted project                                           |

## 3. Architecture

```
Browser (host)                                   Supabase Postgres (RLS: hosts only)
  Setup ─┐                                         members, courts, saved_setups,
  Confirm├─ server actions ─► validate with ──►    sessions, session_participants,
  Live  ─┘   (Next.js)        src/engine, then     session_events (append-only), matches
     ▲                        one Postgres function
     └── state = replay(events); recommendations = engine.recommend(state, now)
```

**The live session is an append-only action log.** Every host action is one row in `session_events`, with a server timestamp and a sequence number. Session state is a pure function: `state = events.reduce(applyEvent, initialState)`.

- **Fully reversible through compensating actions.** Rows are never edited or deleted. Each reversible action type has a defined compensating action, and Undo _appends_ it:

  | Action                                                               | Compensating action                                                                                                                                                                                                                                                                                             |
  | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `MatchStarted`                                                       | `MatchStartReverted` (players back to waiting, wait clocks continue from the original wait start; the false start's play and court time is discarded). Also applies to matches started with `SessionStarted` (Ryan, 2026-11-08); when later actions depend on the match, the host is told to abandon it instead |
  | `MatchCompleted`                                                     | `MatchCompletionReverted` (match live again, games and times restored, `matches` row marked `reverted`)                                                                                                                                                                                                         |
  | `MatchAbandoned`                                                     | `MatchAbandonReverted` (match live again; `matches` row marked `reverted`)                                                                                                                                                                                                                                      |
  | `CourtAdded`                                                         | `CourtAddReverted` (only while no match has used the court and nobody is locked to it)                                                                                                                                                                                                                          |
  | `PlayerReplaced` / `PlayerRemovedMidMatch` (incl. "count this game") | `PlayerReplacementReverted` / `PlayerRemovalReverted`                                                                                                                                                                                                                                                           |
  | `PlayerJoined`                                                       | `PlayerJoinReverted` (as if they never joined; their presence interval is removed)                                                                                                                                                                                                                              |
  | `PlayerLeft` (accidental remove is likely)                           | `PlayerLeaveReverted` (back in, with the time away still not counted as presence)                                                                                                                                                                                                                               |
  | `PlayerSkipped`, `PlayerLocked`, `CourtClosed`                       | `PlayerUnskipped`, `PlayerUnlocked`, `CourtReopened`                                                                                                                                                                                                                                                            |
  | `QueueReordered`, `SuggestionsShuffled`                              | the same action carrying the previous order or seed                                                                                                                                                                                                                                                             |
  | `Paused` / `Resumed`                                                 | each reverses the other (time that passed while paused stays paused)                                                                                                                                                                                                                                            |

  An Undo targets one specific action (`target_seq`). It is accepted when that action hasn't already been compensated **and its compensating action is still valid against the current state**, checked by the same `applyEvent` validation. So the host can fix a Court 1 completion from three actions ago without first undoing other courts' actions. When something later depends on it (e.g. a replacement within that match), the UI says to undo that first. Undo actions themselves are not undoable (no redo in v1). The action history shows who did what.

- **Atomic, server-side updates.** Hosts can't write events directly (INSERT is revoked from the `authenticated` role). A server action replays the log and validates the new action with the same engine code (e.g. "match already completed" is rejected). It then calls one Postgres function that, in a single transaction: verifies the caller is a host, checks `event_id`, checks the sequence, inserts the event, applies any side effect (`matches` row) and bumps `sessions.last_seq`.
- **Duplicate-action protection.** Each action carries a client-generated `event_id` (UNIQUE). The function looks it up **before** the sequence check, so a double click or a retry of an action that already landed returns the original result instead of a false conflict. A genuinely stale action (`expected_seq ≠ last_seq + 1`) is rejected, the screen refreshes, and the host sees "Updated by another host". The UI shows pending and failed states with a retry.
- **Draft settings use optimistic concurrency** (Ryan, 2026-11-09). Every setup settings write (autosave, applying a saved setup) names the `sessions.draft_revision` it built on and bumps it; a stale tab or device is refused (`DRAFT_CHANGED_ELSEWHERE`), stops autosaving and asks the host to reload. Attendance writes are set-based and not versioned.
- **Refresh and reconnect:** reload the log and replay. Timers are derived from timestamps (`now − start − paused time`), using server time plus a measured client clock offset.
- **Pause** stops session time, match clocks, play time, waiting time and presence from accruing.
- **Recommendations are derived, not stored.** They are recomputed from state + settings + a seed after every change. That covers every recalculation trigger in the brief. "Shuffle" records a new seed as an action, so all hosts see the same suggestions. Shuffle only offers lineups whose score is comparable to the best (within a small tolerance); it never offers a worse lineup just to be different. When no comparable alternative exists, the UI shows exactly: "No alternative lineup available without compromising fairness." (Ryan, 2026-11-08)

## 4. Data model

All IDs are UUIDs. Names and display order are never used as identifiers. RLS is on for every table: only users listed in `hosts` can read; writes go through server actions.

| Table                            | Key columns                                                                                                                                                                                                                                                                  | Notes                                                                                                                                                                                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `club_settings`                  | single row: `club_name`                                                                                                                                                                                                                                                      | Shown in the header                                                                                                                                                                                                                          |
| `hosts`                          | `user_id` (→ auth.users), `display_name`, `role` (`admin`/`host`), `checkin_tag` (random, unguessable slug written into the host's sticker URL `/t/<tag>`)                                                                                                                   | Admins invite and remove hosts. A lost sticker gets a new tag, which makes the old sticker stop working                                                                                                                                      |
| `members` (the player directory) | `id`, `first_name`, `last_name`, `skill_level` (beginner/intermediate/advanced), `avatar_url` (nullable), `is_active`, `created_at`, `updated_at`, `last_checked_in_at`                                                                                                      | Created automatically by a player's first check-in, or by a host. Hosts can search, edit and deactivate. Deactivated, never deleted                                                                                                          |
| `member_devices`                 | `token_hash` (PK), `member_id`, `created_at`, `last_seen_at`                                                                                                                                                                                                                 | How a phone is recognised: a random token in a long-lived secure cookie, stored only as a hash. A new phone just means typing their name again                                                                                               |
| `checkin_requests`               | `id`, `session_id`, `member_id` (nullable for a first-timer until approved), `first_name`, `last_name`, `skill_level`, `status` (pending/approved/rejected/withdrawn), `created_at`, `decided_by`, `decided_at`                                                              | The host's pending tray. Approval creates the `session_participants` row, and adds a `PlayerJoined` event if the session is live, in one transaction                                                                                         |
| `courts`                         | `id`, `name`, `is_active`, `supported_formats` (doubles/singles), `sort_order`                                                                                                                                                                                               | The club's courts; a session enables a subset. Only admins add courts (Ryan, 2026-11-09)                                                                                                                                                     |
| `saved_setups`                   | `id`, `host_id`, `name`, `config` jsonb (details defaults, courts, format, target match and changeover minutes, rotation preferences), `last_used_at`                                                                                                                        | "Reuse last" = this host's most recent setup. Attendance is never saved, because it differs every social                                                                                                                                     |
| `sessions`                       | `id`, `name`, `location`, `host_name`, `planned_start`, `planned_end`, `status` (draft/live/ended), `config_snapshot` jsonb (courts as `{court_id, name, format}`, timings, rotation preferences, engine weights), `started_at`, `ended_at`, `last_seq`, `final_stats` jsonb | Snapshots keep history accurate when courts or settings change later                                                                                                                                                                         |
| `session_participants`           | `id` (session-level player ID), `session_id`, `member_id` (nullable), `is_guest`, `first_name`, `last_name`, `skill_level`                                                                                                                                                   | Members and guests share one table, so guests can never collide with members. Names are snapshotted. Join, leave and rejoin come from events. Unique (`session_id`, `member_id`). "Register guest permanently" creates a member and links it |
| `session_events`                 | PK (`session_id`, `seq`), `event_id` UNIQUE, `type`, `payload` jsonb, `occurred_at` (server), `actor_user_id`                                                                                                                                                                | Append-only source of truth                                                                                                                                                                                                                  |
| `matches`                        | `id`, `session_id`, `court_id`, `court_name`, `team_a`/`team_b` (participant ids), `started_at`, `ended_at`, `duration_seconds`, `status` (completed/abandoned/reverted)                                                                                                     | Written atomically with each completion; an undone completion is marked `reverted`, never deleted, so history survives even if a session isn't formally ended. Sessions still live 12 h after `planned_end` are auto-ended when next opened  |

Multi-step writes (start, end, approve check-in, add mid-session guest + its event) are single Postgres functions. Schema changes go through `supabase/migrations` only.

### 4.1 Check-in flow

1. A player taps the host's sticker (or scans its QR code). It opens `/t/<tag>`, a public page with no login.
2. The page finds that host's open session: draft or live, with check-in open. With none open, it says "No social open with this host right now".
3. Follows the design `Reference Designs/Player 1 · Welcome check in@1x.png`.
   - **Recognised phone** (the cookie matches a known player): "This phone was used by Grace Kim" → "Check in as Grace".
   - **"Not you? Find your name":** a search of the player directory. Results appear only after typing 2+ letters, show at most 5 matches, and only while that host's session is open (a privacy guard, since the page is public).
   - **"Not a member? Check in as a guest":** first name, last name and skill level, all required.
   - Choosing a name (the recognised one or a search result) opens the **confirm pop-up**, which shows the saved name and skill to approve or edit.
4. Submit → a `checkin_requests` row with status pending. The player sees "Waiting for the host to approve", and the page updates when the host decides.
5. Within 5 s the host sees it in the **pending tray** (Setup and Live screens) → **Approve** or **Reject**. Approve adds them to the session: to the attendee list in setup, or to the waiting queue (`PlayerJoined`) if live. A brand-new player also gets a directory record, and their phone is linked to it.
6. Hosts can still add someone by hand (no phone, flat battery) from the directory search or as a new player.

Safety without extra infrastructure:

- Two database functions serve the public page: `submit_checkin` and `search_checkin_names`. Only the server can call them (service role, see `docs/decisions/0002-server-only-writes.md`). The `/t/<tag>` server code passes a SHA-256 hash of the phone's device token and an HMAC of the client IP keyed with a server secret, so raw tokens and IPs never reach the database. The search needs an open session and 2+ letters and returns at most 5 names. Both validate every field and reveal nothing beyond names, the host's display name, and the session name, time and headline counts.
- It allows one pending request per phone per session. Every search and submit is recorded and rate-limited per phone, per IP and per session (a count of recent attempts inside the function), including attempts that return early.
- Host approval is the final gate.
- A player can be in only one live session at a time. Approving someone who is live in another social asks the host to move them.

## 5. Scheduling engine

Pure functions in `src/engine/`: `applyEvent`, `recommend(state, settings, now, seed)`, `estimateGames(config)`. Time and a seeded random number generator are passed in, so every result is reproducible.

**Each session is self-contained.** The engine only ever sees the current session's players and events. Games, waits and partner history from earlier socials are never used. Late arrivals (including late check-ins) are handled by the time-present measurements below.

**Scheduling and reporting are separate.** `src/engine/schedule/` makes decisions; `src/engine/report/` measures how fair the session has been. The scheduler never reads the report's numbers, so fairness is measured independently of the decisions being judged.

### 5.1 Objectives (balanced, never absolute)

1. Equal playing opportunities, relative to time present
2. No excessive individual waits
3. Maximum actual playing time
4. Courts used efficiently
5. No consecutive matches where possible
6. Few repeated partners and opponents

**Playing time and Shortest waits are separate objectives** (Ryan, 2026-11-08). Shortest waits reduces individual waiting, especially excessive waits. Playing time distributes actual court minutes fairly relative to time present. Equal games and equal playing time are not the same thing (match lengths vary), and the two terms must not reduce to the same maths.

There are **no hard fairness rules.** Every objective contributes to one score, so no single measurement guarantees or blocks selection. The only hard constraints are validity: a player is on at most one court, every match has exactly _k_ distinct present players (_k_ = 4 doubles, 2 singles), and host locks are honoured.

### 5.2 Measurements per eligible player _i_

Eligible = present, not playing, not skipped. All times exclude paused time. `slot` = target match minutes + changeover. **Every measurement is expressed in games or slots** (times are divided by `slot`), so the terms are comparable and the weights mean the same at any session length. Session-wide sums (Σg, Σp, Σplay, ΣW) are taken over **all present players**, playing or not. A rate whose denominator is 0 (the very first instant) is taken as 0.

| #   | Measurement                        | Definition (games or slots)                                                                                                                                           |
| --- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| m1  | Games played                       | completed games `g_i` vs the session mean                                                                                                                             |
| m2  | Time present                       | `p_i` in slots (excludes skipped and away time); used to scale m3–m5                                                                                                  |
| m3  | Games relative to time present     | `gameDeficit_i = rate·p_i − g_i`, where `rate = Σg / Σp`                                                                                                              |
| m4  | Total playing time (court minutes) | `playDeficit_i = playRate·p_i − play_i`, where `playRate = Σplay / Σp`; partial games count, so long and short matches differ                                         |
| m5  | Total accumulated waiting          | `waitExcess_i = W_i − waitRate·p_i`. Reported only, **not scored**: since `p = play + W` it is exactly `−m4`, so scoring it would duplicate Playing time (2026-11-08) |
| m6  | Current wait                       | `w_i` since they last became available                                                                                                                                |
| m7  | Time since last completed match    | `s_i`. For someone who hasn't played yet, the cap (fully rested)                                                                                                      |
| m8  | Recent participation               | games with exponential decay (half-life 2 slots), so the last few rounds count most                                                                                   |

m3 is how late arrivals are treated fairly: someone who arrived 30 minutes ago has a small fair-share expectation. They're neither unfairly behind nor given excessive priority.

### 5.3 Player priority score

Each term passes through a **saturating transform** `sat(x, c) = c · tanh(x / c)`. It's linear near zero, so small differences matter normally, and it levels off at ±c, so no term can grow without limit and overwhelm the others.

```
P_i =  wFair · sat(m3, cF)              (games vs fair share)
     + wRaw  · sat(mean_g − g_i, cR)    (small: raw game counts players can see)
     + wPlay · sat(m4, cP)              (playing-time share)
     + wWait · sat(m6 + β·max(0, m6 − 1)², cW)  (current wait; urgency rises after one slot, then levels off)
     + wRest · min(m7, 2)               (rested players preferred, capped)
     − wRec  · sat(m8, cRec)            (recent participation)
     − wCons · [just came off]          (consecutive-match penalty, if the rule is on)
     + host override                    (drag-to-reorder; lasts until they next play)
ties → seeded shuffle (never ID or join order, so nobody is favoured week after week)
```

- Because every term is bounded, a player with the longest wait but two extra games, or the fewest games but who just came off, is weighed rather than automatically picked. A simulation test checks that no single term decides more than a set share of picks (threshold fixed during calibration).
- Some measures overlap (time present = play + wait + skipped, so m4 and m5 move together; m7 and m8 too). Calibration sets their weights so the overlap doesn't double-count.
- **Host priority order scales the weights.** Each objective's terms are multiplied by its rank factor (1st ×2.0, 2nd ×1.5, 3rd ×1.2, rest ×1.0):

  | Objective       | Terms it scales                             |
  | --------------- | ------------------------------------------- |
  | Equal games     | wFair, wRaw                                 |
  | Shortest waits  | wWait (current wait, steeper past one slot) |
  | Playing time    | wPlay                                       |
  | Full courts     | court filling (§5.5)                        |
  | No back-to-back | wCons, wRest, wRec                          |
  | Mix partners    | wPartner, wOpp                              |

  The rule toggles switch terms on or off. Tests prove that reordering priorities measurably changes outcomes.

- **Default weights and caps are calibrated in M1 by simulation** against the report metrics (fairness index, game spread, max wait, utilisation), then fixed and documented in `docs/engine.md`. They aren't exposed as raw numbers in the UI.

### 5.4 Choosing the best group (no exhaustive search)

Group value for a court:

```
U(G) = Σ P_i − wPartner·repeatPartners − wOpp·repeatOpponents − wSkill·skillImbalance
```

(Partners, opponents and skill are scored for the best team split. Doubles has 3 possible splits; singles has 1, so there are no partner terms.)

1. Score every eligible player: O(n).
2. Shortlist the top `k + s` players by `P` (`s` = 6) with a partial sort: O(n).
3. **Greedy start:** locked players take their seats; the rest is filled with the top scorers by `P`.
4. **Swap improvement:** try swapping each unlocked group member with each shortlisted outsider, and take the best swap that improves `U`. Repeat until no swap helps, capped at 10 rounds. That's at most k·s·3 evaluations per round, about 72 for doubles.
5. Result: a strong group, normally one that no single swap can improve (the cap guarantees a fast finish), found in microseconds. We never enumerate all combinations.

### 5.5 Several courts and Up next

- Every court that is free _now_ gets a "Ready now" group. When several are free at once, groups are built one at a time (highest-value first), then a cross-court swap pass reduces repeats between them.
- Busy courts are ordered by expected free time: start + expected length (the target until the session has its own average; an overdue court counts as freeing now). We simulate forward: each court's pool is the waiting players plus those expected off earlier courts, with their scores recomputed at that forecast time. Only "Ready now" groups are final.
- **Court use:** in the MVP, a free court always gets a group whenever at least _k_ players are eligible; otherwise it shows "Not enough players". Fairness is protected by the continuous score choosing _who_ plays, not by leaving courts empty. Holding a court for a few minutes for fairer players is deferred: we'll measure in M1 simulations whether it would help and propose it only if it does.

Cost per recommendation: O(C · n) for C courts and n eligible players. There is no combinatorial growth.

### 5.6 Reasons

Each group's reason names its strongest contributing terms, e.g. "All four on 2 games, 1.2 below fair share", "Rested 4–8 min, no back-to-back", "Court 1 finishers picked over Court 3: fewer recent games".

### 5.7 Fairness reporting (separate module)

- **Games:** min, mean, max, spread, standard deviation, and each player's difference from fair share (m3).
- **Playing time:** min, mean, max, standard deviation.
- **Waiting:** current mean and max; accumulated mean, max and standard deviation.
- **Court utilisation:** court-minutes in use ÷ court-minutes available (excluding pause and closures).
- **Jain's fairness index (games, 0–100):** `x_i = (g_i + 1)/(e_i + 1)`, where `e_i` is the fair-share expectation from m3. `J = (Σx)² / (n·Σx²) × 100`. 100 means everyone has had exactly their fair share for the time they've been present; the lowest possible value is 100/n. The +1 keeps just-arrived players from distorting it.
- **Jain's index (playing time):** the same formula on play-time share.
- The index shows "—" before any game is completed or with fewer than 2 present players. Estimates are always labelled "≈" or "est."; actuals never are.

### 5.8 Estimated games per player

`rounds = floor(duration / slot)`. `seats` = sum of _k_ over the courts that can actually be filled, largest first, until players run out. `estimate = rounds × seats / players`, computed from the actual session duration, match minutes and changeover, and shown as a range (e.g. 120 min with 15 + 2 min slots: "About 7 rounds fit in 120 min, so expect N–M games each", where the games range depends on seats and players). Edge cases: fewer players than the smallest court needs → "Not enough players"; duration shorter than one slot → "Fewer than one full round".

### 5.9 When equal participation is impossible

A spread of ≤ 1 is the target, not a promise. Late arrivals, departures, court closures, very uneven match lengths, a small pool versus the consecutive preference (e.g. 5 players, 1 court) and host overrides can all prevent it. Simulations measure how often and by how much, and the results are documented in `docs/engine.md`.

## 6. Testing and benchmarks

**Engine scenario tests:**

- fewer players than courts; exact fill; overflow; counts not divisible by _k_; singles and doubles mixed
- a large club; late arrivals; departures and rejoin
- insufficient eligible players
- consecutive avoidance; partner and opponent repeat reduction; skill balance
- locks and manual reorder; court closure and reopening
- pause and resume
- undo through compensating actions for every action type, including undo chains
- different session and match lengths

**Behaviour tests (that it balances rather than follows rules):**

- the longest-waiting player isn't automatically picked when well ahead in games, and the fewest-games player isn't automatically picked right after coming off
- raising an objective's rank moves the outcome in that direction (e.g. "Shortest waits" 1st lowers the max wait in simulation)
- a late arrival ends within about one game of their fair share
- the repeat-partner rate is well below a random-grouping baseline
- no single score term decides more than the calibrated share of picks
- with all players equal at the start, first-match selection is unbiased across seeds (no ID or join-order favouritism)

**Simulations (fast-check):** whole sessions with random membership (0–2,000), attendance (0–500), courts (1–50), formats, match lengths (8–25 min), durations (30–240 min), and arrivals and departures. The hard invariants must always hold:

- nobody is on two courts at once
- every match is valid
- statistics reconcile with match records
- undo restores the exact prior state

Quality targets, tracked and documented (the scheduler doesn't enforce them):

- spread ≤ 1 in steady-state configurations in ≥ 95% of runs
- Jain ≥ 95
- utilisation ≈ 100% whenever players ≥ seats
- bounded max wait

Failing seeds become permanent regression tests.

**Benchmarks (`vitest bench`)**, small to large (e.g. 8 players/2 courts, 30/4, 120/12, 500/50; membership up to 5,000). Targets:

- `recommend()` p95 < 5 ms at 500 attendees / 50 courts
- a full simulated 2-hour session at that size < 1 s
- replaying a 1,000-action log < 5 ms

Results are recorded in `docs/engine.md`.

**Database tests (pgTAP):**

- a non-host sees nothing, direct inserts are refused, the sequence check works, a duplicate `event_id` is idempotent, and the start, end and complete functions are atomic
- an anonymous visitor can only call `submit_checkin`, can't read any player data, and is rate-limited
- approval is atomic

**End-to-end (Playwright):**

- host: login → setup → confirm → live → complete → undo → refresh mid-session → second tab acts (conflict handled) → end → report
- check-in on a phone-sized browser: first-time check-in → host approves → appears in setup; returning player is recognised and confirms details; late check-in during a live session → approved → joins the queue; two hosts' concurrent socials stay separate

**Small-config scenario tests in the engine:** a session that grows from 3 to 40 players through late check-ins, to show the time-present fairness holds.

## 7. Milestones (each verified before the next starts)

| #   | Milestone                                                                                                                                       | Done when                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| M0  | Scaffold: Next, Tailwind tokens, Outfit, local Supabase, lint, tests, CI, Sentry, docs                                                          | Quality checks green; the app renders                                                     |
| M1  | Scheduling engine + report module + simulations + benchmarks                                                                                    | All engine tests pass, quality targets measured, benchmarks met, `docs/engine.md` written |
| M2  | Action log: `applyEvent`, compensating undo, pause, timers (pure)                                                                               | Lifecycle and undo tests pass for every action type                                       |
| M3  | Database + auth: migrations, RLS, write functions, OTP login, host invites, demo data script (`pnpm seed --members N --courts N --attending N`) | pgTAP passes; login works locally; an empty database works                                |
| M4  | Setup screen + Members (player directory) page                                                                                                  | Matches the design; works with 0, 5 and 300 players                                       |
| M5  | NFC/QR check-in: public check-in page, phone recognition, pending tray, approve/reject, host sticker tag + printable QR                         | e2e check-in flows pass on a phone-sized browser; matches the check-in designs            |
| M6  | Confirm modal + Start                                                                                                                           | Engine preview, shuffle, warnings; atomic start                                           |
| M7  | Live dashboard + every action + late check-ins + refresh recovery + multi-host safety                                                           | e2e lifecycle passes; two tabs never corrupt state                                        |
| M8  | End session, final report, History list                                                                                                         | Report reconciles with match records                                                      |
| M9  | Responsive, accessibility (AA, 44 px targets, status never by colour alone), README incl. how to write a host's NFC sticker                     | `/quality-check` green; ready for your OK to deploy                                       |

Engine and action log (M1–M2) are proven before any UI is connected.

Carried into M5/M8 from M3:

- M5: "a player can be in only one live session at a time" is checked when approving (it needs a replay of the other live session, so it isn't a database constraint). M5 also needs a server-side read for the check-in page header, phone recognition and request status.
- M8: `end_session` takes `p_final_stats` (jsonb) for the final report; M3 passes nothing yet.

Carried into M6 from M4:

- Start must re-read the selected courts by id (active, supporting the format, current names) rather than trust the draft's `config_snapshot.courts`, which can hold a court deactivated or renamed after the last save. `matchFormat` in the draft snapshot is draft-only; `start_session` replaces the snapshot with the `SessionStarted` config.
- Sessions may run past midnight: an end time at or before the start time means the next day (2026-11-09).
- Start must copy the draft's `rotation` (objective order and all six rules) into the SessionStarted config unchanged; M6 acceptance includes an e2e asserting the started session's `config_snapshot.rotation` equals what the host set in Setup (Ryan, 2026-11-09).
- Start must leave the draft-only `appliedSavedSetupId` (and `matchFormat`, see above) out of the SessionStarted config.

## 8. Interpretations of the brief (no decision needed unless you disagree)

1. "Skip temporarily": the player stays skipped until the host un-skips them. Skipped and away time doesn't count as presence. Players who leave and return keep their stats.
2. Drag-to-reorder: a host override on the score, which lasts until those players next play. Move-up and move-down buttons are provided for keyboard and touch users.
3. Lock: pins a player, or a whole suggested group, to an upcoming court; the engine fills around them.
4. Removing a player mid-match counts as a replacement: partial play time is recorded and no game is counted, unless the host ticks "count this game".
5. Estimates use target match minutes (default 15) + changeover (default 2), both set in setup.

## 9. Risks

| Risk                                                                           | Mitigation                                                                                                      |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Scoring weights feel wrong in real sessions                                    | Calibrated by simulation; host priority order adjusts them; reasons shown; tuning after the first real sessions |
| Two hosts acting at once                                                       | Sequence check + idempotent `event_id` + server validation + one-transaction writes                             |
| Timer drift and wrong device clocks                                            | Server timestamps, client clock offset, timers derived from timestamps                                          |
| Design fidelity                                                                | HTML exports needed before M4, check-in designs before M5; side-by-side screenshot comparison in M4–M7          |
| Fake or remote check-ins (sticker links can be shared)                         | Host approval on every check-in, rate limits, one request per phone, and the host can reissue a sticker's tag   |
| Phones without NFC, or with NFC switched off                                   | QR code printed on the same sticker opens the same link                                                         |
| Players switching phones or clearing cookies                                   | They just type their name again; the host can edit or deactivate duplicates in the directory                    |
| Supabase free tier pauses after about a week of inactivity, and has no backups | Accepted for now. Restore from the dashboard if it pauses; upgrade when real usage needs it                     |
| Very new tool versions (TS 7, ESLint 10, Vitest 5)                             | Pin versions; fall back to ESLint 9 if plugins lag                                                              |
