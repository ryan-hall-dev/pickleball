# M5 — Player check-in (NFC / QR)

Part of `docs/plans/session-manager-mvp.md` (§4.1, M5 row). Status: acceptance criteria agreed before implementation (2026-11-09). Session confirmation and start stay in M6.

## Decisions (Ryan, 2026-11-09)

- Missing screens are drafted from DESIGN.md tokens and components; Ryan approves screenshots before M5 is accepted.
- Privacy rule wins over the welcome PNG: no names before 2+ typed letters, at most 5 matches, never the full directory, never anyone's check-in status (no "Checked in", "Waiting" or "Not checked in"). Keep the PNG's layout and styling.
- Draft sessions use the same header as live: "LIVE NOW", time left from the planned end, "~N m to first game" estimated from the planned start.
- Rejected: neutral message ("The host didn't approve this check-in. Please speak to the host.") with "Try again"; a retry is a new request and counts towards the rate limits.
- The app is "Pickleball Social Manager". The social's name (e.g. "Pickleball Riverside") is chosen by the Social Manager and shown where the PNG has "Riverside Pickleball Club". It is `socials.name`, already done in M4.5 (edited by the social manager on the Hosts page, shown in the host header).
- Operating model (Ryan, 2026-11-09): a Social Manager owns the social (name, configuration, who may host); operational hosts run sessions on the floor. Not interchangeable roles. Implemented in M4.5: see `docs/decisions/0003-socials-and-data-isolation.md` and `docs/plans/socials.md`.
- Confirm pop-up: a recognised phone shows its own member's saved name and skill; a name picked from search shows the name only, with an optional "Update your level".
- Submitting a member's name from a phone not linked to that member always answers "Waiting for the host to approve", even if that member is already in the session; the tray marks such a request "Already in this session". The `already_checked_in` reply is only for the member's own linked phone.
- Issuing a new check-in tag (old link stops working at once) is manager-only, from the Hosts page, in M5. It rewrites `socials.checkin_tag`.

## Acceptance criteria

**Public page `/t/<tag>` (no login, phone-first, 390 px)**

1. Unknown or reissued tag → a neutral "This check-in link isn't active" page; reveals nothing about hosts or sessions.
2. The social has no open session (draft or live with check-in open) → "No social open right now".
3. Header shows only: social name, session name, date and planned times, time left, courts count, checked-in count, "~N m to first game".
4. Recognised phone (device cookie hash matches `member_devices` of this social) → "This phone was used by <name>" card and "Check in as <first name>".
5. "Not you? Find your name": nothing listed until 2+ letters; at most 5 names; names only (no skill, no status); search covers this social's members only and is accent-insensitive (uses `members.search_name`).
6. Choosing a name opens the confirm pop-up; "Not a member? Check in as a guest" opens the first-time form (first name, last name, skill: all required, inline orange errors).
7. Submit → "Waiting for the host to approve" screen that polls every 5 s and switches to Approved ("You're in") or Rejected (neutral message + Try again). Reloading the page returns to the current request's state.
8. A second submit from the same phone for the same session returns the existing pending request (no duplicate).
9. Rate limits from M3 apply to every search and submit (per phone, per network, per session) and show "Too many attempts. Wait a few minutes and try again."
10. Every failure state has words and an icon, never colour alone; all targets ≥ 44 px; works without NFC via the QR link.

**Host side**

11. Pending tray on the Setup screen, visible to every host of the social and showing only the open session's requests (Live comes in M7, which reuses the component): lists pending requests within 5 s (polling), each with name, "New player"/"Member" and skill, plus Approve and Reject. Empty state when none.
12. Approve (one transaction, existing `approve_checkin`): a member for a first-timer, the phone linked, a session participant added; the attendee appears in Who's playing without a reload. Reject: request rejected, player's phone shows the neutral message.
13. Hosts of other socials see and decide nothing of this social's requests; two hosts of the social deciding the same request → one wins, the other sees "Already decided".
14. One check-in link and QR per social. Host "Sticker and QR" page: the social's link, a QR code (generated server-side or with a vetted library) shown full-screen for a player to scan, and a print layout (print it on any number of stickers).
15. Manager-only "Issue new tag" on the Hosts page, with confirmation; the old `/t/<tag>` link stops working immediately.

**Security**

16. All public reads and writes go through server code calling service-role functions; `anon` can execute nothing and has no table access (pgTAP).
17. The device token is a random value in an HttpOnly, Secure, SameSite=Lax cookie; only its SHA-256 hash reaches the database; the IP is an HMAC (existing `clientIdentity.ts`).
18. The public page and its server actions expose no host, session-management or admin operation; host routes stay behind `(host)` auth.
19. Public check-in never adds anyone to a session without host approval.

## Increments (each tested and committed separately)

1. Database: search uses `search_name`; read functions for the page header, phone recognition and request status (service-role only); per-social tag reissue (manager only). pgTAP.
2. Public page: header, recognition, search, confirm, guest form, waiting/approved/rejected states. Unit, integration, e2e at 390 px.
3. Host pending tray on Setup with approve/reject. Integration + the full player-to-host e2e journey (two browser contexts).
4. Sticker and QR page, manager tag reissue. e2e.

## Roles and socials

See `docs/decisions/0003-socials-and-data-isolation.md` (accepted) and `docs/plans/socials.md` (M4.5, done): independent socials, one login per social as manager or host, per-social members, courts, sessions and check-in.
