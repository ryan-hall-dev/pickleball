# 0005 — A phone-first social workflow

Status: accepted product direction (Ryan, 2026-11-14); implementation authorised 2026-11-15. Build progress is recorded in `docs/plans/simple-social-mvp.md`.

## Why

The original plan exposed scheduling controls before proving they helped a host run real games. The first trial instead focuses on session check-in, visible waiting times and preparing the next four on the host's phone. No membership or player identity carries between sessions (ADR 0004).

## Decisions

- One session-only player form: first name, last name, playing level and male/female. Levels are Beginner, Intermediate and Advanced; they inform the host, not a separate automatic skill-balancing objective.
- Doubles only for new sessions. Valid groups are four men, four women or two of each; each mixed team has one of each. Host changes enforce the same rule.
- Longest eligible waiting players come first. Avoiding a third consecutive mixed/same-sex game is a preference, never a reason to leave a court empty. The first-trial allowance is at most two extra minutes of waiting for variety; a two-minute difference in current waits alone cannot guarantee that, so use a conservative policy when the bound cannot be established.
- Rest lasts ten real minutes. Keep earned waiting, stop accumulating it during the rest and resume automatically at its deadline; allow early return.
- The host supplies a court count. Generated court labels identify games and set no priority. No finish-time forecasting.
- Calling a group fixes it for co-hosts; explicit replacement is allowed. Calling does not end waiting; actual game start does. A player cannot be called or playing on two courts.
- After game start that court needs no input until Game finished. Completion returns the four players to waiting with new waits. Normal turnover is Finish, then Start these four.
- Rare playing-player replacement and safe Undo for accidental starts/finishes remain available. Do not expose broad action-log controls.
- If no valid replacement is available for a player who cannot continue, **End as interrupted** returns all four to waiting with fresh clocks and records no completed game. Rest is a separate host action (Ryan approved 2026-11-15).
- No Pause. At the chosen end time stop new suggestions and starts, let active games finish, then confirm End session.
- Keep ended-session records for operator evaluation and improving the app. Do not add host-facing history, reports, operator dashboards or new personal-data collection. New sessions start fresh.

## Consequences

Remove new-session Rotation settings, saved-setup/reuse controls, Shuffle, capacity graphics, rounds/game-count forecasts and the large confirm/dashboard/report screens from the active workflow. Retain historical records and handlers necessary to replay old events, including old pause and singles events. The approved phone mockup is `docs/designs/simple-social/phone-review.html`; application screens use the existing DESIGN.md tokens.

Existing server-only writes, social isolation, idempotency, sequence conflicts, timeouts and backup/rehearsal safeguards remain required. Do not reuse the old weighted scheduler unchanged behind the simpler screen: its priorities differ from this product.

Implementation must be verified in small commits. A phone mockup and passing tests do not prove the app is faster than the host's existing process; that requires a real social trial.
