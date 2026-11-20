# Simple social pilot

Status: **prepared; not run**. Ryan must choose the social, host, date and approved environment before a field trial. No deployment or hosted change is authorised by this document.

## Purpose

Observe whether one host can run a real social from a phone with less guessing and no extra operating burden. Passing automated checks does not answer this question.

Existing implementation and decisions: [Simple social MVP](simple-social-mvp.md), ADR0004/0005 and DESIGN.md.

## Before inviting real players

- Choose one social and a primary host. Record court count, expected attendance, session duration and whether a co-host will help.
- Choose and approve a pilot environment separately. Keep development, test and production separate; never point local tests at a hosted database. A real phone needs a reachable app/check-in address: localhost on the Mac is not a usable player-phone address.
- Any hosted deployment, migration, credentials change or main-data restore needs Ryan's explicit approval and its own release/backup/rollback verification. None has been done for this pilot.
- Confirm the latest local quality/browser checks, including two-host isolation, unknown-write retry, rest expiry, fixed-call vacancy, recovery and time-up behavior. Use fake players for rehearsal.
- Agree the success measures below before the trial. Explain the check-in/host-approval flow and privacy message; collect no extra player contact information or permanent player identity.
- Charge the host phone and keep the host's usual manual rotation method available as fallback. Show the host where Retry last action, Court options, Undo, Rest and Ready now are before play starts.

## Observe the real workflow

1. **Arrivals:** scan QR/NFC, enter session-only details, approve/reject and confirm the waiting list. Observe one late arrival and co-host visibility if a co-host is participating.
2. **Prepare ahead:** call a valid group while another game is playing. Check that the called group stays fixed and its waiting time continues until actual start. Avoid changing the group merely for demonstration during real play.
3. **Turnover:** time Game finished, the physical changeover and Start these four separately. Completion must return the current four to waiting; it must not start the next game automatically.
4. **Ordinary exceptions:** observe a real rest/return and any actual departure or called vacancy. Rest should retain earned waiting and return after ten actual minutes even if the host leaves the page. Correct a real mistaken action with safe Undo when permitted; do not deliberately disrupt live players to manufacture a mistake.
5. **Recovery if needed:** replacement keeps the team/seat valid; the outgoing player returns to waiting, with rest separate. Interrupted games return the current four with fresh waits and no completed-game credit. Do not create a short-handed game.
6. **Finish:** no new game starts after time-up. Let active games finish, then confirm End session. The next session must start with a fresh player list.

Use automated/local rehearsal for uncommon failures that do not occur naturally. Do not intentionally disconnect a live host or change real session data merely to test recovery.

## Measures to agree with Ryan

- Ordinary finish/start turnover needs two main action taps, with no mandatory repeated confirmation. Preparation/calling is measured separately from court changeover.
- Record the time spent preparing/calling a group and handling the phone, compared with the host's usual method at similar attendance/court count. Do not claim improvement without a baseline.
- Note forgotten players, unexplained long waits, invalid suggested groups, changed called groups, wrong-court assignments, duplicate writes and occasions when the host abandons the app for the manual method.
- The host should be able to explain what happens next and recover from a refused action without technical help. Ask whether the app saved effort and which action was confusing.
- A first trial is successful only if it is no slower than the agreed baseline, does not double-book players or silently change called groups, and gives understandable recovery when an action cannot proceed. Any baseline/threshold adjustment must be recorded, not silently redefined after the trial.

## Minimal observation record

Use anonymous observation numbers or short action labels; do not copy player names, email addresses or request contents into the pilot notes.

| Observation        | Expected behavior                      | Elapsed / taps | What actually happened | Follow-up |
| ------------------ | -------------------------------------- | -------------- | ---------------------- | --------- |
| Prepare/call group | Valid, fixed group                     |                |                        |           |
| Finish then start  | Separate actions; fresh waits          |                |                        |           |
| Rest/return        | Earned wait preserved; actual deadline |                |                        |           |
| Exception/recovery | No duplicate or unsafe action          |                |                        |           |
| Time-up/End        | Finish active games; no new starts     |                |                        |           |

## Stop and follow up

Stop relying on the app and use the host's manual method if it double-books a player, confirms an action that was not saved, changes a called group without a host action, exposes another social's data, or leaves the host unable to recover safely. Preserve the session log and note the time/action without copying secrets or unnecessary personal data. Do not reset or delete the session to hide a problem.

Afterward, write a brief dated result: environment, anonymous attendance/court counts, agreed baseline, observations, host feedback and pass/fail against the measures. Register specific fixes in the roadmap before adding new features. Retain ended-session data under the existing operator-evaluation decision; no automatic deletion or cross-session scheduling is authorised.
