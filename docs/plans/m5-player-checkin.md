# M5 — Player check-in (NFC / QR)

Part of `docs/plans/session-manager-mvp.md` (§4.1, M5 row). Status: acceptance criteria agreed (2026-11-09); designs and behaviour decisions approved by Ryan (2026-11-10), implementation not started. Designs: `docs/designs/m5/` (screens, `README.md` decisions and copy deck, `review.html`, published for review at https://claude.ai/artifact/7tuFwdCEYHRy6z1H4gzp6m). Session confirmation and start stay in M6.

## Decisions (Ryan, 2026-11-09)

- Missing screens are drafted from DESIGN.md tokens and components; Ryan approves screenshots before M5 is accepted. Drafted and reviewed 2026-11-10 (`docs/designs/m5/`).
- Privacy rule wins over the welcome PNG: no names before 2+ typed letters, at most 5 matches, never the full directory, never anyone's check-in status (no "Checked in", "Waiting" or "Not checked in"). Keep the PNG's layout and styling.
- Draft sessions use the same header as live: "LIVE NOW", time left from the planned end, "~N m to first game" estimated from the planned start.
- Rejected: neutral message ("The host didn't approve this check-in. Please speak to the host.") with "Try again"; a retry is a new request and counts towards the rate limits.
- The app is "Pickleball Social Manager". The social's name (e.g. "Pickleball Riverside") is chosen by the Social Manager and shown where the PNG has "Riverside Pickleball Club". It is `socials.name`, already done in M4.5 (edited by the social manager on the Hosts page, shown in the host header).
- Operating model (Ryan, 2026-11-09): a Social Manager owns the social (name, configuration, who may host); operational hosts run sessions on the floor. Not interchangeable roles. Implemented in M4.5: see `docs/decisions/0003-socials-and-data-isolation.md` and `docs/plans/socials.md`.
- Confirm pop-up: a recognised phone shows its own member's saved name and skill; a name picked from search shows the name only, with an optional "Update your level".
- Submitting a member's name from a phone not linked to that member always answers "Waiting for the host to approve", even if that member is already in the session (no status leak). The immediate `already_checked_in` reply is only for the member's own linked phone. _Superseded in part on 2026-11-10: see "Duplicate attendance" below. Such a request can't be approved._
- Issuing a new check-in tag (old link stops working at once) is manager-only, from the Hosts page, in M5. It rewrites `socials.checkin_tag`.

## Decisions (Ryan, 2026-11-10)

**Duplicate attendance (D-A to D-C).** A player can never be checked in to the same session twice.

- The database keeps one attendance row per member per session (`session_participants` unique on `(session_id, member_id)`), as the final guarantee.
- A pending request for a member who is already attending can't be approved. Its tray row shows "Already checked in to this session. They can't be added twice." with "Close: already checked in" and "Reject", and no Approve.
- **D-A:** closing it records a separate request outcome, `already_checked_in` (a new `checkin_request_status` value), not a rejection.
- **D-B:** after the host closes it, the requesting phone shows "You're already checked in to <session>. A host confirmed you're on the list." (screen P09b). Reject shows the neutral rejected message as usual.
- **D-C:** closing a duplicate never links the requesting phone to the member (no `member_devices` change); the member's existing phones keep their links.
- `approve_checkin` refuses a member who is already attending with `ALREADY_IN_SESSION`: no participant, no device link. Today it errors with `PARTICIPANT_ID_MISMATCH` or re-links the device when the existing participant id is passed; M5 removes both.
- Races: a pending row switches to the already-checked-in state on the next 5 s poll once the member is attending (another host approved a request from a different phone, or added them in Who's playing). An Approve already pressed is refused and the row reads "Approve stopped: already checked in · Added by another host a moment ago."

**Possible duplicate warning (D-D).** When a new-player (guest) request's normalised full name matches anyone already attending the session, the host sees a warning on that tray row. "Already attending" covers both groups (extended by Ryan, 2026-11-10): members already attending, and guests a host added directly through Who's playing. Guests are compared by their name in this session's attendance (`session_participants` first and last name); no member record is created for the comparison.

- Normalised full name: first and last name joined, lower-cased, accents removed, surrounding and repeated spaces collapsed (the same normalisation as `members.search_name`). Names only: nothing else is compared.
- Nothing is automatic: the guest isn't identified, merged or rejected. Approve and Reject both stay; the host decides.
- The player is never told about a possible match.
- Copy makes clear a matching name isn't proof of the same person: "Possible duplicate: same name as someone already checked in. A matching name doesn't mean it's the same person. Check with them before approving." (H03).

**Other approved design behaviours** (numbers refer to `docs/designs/m5/README.md`):

1. Tray placement: a full-width card under the setup stepper, above both columns (#1).
2. A member who chose "Update your level" shows the new level plus "level changed from <old>"; the request stores the chosen level (#4).
3. Decided rows (approved, rejected, closed, decided by another host) show a one-line message for about 4 s, then leave the list (#6).
4. The confirm step is a bottom sheet (#9).
5. "Update your level" is collapsed, with nothing preselected (the saved level stays private); choosing none keeps the saved level (#10).
6. When exactly 5 names match: "5 names shown. Not listed? Type more of your name." (#13).
7. No cancel button while waiting for approval (#19).
8. The Sticker and QR page has no nav item; it opens from the tray's "Show QR code" and from the Hosts page, for every host of the social (#25).
9. Print layout: A4 only, 12 stickers per page (#28). The Hosts page gets a "Check-in link" card (every host sees the link; managers see "Issue new link", the UI term for issuing a new tag) (#29).

Verified: check-in requests belong to the session, not the tag, so issuing a new link leaves requests already sent untouched (#31). The remaining wording and layout items in the README (about 20) are approved as drawn (Ryan, 2026-11-10) and are built as documented. If implementation reveals a genuine usability issue, it is flagged for Ryan's review instead of the design being changed silently.

## Acceptance criteria

**Public page `/t/<tag>` (no login, phone-first, 390 px)**

1. Unknown or reissued tag → a neutral "This check-in link isn't active" page; reveals nothing about hosts or sessions.
2. The social has no open session (draft or live with check-in open) → "No social open right now".
3. Header shows only: social name, session name, date and planned times, time left, courts count, checked-in count, "~N m to first game".
4. Recognised phone (device cookie hash matches `member_devices` of this social) → "This phone was used by <name>" card and "Check in as <first name>".
5. "Not you? Find your name": nothing listed until 2+ letters; at most 5 names; names only (no skill, no status); search covers this social's members only and is accent-insensitive (uses `members.search_name`).
6. Choosing a name opens the confirm pop-up; "Not a member? Check in as a guest" opens the first-time form (first name, last name, skill: all required, inline orange errors).
7. Submit → "Waiting for the host to approve" screen that polls every 5 s and switches to Approved ("You're in"), Rejected (neutral message + Try again) or, after a host closes a duplicate, "You're already checked in" (P09b). Reloading the page returns to the current request's state.
8. A second submit from the same phone for the same session returns the existing pending request (no duplicate).
9. Rate limits from M3 apply to every search and submit (per phone, per network, per session) and show "Too many attempts. Wait a few minutes and try again."
10. Every failure state has words and an icon, never colour alone; all targets ≥ 44 px; works without NFC via the QR link.

**Host side**

11. Pending tray on the Setup screen, under the stepper and above both columns, visible to every host of the social and showing only the open session's requests (Live comes in M7, which reuses the component): lists pending requests within 5 s (polling), oldest first, each with name, "New player"/"Member", skill (and "level changed from <old>"), plus Approve and Reject. Empty state when none.
12. Approve (one transaction, existing `approve_checkin`): a member for a first-timer, the phone linked, a session participant added; the attendee appears in Who's playing without a reload. Reject: request rejected, player's phone shows the neutral message.
    12a. A member already attending can't be approved again: the row shows the already-checked-in state with "Close: already checked in" and Reject only; the server refuses approval with `ALREADY_IN_SESSION`; closing records `already_checked_in`, links no phone, and the player's phone shows P09b. Rows switch to this state within 5 s when the member becomes attending.
    12b. A new-player request whose normalised full name matches anyone already attending (a member, or a guest added directly through Who's playing, compared by their name in this session) shows the possible-duplicate warning to hosts only; no member record is created for the comparison; Approve and Reject stay; nothing is merged, identified or rejected automatically.
13. Hosts of other socials see and decide nothing of this social's requests; two hosts of the social deciding the same request → one wins, the other sees "Already decided".
14. One check-in link and QR per social. Host "Sticker and QR" page: the social's link, a QR code (generated server-side or with a vetted library) shown full-screen for a player to scan, and a print layout (print it on any number of stickers).
15. Manager-only "Issue new tag" on the Hosts page, with confirmation; the old `/t/<tag>` link stops working immediately.

**Security**

16. All public reads and writes go through server code calling service-role functions; `anon` can execute nothing and has no table access (pgTAP).
17. The device token is a random value in an HttpOnly, Secure, SameSite=Lax cookie; only its SHA-256 hash reaches the database; the IP is an HMAC (existing `clientIdentity.ts`).
18. The public page and its server actions expose no host, session-management or admin operation; host routes stay behind `(host)` auth.
19. Public check-in never adds anyone to a session without host approval.

## Increments (each tested and committed separately)

Progress: 1 done (`745a2f0`, 2026-11-10); 2 done (2026-11-10, includes migration `20261111120000_checkin_member_names`: a member's request always stores the member's own name, so a check-in can't rename or impersonate a member). 3 done (2026-11-10): host tray on Setup; the "Show QR code" button comes with increment 4.

1. Database: search uses `search_name`; read functions for the page header, phone recognition and request status (service-role only); per-social tag reissue (manager only); `already_checked_in` request status, `approve_checkin` refusing an attending member (`ALREADY_IN_SESSION`, no device re-link), a close-as-already-checked-in function (service-role, social-scoped), and the possible-duplicate flag in the tray read. pgTAP.
2. Public page: header, recognition, search, confirm, guest form, waiting/approved/rejected states. Unit, integration, e2e at 390 px.
3. Host pending tray on Setup with approve/reject, close-as-already-checked-in and the possible-duplicate warning. Integration + the full player-to-host e2e journey (two browser contexts), including a duplicate request from a second phone.
4. Sticker and QR page, manager tag reissue. e2e.

## Roles and socials

See `docs/decisions/0003-socials-and-data-isolation.md` (accepted) and `docs/plans/socials.md` (M4.5, done): independent socials, one login per social as manager or host, per-social members, courts, sessions and check-in.
