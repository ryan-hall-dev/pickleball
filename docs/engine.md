# Scheduling engine

How `src/engine/schedule/` decides who plays next and how `src/engine/report/` measures how fair a session has been. Plan: `docs/plans/session-manager-mvp.md` §5 and §6. Measured 2026-11-07 (M1, revised after review).

## Layout

| Path                                     | What it does                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `schedule/types.ts`                      | `ScheduleInput` (a plain snapshot) and `Recommendation`                                                                              |
| `schedule/scheduleInputFromSession.ts`   | Builds the snapshot from a replayed session: `recommend(scheduleInputFromSession(state, now))`                                       |
| `schedule/priority.ts`                   | Measurements m1-m8, the priority score P (§5.2-5.3), forward projection, and the forecast pruning bound                              |
| `schedule/weights.ts`                    | Default weights and caps, rank factors, rule toggles                                                                                 |
| `schedule/groupSearch.ts`                | Best group for one court: short list, greedy start, swap improvement, best team split, fair alternatives (§5.4)                      |
| `schedule/recommend.ts`                  | Ready now groups, cross-court swap pass, Up next forecasts (§5.5)                                                                    |
| `schedule/reasons.ts`                    | Host-readable reasons (§5.6)                                                                                                         |
| `schedule/estimateGames.ts`              | Games-per-player estimate for setup (§5.8)                                                                                           |
| `schedule/simulation/simulateSession.ts` | Test support: drives whole sessions through the real `applyEvent` with `recommend` (or random groups), including random host actions |
| `report/fairnessReport.ts`               | Games, playing time, waits, utilisation, Jain's indexes (§5.7)                                                                       |
| `report/simulationQuality.ts`            | Test support: quality numbers for a simulated session                                                                                |

`schedule/architecture.test.ts` enforces that the scheduler never imports `report/`, and that engine code never imports React/Next/Supabase or calls `Date.now()`, `new Date(` or `Math.random()`. The quality helpers live in `report/` because they combine the simulator with the report.

## How a recommendation is made

1. **Snapshot.** `scheduleInputFromSession` turns session metrics into plain numbers: per present player (games, time present, playing time, waiting, current wait, time since last match, ages of completed games, partner and opponent counts, lock, manual rank, current court) and per open court (format, elapsed time of the match in progress). Paused time is excluded everywhere. Players who left and closed courts are left out. The seed is the session's suggestion seed mixed with the number of completed matches (see Shuffle).
2. **Score.** Every measurement is converted to games or slots (`slot` = target match + changeover). Session rates (Σg/Σp, Σplay/Σp, ΣW/Σp, mean games) are taken over all present players. Each waiting player gets P (§5.3), every term saturating with `sat(x, c) = c·tanh(x/c)`.
3. **Ready now.** Free courts are filled one at a time: courts holding a host lock first, then larger courts (doubles before singles), then the highest group value. Each court's group comes from `chooseGroup`: locked players take their seats, the rest start as the top scorers, then single swaps against the next 6 players on the short list are tried until none improves U(G) (at most 10 rounds; an upper bound skips swaps that can't win). The seed then picks among the equally fair groups (Shuffle). A cross-court pass swaps unlocked players between groups if it reduces repeats or imbalance.
4. **Up next.** Busy courts are ordered by expected free time (start + the session's average match length, or the target before any match completes; overdue courts free "now"). Each court is forecast on its own, at its own expected free time: its pool is the waiting players plus everyone expected off court no later than that court (including its own players). Everyone is projected to that time and rescored. Ready now players count towards the session rates (credited with their game when they come off) but are never reused in a forecast, and neither are players in earlier forecasts. Only Ready now groups are final.
5. **Reasons.** Locks and manual moves are named first, then the two strongest of: games vs fair share, waiting, rest / back-to-back; then "No repeat partners" / "Balanced teams" if true. At most three. Forecast figures are marked "~" ("Waiting ~14 min").

**Cost.** O(C·n) per call. Forecast pruning is exact: a waiting player's score can rise by at most Σ w·|Δargument| between now and a forecast time (each term is `w·sat(argument)` and `sat` changes by at most its argument's change). So a waiting player is only projected and rescored when that upper bound could reach the court's short list (`waitingPriorityUpperBound`, property-tested against exact rescoring). Players coming off court are always rescored. Callers that only act on Ready now groups can pass `includeUpNext: false` (the simulator does).

### Shuffle

- **Fair alternatives.** After the best group for a court is found, every single swap of an unlocked member with a short-list outsider that scores within 0.1 points of the best counts as an equally fair alternative. The seed picks one of the best group and its alternatives. `CourtSuggestion.otherFairGroupCount` says how many alternatives exist, so the UI can say "no other fair option" when it is 0. "Shuffle" records a new seed, so all hosts see the same new pick.
- **Rotating tie-breaks.** Each player's tie-break jitter (0-0.02 points) comes from `hash(seed, id)`. The seed is mixed with the completed-match count, so the tie order rotates as the session goes on instead of favouring the same players all evening.

## Default weights (calibrated)

Points per unit, caps in games or slots. The host's order multiplies each objective's weights (1st ×2.0, 2nd ×1.5, 3rd ×1.2, rest ×1.0). Rule toggles set terms to 0.

| Term                         | Weight           | Cap        | Scaled by objective | Toggle                    |
| ---------------------------- | ---------------- | ---------- | ------------------- | ------------------------- |
| Games vs fair share (m3)     | 1.0              | 1.5 games  | Equal games         | `fewerGamesFirst`         |
| Games vs mean (m1)           | 0.25             | 1.0 games  | Equal games         | `fewerGamesFirst`         |
| Playing time vs share (m4)   | 0.3              | 1.0 slot   | Playing time        | —                         |
| Current wait (m6), β = 1     | 0.8              | 2.0        | Shortest waits      | `longestWaitFirst`        |
| Accumulated wait (m5)        | 0.3              | 1.0 slot   | Shortest waits      | `longestWaitFirst`        |
| Rest (m7), capped at 2 slots | 0.25             | —          | No back-to-back     | —                         |
| Recent games (m8), −         | 0.4              | 1.5        | No back-to-back     | —                         |
| Just came off, −             | 0.6              | —          | No back-to-back     | `preventConsecutive`      |
| Repeat partner (per pair)    | 0.3              | 2 per pair | Mix partners        | `mixPartners`             |
| Repeat opponent (per pair)   | 0.1              | 2 per pair | Mix partners        | `minimiseRepeatOpponents` |
| Skill imbalance (per level)  | 0.1              | —          | —                   | —                         |
| Host manual order            | 100 per position | —          | —                   | —                         |
| Seeded tie-break jitter      | 0-0.02           | —          | —                   | —                         |

Other constants: recent-games half-life 2 slots; "just came off" = rested less than 0.5 slot; short list = k + 6; fair-alternative tolerance 0.1 points.

**"Playing time" duplicates "Shortest waits" today.** m4 (playing time vs share) and m5 (accumulated waiting beyond share) are mathematically identical here: time present = play + wait, so `playDeficit = waitExcess`. They are kept as two terms because the plan maps them to different objectives, so ranking "Playing time" first currently does what ranking the accumulated-wait half of "Shortest waits" does. To raise with Ryan.

### Calibration

Method: 12 steady-state configurations × 12 seeds and 4 churn configurations (25% late arrivals, 15% departures with 50% rejoin, ±35% match lengths) × 30 seeds. Each weight was swept up and down (×2 / ×0.5, and m4/m5 switched off), plus the back-to-back penalty at 0.6 / 1.2 / 1.8 / 2.4.

- Steady state is insensitive to every weight: 100% of runs had a spread ≤ 1, Jain ≈ 99.5, utilisation 100%.
- With churn the differences are small. Fair-share weight ×2 lowered the worst fair-share gap from 1.15 to 0.97 games. Partner weight ×2 lowered repeats from 3.5% to 2.2% (×0.5 raised them to 7.7%). Wait weight ×1.5 lowered the longest wait slightly.
- The back-to-back penalty barely changes back-to-back rates at any weight (11.5% → 11.1% from 0.6 to 2.4). Where back-to-back is avoidable (at least two players per seat) the defaults already avoid it entirely (0.0%). Where it is forced (players ≈ seats + 1, or two courts finishing within a minute) no weight can avoid it.
- No setting was better on every measure, so the defaults were kept.
- **The trade-off to raise with Ryan:** with the default order (Equal games first), a player who has just come off is picked again once they are about 0.3 games or more behind their fair share. Ranking No back-to-back above Equal games flips that: a just-off player 0.9 games behind then waits (tested).
- No single term decides a pick: across 646 churn decisions the most "decisive" term (games vs fair share) flipped 3.7% of picks on its own (test threshold 15%).

## Measured quality (§6 quality targets)

15-minute matches, 2-minute changeover and 120-minute sessions unless noted. Utilisation is measured up to the planned end (the final overrunning matches are not counted). Every row is a one-off measurement. The tested subsets and thresholds are in `report/simulations.test.ts`: steady state (all four targets), big clubs (one seed each of 120/12 and 500/50), churn, growth, late arrivals, random baseline and avoidable back-to-back.

| Scenario                                                         | Runs | Spread ≤ 1 | Jain (mean / min) | Utilisation | Longest wait (mean / max, slots) | Worst fair-share gap (mean / max, games) | Repeat partners | Back-to-back |
| ---------------------------------------------------------------- | ---- | ---------- | ----------------- | ----------- | -------------------------------- | ---------------------------------------- | --------------- | ------------ |
| Steady state (12 configs, 7-60 players)                          | 120  | 100%       | 99.6 / 99.2       | 100%        | 0.89 / 1.33                      | 0.62 / 0.92                              | 9.0%            | 25.5%        |
| Steady 120/12 and 500/50 (one seed each)                         | 2    | 100%       | 98.8 / 98.8       | 100%        | 1.75 / 1.78                      | 0.57 / 0.64                              | 0.0%            | 0.0%         |
| Churn (late arrivals, departures, ±35% lengths)                  | 120  | n/a        | 99.4 / 98.4       | 100%        | 1.36 / 2.36                      | 0.67 / 1.11                              | 4.4%            | 8.3%         |
| Churn, random grouping baseline                                  | 120  | n/a        | 94.6 / 81.4       | 100%        | 3.61 / 6.68                      | 2.42 / 4.55                              | 15.9%           | 39.1%        |
| Random host actions (locks, skips, reorders, closures, shuffles) | 60   | 55.0%      | 99.4 / 97.6       | 100%        | 1.67 / 5.48                      | 0.64 / 1.19                              | 4.2%            | 18.6%        |
| Very uneven matches (±50%)                                       | 60   | 100%       | 99.6 / 99.2       | 100%        | 1.12 / 1.48                      | 0.73 / 0.93                              | 3.6%            | 22.1%        |
| Two pauses per session                                           | 60   | 100%       | 99.6 / 99.2       | 100%        | 0.96 / 1.12                      | 0.56 / 0.94                              | 2.8%            | 21.0%        |
| 30-minute session                                                | 40   | 97.5%      | 98.6 / 96.0       | 100%        | 0.86 / 1.05                      | 0.51 / 1.12                              | 0.8%            | 23.1%        |
| 240 minutes, 25-minute matches                                   | 40   | 100%       | 99.9 / 99.7       | 100%        | 0.96 / 1.10                      | 0.50 / 0.94                              | 7.0%            | 29.7%        |
| Grows from 3 to 40 players (4 courts)                            | 20   | n/a        | 99.5 / 99.2       | 87.8%       | 2.25 / 2.60                      | 0.61 / 0.90                              | 0.3%            | 9.5%         |
| At least two players per seat (8/1, 16/2)                        | 60   | 100%       | 99.5 / 98.8       | 100%        | 1.20 / 1.59                      | 0.37 / 0.75                              | 21.1%           | 0.0%         |

"Back-to-back" = a match start by a player who came off court less than a minute earlier. Most of it is forced (players ≈ seats + 1); see Calibration.

Against the plan's targets:

- **Spread ≤ 1 in steady state in ≥ 95% of runs:** met (100%).
- **Jain ≥ 95:** met in every engine scenario (minimum 96.0, a 30-minute session); the random baseline drops to 81.4.
- **Utilisation ≈ 100% whenever players ≥ seats:** met (100%). It can't fail in these steady-state simulations: a free court is always filled when at least k players are eligible, and the simulator starts the next match the moment a court frees. So the test is a regression guard, not evidence of a trade-off. It would only drop with host actions that idle courts, or with real host delays. The growth scenario is below 100% only because it starts with fewer players than seats.
- **Bounded max wait:** at most 2.4 slots in any engine run without host actions. In steady state it is at most 1.33 slots, except big clubs, where the attendance/seat ratio forces longer sit-outs (500 players on 200 seats: 1.78 slots). Host actions (skips, closures, locks, manual order) push individual waits up to 5.5 slots; that is the host's override, not the score.

"Spread" is not meaningful with churn: a player who arrives an hour late should have fewer games. The fair-share gap (`e_i − g_i`) is the right measure there.

### When equal participation is impossible (§5.9)

- **Small pool vs the back-to-back preference:** 5 players / 1 court still gets spread ≤ 1 in all 30 runs. Back-to-back games are unavoidable (each round at least 3 of the 4 players also played the round before), and 41% of partner pairs repeat (only 10 pairs exist). 6 players / 1 court: 13%.
- **Short sessions:** with only one or two rounds, the last partial round leaves a spread of 2 in 2.5% of 30-minute runs.
- **Late arrivals and departures:** game counts differ by design. Every late arrival ended within 1.25 games of their fair share (test), and the worst gap in any churn run was 1.11 games.
- **Host actions:** skips, closures and the host's manual order take precedence over the score, so spread ≤ 1 held in only 55% of runs with frequent random host actions, though Jain stayed ≥ 97.6.

### Holding a court for fairer players (deferred in §5.5)

Not built. With courts always filled, steady-state spread is ≤ 1 in every run and churn runs stay within about one game of fair share, so holding a court could only trade utilisation for gains that are already near the ceiling. Not proposed for now; revisit if real sessions show otherwise.

## Behaviour tests (§6)

All pass (`schedule/recommend.test.ts`, `report/simulations.test.ts`):

- **Waits vs games (conflict).** A player waiting 1.6 slots (deep in the urgency zone) but one game ahead of fair share is not picked; the same wait without the lead is (control). With Shortest waits ranked above Equal games, the same player is picked.
- **Back-to-back vs games (conflict).** The fewest-games player (1 game vs 2, near fair share because they arrived later) is not picked straight after coming off; the same player rested is (control). A just-off player 0.9 games behind is picked by default but not with No back-to-back ranked above Equal games. A just-off player 1.8 games behind is picked (weighed, not blocked).
- **Priority order in simulation** (first vs last, churn runs, 30 seeds per configuration):
  - Mix partners first cuts repeat partners by at least 30% (measured 2.1% → 0.8%).
  - Shortest waits first lowers the longest wait by at least 1% (measured 1.538 → 1.502 slots). The effect is small because waits are bounded by courts and players, not by the score.
  - Equal games first: 0.738 → 0.718 games worst gap, not asserted (too small to be robust).
  - No back-to-back first: 7.7% → 7.5%, not asserted (forced back-to-back can't change).
  - The ranking effects for waits, games and back-to-back are proven by the deterministic conflict tests above.
- Back-to-back is avoided whenever enough rested players exist (≤ 1% with at least two players per seat; measured 0.0%).
- Late arrivals end within about one game of fair share (max 1.25, mean < 0.5).
- Repeat-partner rate is well below random grouping (4.4% vs 15.9%; test requires < half).
- No single term decides more than 15% of picks (measured max 3.7%).
- With all players equal, each of 12 players is picked 58-75% of the time across 600 seeds (expected 67%); listing players in a different order gives the same groups.

### Simulation invariants (fast-check)

40 random sessions of 0-60 players on 1-8 courts, plus 4 of 150-500 players on 15-50 courts. They have random formats, match lengths (8-25 min), durations (30-240 min), arrivals, departures, rejoins and pauses. A random host action (lock, skip/un-skip, reorder, close/reopen, shuffle) is taken before 30% of recommendations, and match starts and completions are undone and redone at random. Checked on every recommendation and at the end:

- Every suggested match is accepted by `applyEvent`, and no player's play overlaps (nobody on two courts).
- Every free court is in Ready now or reported unfilled (only with too few eligible players).
- A player locked to a court is seated whenever that court is filled.
- Up next never repeats a player, never reuses a Ready now player, and only uses players who are waiting or on a court expected to free no later than that suggestion's ETA.
- Report game counts reconcile with the match records.
- Undo restores the exact player stats and recommendation.
- Replaying the log reproduces the final state.

## Benchmarks (`pnpm bench`, Apple Silicon, Node 24)

| Benchmark                                           | Mean     | p99      | Target     | Status                 |
| --------------------------------------------------- | -------- | -------- | ---------- | ---------------------- |
| `recommend()` 8 players / 2 courts                  | 0.009 ms | 0.020 ms | —          |                        |
| `recommend()` 30 / 4                                | 0.063 ms | 0.097 ms | —          |                        |
| `recommend()` 120 / 12                              | 0.37 ms  | 0.47 ms  | —          |                        |
| `recommend()` 500 / 50 (with Up next)               | 3.69 ms  | 4.02 ms  | p95 < 5 ms | Met (about 20% margin) |
| Full simulated 2-hour session, 500 / 50             | 398 ms   | 410 ms   | < 1 s      | Met                    |
| Same session, also computing every Up next forecast | 1,750 ms | 1,792 ms | —          | Not a target           |
| Full simulated 2-hour session, 30 / 4 with churn    | 5.0 ms   | 5.6 ms   | —          |                        |
| Replay a 1,000-action log                           | 1.77 ms  | 2.15 ms  | < 5 ms     | Met                    |

`recommend()` inputs are every input the engine saw during a simulated session, so they cover start-up (all courts free) and mid-session (mostly forecasts). Exact per-court forecasting is most of the cost at 50 courts: roughly 45 forecasts, each scoring its pool at its own time, plus a group search and fair-alternatives pass per court. The simulator never reads Up next, so the full-session benchmark skips it (`includeUpNext: false`); the variant with forecasts is reported for transparency. Membership size does not enter the engine at all: only the session's participants are in the snapshot, so a 5,000-member directory costs nothing here.

## Interpretations

Choices made where the plan was open; change them if they're wrong.

1. **"Just came off"** (consecutive penalty) means rested for less than half a slot.
2. **Host manual order** is a score term of 100 points per position: larger than the spread of all other terms combined (tested), so the host's order is followed among ranked players, and ranked players come before unranked ones until they next play.
3. **`allowManualAssignments`**: when the session's config snapshot has it off, `applyEvent` rejects `PlayerLocked` and new `QueueReordered` actions (`MANUAL_ASSIGNMENTS_OFF`). Undoing an earlier reorder is still allowed. The scheduler honours whatever locks and order exist.
4. **Locks:**
   - A lock to a court seats the player on that court's next match (Ready now or its forecast) and keeps them off other courts.
   - A lock to any court seats them in the first group built.
   - Courts holding locks are filled first, so a lock is never left unseated because players ran out.
   - `applyEvent` caps locks to one court at that court's seats (`COURT_FULL`); any-court locks are not capped.
   - A lock to a closed court waits for that court.
5. **"Full courts"** scales nothing in the MVP, because a free court is always filled when it can be (§5.5). When players are short, larger courts are filled first to seat the most players.
6. **Ties and Shuffle:** seeded jitter up to 0.02 points per player, plus a seeded pick among groups within 0.1 points of the best (see Shuffle). The seed rotates with the completed-match count.
7. **Forecast pool includes the forecast court's own players** (as just-came-off), not only those "expected off earlier courts" as §5.5 words it. Without them, a 5-player single-court session could never show an Up next group. Suggest updating the plan wording to "no later than this court".
8. **Forecast timing:** each busy court is forecast at its own expected free time. Ready now players come back credited with their game after one expected match length (for the session rates), but are never reused in a forecast.
9. **Skipped players** count in the session rates (their frozen numbers), but never accrue presence and are never eligible.
10. **Team skill points:** beginner 1, intermediate 2, advanced 3; unknown counts as intermediate. Only the difference between the two teams is scored.
11. **Repeat counts** saturate per pair (cap 2), so even a tiny pool never lets mixing outweigh fairness.
12. **Report population** is everyone who joined the session, including players who left (their numbers are frozen when they leave). Jain's index is "—" before any completed game or with fewer than 2 players. Play-time Jain uses slots for the +1.
13. **Utilisation in simulations** is measured up to the planned end; the live report measures all open court time.
14. **Simulated match flow:** the next match starts the moment a court frees (the host taps Done, then Accept), so the changeover is inside the next match's time. Matches are not started after the planned end, and the session ends when the last one finishes.
15. **Reasons:** the §5.6 cross-court comparison ("Court 1 finishers picked over Court 3: fewer recent games") is not implemented. It would need a per-court comparison of the runner-up pool; deferred until the live screen shows whether hosts want it.
