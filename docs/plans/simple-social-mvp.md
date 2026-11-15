# Simple social MVP: check in, see the wait, prepare the next four

Status: **in-progress — approved by Ryan, 2026-11-15**. Finish the interrupted session-only foundation first, then build the simpler version in small tested commits. Nothing is pushed or applied to the hosted project.
Branch: `feature/session-manager-mvp`.
Date: 2026-11-14. Updated with the subsequent decisions made in this conversation.
Phone mockup: `docs/designs/simple-social/phone-review.html` (design review only; illustrative data).

## Goal

Help a host run a social from their phone: know who is here, see their level and how long they have waited, and tell the next four players which court they will use before the current game finishes.

The app succeeds if it reduces guessing and forgotten players without making the host spend longer operating it than organising the game. Correct code and a fast scheduling benchmark alone do not prove this.

## Agreed product behaviour

- Each session has its own players. Players enter their details again at the next session; no membership, accounts or cross-session player identity.
- QR/NFC opens the social's current session. Name and playing level (Beginner / Intermediate / Advanced) are required; a host approves or rejects. Keep the session information card and the agreed privacy and duplicate-name rules.
- Add the previously requested male/female field so the app can form the allowed doubles groups. This has been requested but is not implemented in the inspected participant type.
- The host sees a waiting list, longest wait first, with each player's name, level and waiting time.
- Preselect the longest-waiting eligible players as the next group for each court, while that court is still occupied. The host can tell them early and replace a selected player.
- A game finishing sends all four players back to waiting; their new wait starts at completion. They do not stay on the court automatically.
- Players marked as playing do not accumulate waiting time. New arrivals begin their wait when approved into the running session; approval before session start begins their live wait at session start.
- Rest lasts **10 actual minutes**, then the player returns automatically, with **Ready now** available sooner. Keep the waiting time earned before resting; freeze it during rest, then resume it on return. Closing the host phone does not delay the return.
- Game-type variety is a preference: try to avoid a third mixed, men's or women's game in succession. For the first trial, allow **at most 2 additional minutes of waiting** for variety, and never leave a court empty for variety alone. Hard group-validity rules still apply.
- Allowed doubles groups are a hard rule: four men, four women, or two men and two women with one of each on each team. No 3:1 groups, including host-edited assignments. This rule can leave a court empty.
- A host stays in control of final assignments; suggestions do not start games automatically.
- **Doubles only**. The host enters a court count; the app labels the game cards Court 1, Court 2, etc. These labels identify games and do not determine player priority, start times or finish times.
- **Call these four** fixes the next group and shares it with co-hosts. The host can replace someone; the group does not silently change after being called. Their waiting clocks continue until Start game.
- Once Start game is recorded, that court requires no input until it finishes; there is no scorekeeping, predicted finish or automatic completion.
- A rare **Replace player** action sits in the court menu and accepts an available player only if the group and teams remain valid. A basic **Undo** corrects accidental starts and finishes only when later actions permit a safe reversal.
- **No Pause session control.** The chosen session duration runs continuously.
- At the scheduled end, show **Session time is up**, stop new suggestions and starts, let active games finish, then the host confirms **End session**. Called-but-not-started groups cannot start after the time limit.
- Keep ended-session data for operator evaluation and improving the app; no host History screen or reports. New sessions start fresh. Operator analysis should minimise personal data and never feed old attendance into new scheduling.

## Proposed phone workflow

### Before play

One short setup: session name, date/time or duration and the **number of courts**. The host does not enter a court catalogue or configure court priority; the app generates court labels from the count. Internal court IDs remain necessary to distinguish games reliably. Show the QR code and approve arrivals. A simple Start action begins the session; no separate generated-lineup/shuffle confirmation screen. Keep validation and a clear confirmation of the session being started.

### During play

One live screen with three areas:

1. **Courts:** current four players and a large Game finished action.
2. **Up next:** four suggested players per court; the host can confirm that group or replace a person before calling their names.
3. **Waiting:** longest wait first, name, level, wait, and an action to rest or mark a player as having left. Resting players show a return countdown separately.

The host taps Game finished, then Start these four when the prepared group actually goes on. These are separate moments because a court can sit empty during a changeover. Do not start the next game or reset its players' waiting clocks merely because the previous game ended.

**Agreed stability rule:** before the host calls a group a suggestion may update; once the host confirms/calls a group, keep it stable and visible to co-hosts. A player cannot be confirmed for two courts. Selection does not stop their wait. If a confirmed player rests or leaves, flag the vacancy and require a replacement rather than silently changing a group the host has already announced. Ryan approved the phone mockup on 2026-11-14. A replacement for a called group is explicitly confirmed by the host.

### After play

The session duration cannot be paused. At its scheduled end stop creating suggestions and starting games, but leave active games running until the host finishes them. Then offer End session with confirmation; release any unstarted called groups. Keep attendance and match history for operator evaluation, without adding a host History or reports screen. No automatic data deletion is authorised. A new session never imports those players or their history.

## How next-four selection becomes simpler

Replace the six adjustable objectives with one fixed policy. There is no Rotation settings screen.

1. Exclude players who are playing, resting, absent or already committed to another court's next group.
2. Prefer the oldest waits that can form a valid men's, women's or mixed group; validate teams as well as the four-person group.
3. Use recent game type as a preference, subject to the agreed **2-minute maximum extra wait** for the first trial. It must not cause indefinite bypassing of a longer waiter or an empty court solely for variety.
4. Show a plain reason when the oldest waiter cannot be selected, for example insufficient eligible players for an allowed group.
5. Let the host replace someone, enforcing the same hard rules on the server.

Do not carry the old weighted score forward merely behind a simpler screen: its outcomes can prioritise games/minutes/pair history over the longest waits. The new selection policy needs explicit tests of its own. Reuse proven interval arithmetic, validity checks and event handling where their behaviour matches.

Ryan agreed a 2-minute starting limit for the first trial: someone waiting 15 minutes may yield to someone waiting 14 minutes for variety, but not someone waiting 10 minutes. The implementation must also enforce the actual extra-wait bound across repeated decisions: it cannot repeatedly reset the allowance and keep skipping the same player. When that limit would be exceeded, waiting wins over variety. Revisit the limit using the pilot evidence rather than introducing adjustable weights.

**Feasibility detail to resolve before coding:** a 2-minute difference between two players' current waits does not guarantee that the bypassed player can start a game within another 2 minutes. Games finish at unpredictable times. Preserve Ryan's limit as the requirement, but work through that example before choosing an algorithm; do not silently reinterpret it as only a comparison of waiting times, or add finish-time predictions to claim the guarantee. When variety cannot safely fit the agreed allowance, the conservative outcome is to prioritise waiting.

**Conservative implementation for the first trial (2026-11-15):** the app does not bypass an older eligible player solely for variety when it cannot establish that extra delay is within the allowance. When several courts are available together, select the oldest feasible player set first, then improve mixed/same-sex variety by partitioning that same set into valid games. This uses none of the two-minute allowance and preserves the selected players. With one court, variety may have to yield entirely; do not pretend a younger waiter's age difference predicts when the older player next plays. Report this practical limitation for the pilot. No court-finish predictions or adjustable weighting controls are introduced.

Work through edge-case examples before coding: the oldest four being an invalid 3:1 group, equal waits, two courts competing for the same people, and repeated third-game avoidance that could cumulatively delay one player. **Do not use court-number order or predicted finish order as a player priority**: Ryan rejected that approach. The host chooses which game to prepare; uncalled suggestions and same-time choices still need a deterministic, non-starving implementation. Proposed streak accounting is per player, based on completed games in this session; define whether an abandoned game counts before implementation. Women's/men's games are the same-sex category for that player's variety; mixing partners is a separate deferred objective.

## What we keep, remove and defer

Inspected 2026-11-14 against both committed files and the existing uncommitted session-only work. “Built” means code exists, not that the current combined working tree has been verified in this planning task.

| Area                                                                   | Current implementation/status                                                  | Proposal for the simple version                                                                                                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name + level check-in, host approval, QR/NFC                           | Built in M5; session-only conversion interrupted/uncommitted                   | **Keep and finish** session-only conversion. No lookup, recognition or reuse next session. Add male/female for valid groups.                                                          |
| Members directory and member/guest distinction                         | Built previously; deletions and schema changes already in the working tree     | **Remove as already approved.** Preserve historical participant snapshots and IDs.                                                                                                    |
| Socials, host login and manager permissions                            | Built                                                                          | **Keep.** They protect independent socials; they are not steps the host must repeat for each game.                                                                                    |
| QR display, print and link reissue                                     | Built                                                                          | **Keep**, accessible as needed rather than in the game workflow.                                                                                                                      |
| Setup details, court selection, autosave and conflict detection        | Built                                                                          | **Simplify the screen** to the session details and court count; generate court labels. Keep saved draft safety and social isolation. Physical court management is outside this flow.  |
| Rotation card with six reorderable priorities and six rule switches    | Built: `RotationCard.tsx`, `rotationOptions.ts`                                | **Remove from the first version**, including exposed manual-assignment permission toggle. Hosts can change lineups, subject to hard validity.                                         |
| Saved setups, reuse banner and their save/apply UI                     | Built: `SavedSetups.tsx`, saved-setup server actions/functions                 | **Defer UI; remove active save/apply paths when safe.** Keep existing saved data until a separate retention decision. Ordinary draft autosave stays.                                  |
| Five-step setup progress and detailed summary/checklist                | Built: `SetupStepper.tsx`, `setupReadiness.ts`, `SessionSummary.tsx`           | **Replace** with compact readiness messages and one Start action. Preserve the underlying checks; remove rounds/games estimates and the large capacity graphic from the pilot screen. |
| Weighted fairness and calibrated rank factors                          | Built: `schedule/priority.ts`, `weights.ts`, `groupSearch.ts`                  | **Replace for new simple sessions** with wait-first selection plus the agreed variety preference and hard group rules. Retire old-only code after compatibility review.               |
| Exact predicted court-free times and projected future pools            | Built: `schedule/recommend.ts`                                                 | **Remove from the new workflow.** Prepare next groups from players available now; do not promise a busy player to another court based on an estimated finish.                         |
| Shuffle and repeated-partner/opponent optimisation                     | Built in engine, no live UI yet                                                | **Defer.** Mixed vs same-sex variety remains; it is a different requirement from partner rotation.                                                                                    |
| Separate confirm-and-start modal                                       | Reference design and M6 plan; functional flow not built                        | **Do not build as previously planned.** Use the small start confirmation above.                                                                                                       |
| Live dashboard                                                         | Reference design, engine and write functions exist; live route not built       | **Build a smaller phone-first screen**, rather than porting the large dashboard.                                                                                                      |
| Waiting clocks and match/presence history                              | Built: `session/metrics.ts`, `intervals.ts`, handlers                          | **Keep and adapt carefully.** Timers must survive reloads, rest and co-host activity.                                                                                                 |
| Timed rest and gender/game-type variety                                | Not built; current skip is indefinite and participant has no male/female field | **Add only what this workflow requires.** Existing skip is not already timed rest.                                                                                                    |
| Generic queue dragging, per-player locks, random shuffle controls      | Engine support built, live controls not built                                  | **Do not expose.** A confirmed next group is the one explicit commitment the phone workflow needs. Keep old replay handlers for old events.                                           |
| Every-action undo UI, mid-match removal/credit menus                   | Engine support built, live controls not built                                  | **Defer broad menus.** Retain a small recovery path for an accidental start/finish and the ability to handle an interrupted game. Historical replay handlers stay.                    |
| Detailed fairness reports, Jain index, final charts and History screen | Pure report code built; report/history pages not built                         | **Remove host-facing history/reports from scope.** Keep stored session history and useful measurement helpers for operator evaluation.                                                |

**Additional reductions now agreed:** no Pause session control, no Singles format selector, no manually named court list in Setup, and no host-facing past-session screen. Keep legacy pause/singles event handling only where existing history needs it.

This is a reduction in visible product and future work, not a database purge or a rewrite of authentication, social isolation or the event log.

## Implementation boundary and current unfinished work

- There are extensive existing uncommitted changes from the interrupted session-only increment. Preserve them; do not reset, stash or accidentally commit them with this plan.
- That increment is not recorded here as complete. The earlier chat reported a failed scratch migration rehearsal, pending device-hash migration application and remaining follow-up tests. This planning audit has not re-verified those database facts; verify current status explicitly before any resumed build.
- The latest discussion replaces the previously planned M6–M8 user experience only after this plan is approved. Existing approved history/privacy protections remain requirements.
- Planning and static mockup review changed no application code. Implementation is now authorised (2026-11-15); proceed from the interrupted foundation, keeping data safeguards below.

## Decisions recorded in this conversation

| Decision              | Agreed behaviour                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Rest duration         | 10 real minutes; automatic return; Ready now can end the rest earlier.                                                            |
| Rest waiting time     | Keep earned waiting, freeze it during rest, resume it afterwards.                                                                 |
| Variety               | Soft avoid-third preference; at most 2 additional minutes of waiting for the first trial; never an empty court for variety alone. |
| Called group          | Fixed once called; co-hosts see it; host controls replacements. Wait continues until actual start.                                |
| Courts                | Host enters how many; automatic labels distinguish games; court numbers do not set priority.                                      |
| Playing levels        | Beginner / Intermediate / Advanced, displayed for host judgment.                                                                  |
| Format                | Doubles only. Previously agreed gender composition applies to suggestions and manual changes.                                     |
| Mid-game replacement  | Rare action in the court menu; available replacement must keep the group/teams valid.                                             |
| Accidental action     | Basic Undo on start/finish only while a reversal is safe.                                                                         |
| Pause                 | No session pause; duration runs continuously.                                                                                     |
| Time limit            | Stop new suggestions/starts; existing games finish; host ends the session afterwards.                                             |
| Ended-session records | Keep for operator evaluation and app improvement; no host history/reports or cross-session scheduling.                            |

Ryan approved the phone mockup on 2026-11-14 and authorised implementation on 2026-11-15. The decisions above and the approved mockup govern the build.

## Remaining review details

- **Phone layout:** `docs/designs/simple-social/phone-review.html` is the approved reference for the short Setup, Courts/Up next, Waiting/rest, Check-ins and replacement flow. It uses the existing design tokens with a phone-first layout.
- **Edge-case examples:** confirm the scheduling interpretation with valid/invalid first-four groups, equal waits and competition for players across courts. No court-number priority or automatic finish-time forecast. The exact suggested allocation interaction remains a proposal in the mockup.
- **Recovery:** Ryan approved replacement and basic Undo, but did not explicitly decide the rare case when nobody can replace an injured player. Do not silently introduce short-handed play; flag the exceptional end-game behaviour before implementing it. Define the small number of safe abandon/undo clock cases with examples.
- **Measurement and retention:** agree the pilot measurements before claiming a successful trial. Data stays for now; no extra personal-data collection, global identities, automated deletion or new operator analytics dashboard is authorised.

Do not add persistent “men's only/women's only next game” preferences yet: Ryan asked to reduce the need for those requests through variety, then approved the soft variety rule. If requests remain common in the pilot, assess them then.

## Small implementation increments after approval

Each increment is implemented, reviewed, tested, committed on the existing branch and reported before the next. No new dependencies are proposed. Tasks are sequential to avoid conflicts with the existing working tree.

1. **Finish the session-only foundation** — agent: implementer. Follow `docs/plans/session-only-participants.md`, reconcile existing migrations/tests and fresh-session device behaviour. Do not expand this into new live UI. Files: its two `20261112*.sql` migrations, `supabase/tests/`, existing `src/server/checkin/`, `src/server/setup/` and participant types. Report any incomplete browser flows honestly.
2. **Minimal session rules** — agent: implementer. Deliver in two tested sub-increments: **2a**, the pure policy, scheduling and additive event contract; **2b**, participant gender persistence and server validation/wiring. Add required male/female data for new sessions, hard group/team validation (manual and suggested), timed rest, and waiting/variety selection using injected time. Files: new migrations, `src/engine/session/`, `src/engine/schedule/`, `src/server/submitSessionAction.ts`, affected check-in/setup schemas. Preserve legacy replay; never guess gender for historic players.
3. **Simplified Setup and start** — agent: implementer. Remove the controls listed above, collect the necessary participant field, provide short validation and start confirmation, wire the existing atomic start transaction to the new rules. Files: `src/app/(host)/setup/`, `src/server/setup/`, affected check-in form, shared server validation.
4. **Phone live workflow** — agent: implementer. Courts, Game finished, next-four suggestions, host replacements, waiting list and timed rest. Complete the live check-in approval path: the database supports it, but today's host action does not provide the full flow. Persist the agreed called-group commitments for co-hosts; define cancel/release, replacement, court closure and session-end behaviour. Revalidate eligibility and hard group/team rules at actual start, even for a confirmed group. Suggestions remain derived. Files: new live route, existing session actions/handlers, minimal supporting migrations only as required.
5. **Prune and pilot** — agent: implementer/researcher. Remove unreferenced old UI and old-only runtime scoring paths, retain replay/compatibility and useful tests, update `DESIGN.md`, `AGENTS.md`, ADRs and old plans. Run a real social pilot before adding further features.

## Verification and acceptance

- pgTAP/integration: same-session normalised-name uniqueness under concurrent approve/add, session-scoped device access, fresh details next session, social isolation, authorisation and atomic start/finish/next-group writes.
- Rest and confirmed-group writes enforce the same authorisation, social isolation, idempotent retries and stale-sequence rejection as match actions. Rest deadlines are persisted; eligibility is derived from injected current time, without requiring a background job or open browser.
- Pure tests with fixed clocks: wait stops while playing; completion starts a new wait; rest expires without needing an open host tab; early return; preserved earned waiting time, frozen accumulation during rest and a real-time rest deadline; correct men's/women's/mixed grouping; reject 3:1 and invalid mixed teams on every manual write; variety never overrules hard validity and respects the agreed waiting bound.
- Simulations: oldest eligible players aren't indefinitely bypassed, players can't be double-booked across courts, hard-valid groups fill courts whenever feasible, variety can yield to waiting/filling, all same-sex rosters still work.
- Phone browser journey at 390 px: check in → approval → waiting → Up next → host replacement → game starts → game ends → waiting again; rest and return; scheduled end blocks starts but lets active games finish; no pause control; late arrival; player leaves; interrupted game; accidental action recovery; reload and two co-hosts racing. Offline/failed writes never display uncommitted assignments as successfully started.
- Before each implementation commit: review the actual diff, run relevant database tests and the project's typecheck, lint, formatting, unit/integration tests, build and affected e2e. New selection performance is measured at representative sizes; old weighted fairness targets are historical baselines, not proof of this policy.
- **Real-world pilot:** observe one host using their phone during a social. Compare time to prepare/send a group, time spent looking at the screen, missed/long waits, and replacements with the host's normal process. Proposed acceptance: the ordinary finish/start sequence needs two main taps with no mandatory modal, the host can prepare a group before completion, and it is no slower than their usual process. Agree the pilot's measurement criteria before calling it successful; no live user trial has been done yet.

## Data and release safety

- Implementation is approved (2026-11-15). Only the local project/database may change, subject to the backup and rehearsal safeguards below.
- Before approved migrations: fresh backup with a restore verification; rehearse on a separate scratch copy, including existing duplicate-name checks and log replay. No reset of Ryan's working database, hosted changes, seed run or cleanup of his existing test socials. Disposable scratch/test databases may be recreated, and tests clean up only fixtures they created.
- Preserve session/participant UUIDs, event/match records and historical configuration snapshots. Removing a screen or retiring a new-session scoring path must not break old-log replay or erase data.
- Do not delete saved setups or old scoring configuration as part of removing their UI. Stop offering them for new sessions, and keep legacy fields compatible until a separate data-retention choice.
- New male/female and timed-rest rules need explicit compatibility for old events without those fields. Ended sessions remain readable; any old active session needs host-supplied missing data before new group rules apply. Never fabricate historical values.
- Rollback pairs the pre-change code commit with its verified backup if a schema change prevents running the old code. Any restore needs Ryan's approval because it discards later local writes. Post-change checks include replaying existing logs, comparing preserved record counts, and verifying social isolation.

## Log

- 2026-11-15: increment **2a complete**, pure `simple-social-v1` policy plus three additive called-group event values. Required new-policy gender/level and doubles validity, injected-time ten-minute rest, frozen earned waiting, fixed calls/vacancies, safe consumed-call restoration on start Undo, manual replacement checks and deadline rules are implemented. `simpleRecommend` selects the oldest feasible set and limits variety regrouping to simultaneously free courts. Independent frozen-source review signed off. Checks: 800 unit/integration tests; 51 browser tests with five duplicate-project exclusions; 449 database assertions; production build, typecheck, lint and formatting; eight legacy benchmarks passed on the idle rerun (initial 500/50 p99 was 12.26 ms against its unchanged 5 ms threshold); clean all-migration schema diff; archived 243 logs / 1,415 events replay without errors. Backup `backups/pre-simple-rules-3610972-20261115.dump` was restored and the enum migration rehearsed before local application; existing record counts were unchanged. No gender backfill, participant-field migration or UI wiring has happened yet. **2b is next; the complete simpler workflow remains in progress.**

- 2026-11-15: session-only foundation committed as `3610972`. Independent security/data review passed; 449 database assertions, 768 unit/integration tests (plus the final 663-unit rerun), 51 browser tests, eight benchmarks, production build, typecheck, lint, full formatting and clean migration/schema comparison passed. Five duplicate browser-project cases were excluded, not deferred product journeys. Historical replay checked 243 logs / 1,415 events with zero failures. Audit: zero high/critical, one moderate development-only minimatch advisory. Next increment implements pure simple-session rules before database/UI wiring.

- 2026-11-14: recorded the conversation decisions above and added a separate phone-screen design draft. Read-only review completed; static browser layout/interaction checks passed at 320/390/1440 px (details in the mockup README). No application code, migrations or existing uncommitted work changed. Awaiting Ryan’s screen review and implementation approval.

- 2026-11-15: Ryan authorised finishing session-only participants first and then implementing the simpler workflow in small tested commits. Phone design accepted; hosted project and push remain out of scope.
