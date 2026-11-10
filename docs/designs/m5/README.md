# M5 design drafts: player check-in, host tray, sticker and QR

Draft screens for the M5 screens that have no design yet (`docs/plans/m5-player-checkin.md`). Built from `DESIGN.md` tokens and components and the `Reference Designs/` exports. Ryan approves the screenshots before M5 is accepted. Not app code: static HTML for review.

## Files

| File                  | What                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `player-checkin.html` | Public `/t/<tag>` page, 390 px phone frames P1-P13                                              |
| `host-tray.html`      | Pending check-in tray on Setup: page placement, close-ups, row states, tablet and phone (H0-H4) |
| `sticker-qr.html`     | Sticker and QR page, full-screen QR, A4 print layout, manager "Issue new link" on Hosts (S1-S4) |
| `render.mjs`          | Renders every `[data-shot]` frame to `screens/*.png` at 2x and fails on horizontal overflow     |
| `screens/`            | The PNGs                                                                                        |

Render (from the repo root): `export PATH="/opt/homebrew/opt/node@24/bin:$PATH" && node docs/designs/m5/render.mjs` (optionally pass file names). It uses the `@playwright/test` devDependency's Chromium. Outfit loads from Google Fonts, falling back to `system-ui` offline. The QR codes are a drawn placeholder pattern, not scannable.

## Screens

**Player (390 px)**

| PNG                                          | Screen                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `P01-welcome-recognised.png`                 | Welcome, recognised phone (PNG layout; "This phone was used by" card, pinned CTA)               |
| `P02-welcome-new-phone.png`                  | Welcome, new phone (search + guest link, no CTA)                                                |
| `P03a-search-results.png`                    | Search with 2+ letters: 5 names, initials + name only                                           |
| `P03b-search-no-match.png`                   | Search, no match                                                                                |
| `P04a-confirm-recognised.png`                | Confirm bottom sheet, recognised phone (name + saved level)                                     |
| `P04b-confirm-picked-from-search.png`        | Confirm bottom sheet, picked from search (name only, "Update your level" collapsed)             |
| `P04c-confirm-update-level-open.png`         | Same, "Update your level" opened                                                                |
| `P05a-guest-form.png`                        | First-time guest form                                                                           |
| `P05b-guest-form-errors.png`                 | Guest form with inline orange errors                                                            |
| `P06-waiting-for-approval.png`               | Waiting for the host to approve                                                                 |
| `P07-approved.png`                           | Approved, "You're in"                                                                           |
| `P08-rejected.png`                           | Rejected (neutral) with Try again                                                               |
| `P09-already-checked-in.png`                 | Already checked in (own linked phone only, straight away)                                       |
| `P09b-already-checked-in-host-confirmed.png` | Already checked in, confirmed by a host (a non-linked phone, after "Close: already checked in") |
| `P10-too-many-attempts.png`                  | Rate limited                                                                                    |
| `P11-link-not-active.png`                    | Unknown or reissued tag                                                                         |
| `P12-no-social-open.png`                     | No social open right now                                                                        |
| `P13-something-went-wrong.png`               | Something went wrong / offline                                                                  |

**Host tray**

| PNG                          | Screen                                                                                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `H00-setup-with-tray.png`    | Setup page (1280 px, other sections abbreviated) with the tray placed                                                                                                               |
| `H01-tray-three-pending.png` | Tray with 3 requests: member already checked in (no Approve; "Close: already checked in" or Reject), member with a level change, new player                                         |
| `H02-tray-empty.png`         | Empty state                                                                                                                                                                         |
| `H03-row-states.png`         | Approving, failed + Retry, approve stopped (already checked in), closed as already checked in, possible duplicate (new player), already decided by another host, approved, rejected |
| `H04a-tablet-820.png`        | Tablet wrapping                                                                                                                                                                     |
| `H04b-phone-390.png`         | Phone wrapping                                                                                                                                                                      |

**Sticker and QR**

| PNG                               | Screen                                              |
| --------------------------------- | --------------------------------------------------- |
| `S01-sticker-and-qr-page.png`     | Host Sticker and QR page                            |
| `S02-qr-full-screen.png`          | Full-screen QR for a player to scan (820 px tablet) |
| `S03-print-layout.png`            | A4 print preview, 12 stickers                       |
| `S04a-hosts-issue-new-link.png`   | Hosts page, manager view, Check-in link card        |
| `S04b-issue-new-link-confirm.png` | Issue new link confirmation dialog                  |

## Decisions

Proposals not covered by `DESIGN.md` or the M5 plan, with their status. **APPROVED (Ryan, 2026-11-10)** items are agreed behaviour. The wording and layout items were approved as drawn on the same day. If implementation reveals a genuine usability issue, flag it for review rather than changing the design silently.

**Host tray**

1. **APPROVED (Ryan, 2026-11-10).** **Tray placement:** a full-width card directly under the setup stepper, above both columns. Reason: it's the first thing a host sees, and it stays near the top on tablet and phone (the summary aside drops below the main column there, so a tray at the top of the aside would end up near the bottom of the page). Alternative: top of the summary aside (desktop only looks better).
2. **APPROVED as drawn (Ryan, 2026-11-10).** Tray header: a 32 px count badge (blue when requests are waiting, grey at 0) in place of a numbered section badge; the tray border is blue while requests wait and neutral when empty. Subtitle "Approve to add them to Who's playing. Oldest first."
3. **APPROVED as drawn (Ryan, 2026-11-10).** Rows are ordered oldest first.
4. **APPROVED (Ryan, 2026-11-10).** A member who chose "Update your level" shows the new level plus "level changed from <old>". The request needs to carry the chosen level for this.
5. **APPROVED (Ryan, 2026-11-10).** **Already checked in: a player already attending is never approved into the same session again.** Server rule: `session_participants` is unique on `(session_id, member_id)`, so duplicate attendance is already impossible in the database, but today `approve_checkin` for an attending member either errors (`PARTICIPANT_ID_MISMATCH`) or re-links the device. In M5, `approve_checkin` refuses with `ALREADY_IN_SESSION`: no participant row, no device link. Design: a request for a member who is already attending gets an orange-edged row with `!` and "Already checked in to this session. They can't be added twice." and **no Approve button**. Its actions are blue "Close: already checked in" (resolves the request; the requesting phone then shows P9b) and outline "Reject" (for when it isn't them). Pending rows switch to this row by themselves within one 5 s poll when the member becomes attending. If the member is added after the row was shown (another host approved a request from a different phone, or a host added them in Who's playing), pressing Approve is refused and the row switches to the same already-checked-in row with "Added by another host a moment ago." (H3). Before a host decides, a non-linked phone still sees P6 Waiting, so a phone never learns anyone's status from a submit. Approved details:
   - **(a)** "Close: already checked in" is its own request outcome: a new `checkin_request_status` value, `already_checked_in`, separate from `rejected`.
   - **(b)** After the host closes it, the requesting phone shows P9b ("You're already checked in").
   - **(c)** The requesting phone is never linked to the member in this case.
6. **APPROVED (Ryan, 2026-11-10).** Decided rows (approved, rejected, closed as already checked in, decided by another host) show a one-line message for about 4 s, then leave the list. A "Check-in rejected" confirmation is added alongside the plan's approved one.
7. **APPROVED as drawn (Ryan, 2026-11-10).** Failed approve/reject: orange row message "Couldn't approve. Check your connection and retry." with a blue Retry; Reject stays available.
8. **APPROVED as drawn (Ryan, 2026-11-10).** "Show QR code" (outline, 44 px) is always in the tray header, not only in the empty state.

**Player page**

9. **APPROVED (Ryan, 2026-11-10).** Confirm pop-up is a bottom sheet (thumb reach on phones), with modal styling (28 px top radius, modal shadow, dimmed page behind).
10. **APPROVED (Ryan, 2026-11-10).** "Update your level": an outline disclosure button, collapsed by default; when opened, the three level buttons with nothing preselected (the saved level stays private). Tapping the selected level again clears it; leaving none selected keeps the saved level.
11. **APPROVED as drawn (Ryan, 2026-11-10).** Primary CTAs are uppercase, per DESIGN.md ("CHECK IN AS GRACE"); the PNG uses sentence case.
12. **APPROVED as drawn (Ryan, 2026-11-10).** Search placeholder "Type your name" (the PNG says "Type your first name"), since `search_name` covers the full name. The hint below reads "Type at least 2 letters of your name".
13. **APPROVED (Ryan, 2026-11-10).** When exactly 5 names come back, a status line reads "5 names shown. Not listed? Type more of your name." This only reveals that at least 5 match. Alternative: no line.
14. **APPROVED as drawn (Ryan, 2026-11-10).** Search rows show a chevron and open the confirm sheet directly. There is no selected-row state on the page.
15. **APPROVED as drawn (Ryan, 2026-11-10).** P1 recognised card and P2 search sit under "Who's checking in?". P2 labels the search with a "Find your name" line in place of "Not you? Find your name".
16. **APPROVED as drawn (Ryan, 2026-11-10).** The confirm sheet and guest form include the note "A host approves each check-in before you're added to today's players."
17. **APPROVED as drawn (Ryan, 2026-11-10).** Guest form: titled "Check in as a guest" with the session line beneath; the level field is labelled "Your level"; errors appear after pressing Check in ("Enter your first name", "Enter your last name", "Choose your level"). The level group gets a 2 px orange outline when invalid. The back link reads "Back to find your name".
18. **APPROVED as drawn (Ryan, 2026-11-10).** State screens (P6-P13) show only the brand line (logo + social name), not the LIVE NOW card.
19. **APPROVED (Ryan, 2026-11-10).** P6 has no cancel button (none in the plan). It shows the player's own "Waiting" pill, a polite live line "This page updates by itself every few seconds." and a "While you wait" box.
20. **APPROVED as drawn (Ryan, 2026-11-10).** P7 and P9 "what happens next" copy is generic: "The hosts put you on a court when it's your turn. Stay near the courts and listen for your name."
21. **APPROVED as drawn (Ryan, 2026-11-10).** P8 rejected uses a neutral grey person icon and an outline "Try again" (calm, not a call to action). Try again goes back to the welcome screen.
22. **APPROVED as drawn (Ryan, 2026-11-10).** P10 has an outline "Try again"; P12 has an outline "Check again" (both just reload). Alternative: no button.
23. **APPROVED as drawn (Ryan, 2026-11-10).** P11 shows the app name "Pickleball Social Manager" (not the social's) and "Ask a host at the courts for the current QR code."
24. **APPROVED as drawn (Ryan, 2026-11-10).** P13 is one screen for offline and server errors, with lime "Try again". The line "If you'd already pressed Check in, trying again won't send a second request." relies on acceptance criterion 8 (same phone, same session returns the existing request).

**Sticker and QR, issue new link**

25. **APPROVED (Ryan, 2026-11-10).** The Sticker and QR page has no nav item. It opens from the tray's "Show QR code" and from the Hosts page ("Open Sticker and QR"), and has a "Back to session setup" link. It is open to every host of the social.
26. **APPROVED as drawn (Ryan, 2026-11-10).** S1 shows the full link with "Copy link" (outline) and a short "Copied" confirmation, an NFC note ("write this same link to the sticker"), blue "Show full screen" and outline "Print stickers".
27. **APPROVED as drawn (Ryan, 2026-11-10).** Full-screen QR: social name, "Scan to check in", QR on a white panel (quiet zone for scanning), short URL, 44 px close button (Esc too).
28. **APPROVED (Ryan, 2026-11-10).** Print: A4 only, 12 stickers per page (3 x 4, about 63 x 67 mm), black on white with dashed cut lines; each sticker has the QR, social name, "Scan to check in" and the short URL. A screen-only toolbar with Back and Print. US Letter is not covered.
29. **APPROVED (Ryan, 2026-11-10).** The Hosts page gets a "Check-in link" card (every host sees the link; only managers see "Issue new link"). The plan says "Issue new tag"; the UI says "link" because hosts know the link and QR, not the tag.
30. **APPROVED as drawn (Ryan, 2026-11-10).** "Issue new link" uses the existing orange-outline attention button; the dialog's confirm is **solid orange** with `#2A1606` text (DESIGN.md has no destructive button style). Focus starts on Cancel.
31. **APPROVED (Ryan, 2026-11-10).** The dialog says "Check-ins already sent are not affected." Verified: requests belong to the session, not the tag.
32. **APPROVED as drawn (Ryan, 2026-11-10).** Placeholder domain `pickleball.example` and tag `k7Qm2xPa` stand in for the real host and tag format.
33. **APPROVED (Ryan, 2026-11-10).** **Possible duplicate warning (D-D).** When a new-player request has the same normalised full name (first + last; case-, accent- and whitespace-insensitive) as anyone already attending the session (a member, or a guest a host added directly through Who's playing, compared by their name in this session; no member record is created for the comparison), the tray row is orange-edged with `!` and "Possible duplicate: same name as someone already checked in." plus "A matching name doesn't mean it's the same person. Check with them before approving." (H3). Rules: compares names only; nothing is identified, merged or rejected automatically; the host decides, and the blue Approve and outline Reject both stay; nothing is shown to the player.

## Copy deck

**Header (P1-P5)**: `<social name>` · `LIVE NOW` · `<session name>` · `Sat 7 Nov · 18:00 – 20:00 · 80 min left` · `4` `courts` · `26` `checked in` · `~6m` `to first game`

**Welcome and search**

- `Who's checking in?`
- `This phone was used by` / `Grace Kim`
- `Not you? Find your name` (P1) · `Find your name` (P2, also the search label)
- Placeholder `Type your name` · hint `Type at least 2 letters of your name`
- `5 names shown. Not listed? Type more of your name.`
- `No one matches “Xy”. Check the spelling, or check in as a guest.`
- `Not a member? Check in as a guest`
- CTA `Check in as Grace`

**Confirm sheet**

- `Check in as Grace Kim?` · `<session name> · Sat 7 Nov · 18:00 – 20:00`
- `Your saved level` (recognised only, next to the level chip)
- `Update your level (optional)` · `Beginner` `Intermediate` `Advanced` · `Skip this to keep your saved level. Tap a selected level again to clear it.`
- `A host approves each check-in before you're added to today's players.`
- `Check in` · `Back`

**Guest form**

- `Back to find your name` · `Check in as a guest`
- `First name` · `Last name` · `Your level` · `Beginner` `Intermediate` `Advanced`
- Errors: `Enter your first name` · `Enter your last name` · `Choose your level`
- `Check in`

**States**

- P6: `Waiting for the host to approve` · `Your check-in for <session> has been sent.` · pill `Waiting` · `This page updates by itself every few seconds.` · `While you wait` · `Keep this page open, or come back to the same link later. Your request stays here.` · `Taking a while? Let a host know you've arrived.`
- P7: `You're in, Grace` · `You're checked in to <session>.` · pill `Checked in` · `What happens next` · `The hosts put you on a court when it's your turn.` · `Stay near the courts and listen for your name.` · `You can close this page.`
- P8: `Check-in not approved` · `The host didn't approve this check-in. Please speak to the host.` · `Try again`
- P9: `You're already checked in to <session>` · `Nothing more to do, Grace. Stay near the courts and listen for your name.`
- P9b: `You're already checked in to <session>` · `A host confirmed you're on the list. Nothing else to do.` · pill `Checked in`
- P10: `Too many attempts` · `Too many attempts. Wait a few minutes and try again.` · `Try again`
- P11: `Pickleball Social Manager` · `This check-in link isn't active` · `Ask a host at the courts for the current QR code.`
- P12: `No social open right now` · `Check back when your host opens the session.` · `Check again`
- P13: `Something went wrong` · `We couldn't reach the check-in. Check your connection and try again.` · `If you'd already pressed Check in, trying again won't send a second request.` · `Try again`

**Host tray**

- `Check-ins waiting` · `Approve to add them to Who's playing. Oldest first.` · `Show QR code`
- Chips: `Member` · `NEW PLAYER` · `<level>` · `level changed from <old level>` · `2 min ago`
- `Already checked in to this session.` `They can't be added twice.`
- `Close: already checked in` (screen-reader label `Close <name>'s request: already checked in`) · `Reject`
- `Added by another host a moment ago.` (after a refused Approve)
- `Request closed. Their phone shows they're already checked in.`
- Possible duplicate (new player): `Possible duplicate: same name as someone already checked in.` `A matching name doesn't mean it's the same person. Check with them before approving.` · `Approve` · `Reject`
- `Approve` · `Reject` (screen-reader labels `Approve <name>`, `Reject <name>`)
- `Approving…` · `Couldn't approve.` `Check your connection and retry.` · `Retry`
- `Already decided by another host` · `Added to Who's playing` · `Check-in rejected. The player sees "Please speak to the host".`
- Empty: `No check-ins waiting. Players scan the social's QR code or tap the sticker to check in.`

**Sticker and QR**

- `Back to session setup` · `Sticker and QR` · `One check-in link for <social>. Players scan the QR code or tap a sticker to check in to whichever session is open. It stays the same for every session.`
- `Check-in link` · `Link` · `Copy link` · `Copied`
- `NFC stickers: write this same link to the sticker. Every sticker and QR code for this social uses it.`
- `Show full screen` · `Print stickers`
- `Only a manager can issue a new link (Hosts page). When they do, this link, the QR code and printed stickers stop working.`
- `QR code` · `Scan to check in · <short URL>`
- Full screen: `<social>` · `Scan to check in` · `<short URL>` · close `Close full screen`
- Print: `Back` · `12 stickers per A4 page. Print on sticker sheets or plain paper and cut along the dashed lines.` · `Print` · sticker: `<social>` · `Scan to check in` · `<short URL>`

**Hosts page**

- `Check-in link` · `Players open this link from the QR code or a sticker to check in.` · `Open Sticker and QR`
- `Issue a new link if the old one was shared where it shouldn't be. The current link, QR code and every printed sticker stop working.` · `Issue new link`
- Dialog: `Issue a new check-in link?` · `<social>` · `The current link and QR code stop working immediately, including every printed and NFC sticker. Anyone who uses them sees “This check-in link isn't active”.` · `Afterwards, print new stickers from the Sticker and QR page and replace the old ones. Check-ins already sent are not affected.` · `Cancel` · `Issue new link`
