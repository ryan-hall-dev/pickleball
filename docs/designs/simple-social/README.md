# Simple Social · Phone review

Open [phone-review.html](./phone-review.html) directly in a browser. A self-contained design preview with one phone frame and eight main navigable scenes plus a called-group replacement detail: setup, courts, turnover, waiting/rest, host check-ins, player check-in, replacement and time up. No dependencies, external assets, network calls or storage. Outfit is used if installed; otherwise system UI. The layout adapts to a 390px viewport and desktop.

## Proposed presentation

- Short setup: court count (4 in the example) and duration; automatic Court 1–4 labels. Doubles only. No court priority, predictions, preferences, saved setups or format switch.
- Courts: quiet playing cards, separate blue Up next group, Call these four to fix the group across hosts. Calling does not stop waiting. Finish → Start these four is the normal two-action turnover, without a normal-game confirmation. The turnover scene assumes the next group was already called.
- Waiting: oldest first, name, level, male/female and earned wait. Rest is separate and not selectable: “Wait earned 12:00” frozen, “Ready in 06:42”, Ready now early, 10 actual minutes total.
- Check-ins: blank first name, last name, level and male/female fields each session, no lookup or membership; host approval. The player form demonstrates a request and pending state without sending anything.
- Replacement: rare per-court overflow action, with a valid mixed-team playing replacement; a separate Change a player detail illustrates replacing someone in the called group. Safe Undo for accidental start/finish is illustrated; recovery is not implemented.
- Time up: no suggestions or starts, including called groups. Existing games finish; End session then asks for confirmation. No Pause. No host History/reports or admin controls on play; history is retained for operator evaluation.

## Example consistency

Courts scene: Court 1 Alex/Mia vs Ben/Zoe (one male and one female per team); Court 2 Jack/Noah vs Finn/Sam (four men); Court 3 Ada/Liv vs May/Joy (four women); Court 4 available. Up next: Omar/Eva vs Leo/Nia, all Intermediate and waiting. None is also playing. Hugo (Male, Advanced) can illustrate replacing Omar without invalidating the mixed group. Theo is resting and excluded. Ruby and Max are pending, not eligible. Levels use Beginner, Intermediate and Advanced only.

Scenes are independent snapshots, not a working session or scheduler. Actions update limited illustrative copy only; timers do not tick. Reload resets the preview. Rest and demographic validation are explanatory, not coded.

## Review notes / unresolved proposals

- Grouping, multi-court allocation and ties remain to agree. The “Prepare next example group” action gives an explicit unresolved-allocation placeholder, never a court-number priority.
- Variety softly avoids a third same-type game; the approved first-trial limit is at most 2 additional minutes of waiting for variety and never leaving a court empty for variety. A queue-age gap does **not** guarantee an actual next-game wait bound. Enforcement needs worked examples before coding; this mockup implements no scheduling.
- Safe Undo boundaries, concurrent host actions, interrupted starts/finishes and in-game replacement recovery need final interaction decisions.

## Review checks completed

- Browser rendering checked at 320 px, 390 px and 1440 px: all eight main scenes fit without horizontal page overflow; visible phone controls meet the 44 px minimum.
- Illustrative interactions checked: Call these four, called-group replacement, the court's in-game replacement menu, a fresh empty player form leading to pending approval, and finish/end/cancel.
- No browser script errors. Formatting passes. The plan and mockup received a read-only review; its replacement-flow and variety-wording findings were addressed.
- Screenshots are in `screens/`: `desktop-review.png`, `courts-390.png`, `waiting-390.png`, `setup-390.png` and `player-390.png`.
- This is a static preview, not application validation: no scheduler, live timers, data persistence, auth or backend was tested here. Existing uncommitted app changes were preserved.
- Local review: <http://127.0.0.1:4188/simple-social/phone-review.html> while the documentation preview server is running. The HTML also opens directly from disk.

Implementation and final screen approval remain pending Ryan's review. Nothing published or pushed; no database or application changes made for this design task.
