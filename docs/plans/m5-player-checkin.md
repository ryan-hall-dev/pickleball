# M5 — Player check-in (NFC / QR)

Part of `docs/plans/session-manager-mvp.md` (§4.1, M5 row). Status: acceptance criteria agreed before implementation (2026-11-09). Session confirmation and start stay in M6.

## Decisions (Ryan, 2026-11-09)

- Missing screens are drafted from DESIGN.md tokens and components; Ryan approves screenshots before M5 is accepted.
- Privacy rule wins over the welcome PNG: no names before 2+ typed letters, at most 5 matches, never the full directory, never anyone's check-in status (no "Checked in", "Waiting" or "Not checked in"). Keep the PNG's layout and styling.
- Draft sessions use the same header as live: "LIVE NOW", time left from the planned end, "~N m to first game" estimated from the planned start.
- Rejected: neutral message ("The host didn't approve this check-in. Please speak to the host.") with "Try again"; a retry is a new request and counts towards the rate limits.
- The app is "Pickleball Social Manager". The social's name (e.g. "Pickleball Riverside") is chosen by the Social Manager and shown where the PNG has "Riverside Pickleball Club". It is stored in the existing single-row `club_settings.club_name` and edited by admins (today's Social Manager role) on the Hosts page; fallback "Pickleball Social Manager" until set.
- Operating model (Ryan, 2026-11-09): a Social Manager owns the social (name, configuration, who may host); operational hosts run sessions on the floor. Not interchangeable roles. See "Roles today vs the operating model" below; M5 does not expand beyond it.
- Confirm pop-up: a recognised phone shows its own member's saved name and skill; a name picked from search shows the name only, with an optional "Update your level".
- Submitting a member's name from a phone not linked to that member always answers "Waiting for the host to approve", even if that member is already in the session; the tray marks such a request "Already in this session". The `already_checked_in` reply is only for the member's own linked phone.
- Issuing a new sticker tag (old link stops working at once) is admin-only, from the Hosts page, in M5.

## Acceptance criteria

**Public page `/t/<tag>` (no login, phone-first, 390 px)**

1. Unknown or reissued tag → a neutral "This check-in link isn't active" page; reveals nothing about hosts or sessions.
2. Host has no open session (draft or live with check-in open) → "No social open with this host right now".
3. Header shows only: social name, session name, date and planned times, time left, courts count, checked-in count, "~N m to first game".
4. Recognised phone (device cookie hash matches `member_devices`) → "This phone was used by <name>" card and "Check in as <first name>".
5. "Not you? Find your name": nothing listed until 2+ letters; at most 5 names; names only (no skill, no status); search is accent-insensitive (uses `members.search_name`).
6. Choosing a name opens the confirm pop-up; "Not a member? Check in as a guest" opens the first-time form (first name, last name, skill: all required, inline orange errors).
7. Submit → "Waiting for the host to approve" screen that polls every 5 s and switches to Approved ("You're in") or Rejected (neutral message + Try again). Reloading the page returns to the current request's state.
8. A second submit from the same phone for the same session returns the existing pending request (no duplicate).
9. Rate limits from M3 apply to every search and submit (per phone, per network, per session) and show "Too many attempts. Wait a few minutes and try again."
10. Every failure state has words and an icon, never colour alone; all targets ≥ 44 px; works without NFC via the QR link.

**Host side**

11. Pending tray on the Setup screen (Live comes in M7, which reuses the component): lists pending requests within 5 s (polling), each with name, "New player"/"Member" and skill, plus Approve and Reject. Empty state when none.
12. Approve (one transaction, existing `approve_checkin`): a member for a first-timer, the phone linked, a session participant added; the attendee appears in Who's playing without a reload. Reject: request rejected, player's phone shows the neutral message.
13. Approving a player who is live in another social is refused with a message naming that social (move flow is M7; the plan's "asks the host to move them" is shown as text only in M5).
14. Each host sees and decides only their own session's requests; two hosts deciding the same request → one wins, the other sees "Already decided".
15. Host "Sticker and QR" page: the host's own check-in link, a QR code (generated server-side or with a vetted library), and a print layout. Admins edit the social's name on the Hosts page.
16. Admin-only "Issue new tag" on the Hosts page, with confirmation; the old `/t/<tag>` link stops working immediately.

**Security**

17. All public reads and writes go through server code calling service-role functions; `anon` can execute nothing and has no table access (pgTAP).
18. The device token is a random value in an HttpOnly, Secure, SameSite=Lax cookie; only its SHA-256 hash reaches the database; the IP is an HMAC (existing `clientIdentity.ts`).
19. The public page and its server actions expose no host, session-management or admin operation; host routes stay behind `(host)` auth.
20. Public check-in never adds anyone to a session without host approval.

## Increments (each tested and committed separately)

1. Database: search uses `search_name`; read functions for the page header, phone recognition and request status (service-role only); social name column; admin tag reissue. pgTAP.
2. Public page: header, recognition, search, confirm, guest form, waiting/approved/rejected states. Unit, integration, e2e at 390 px.
3. Host pending tray on Setup with approve/reject. Integration + the full player-to-host e2e journey (two browser contexts).
4. Sticker and QR page, social name, admin tag reissue. e2e.

## Roles today vs the operating model (assessment, 2026-11-09)

| Operating model                        | Today                                                                                                                                                                                            | Gap                                                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The social (e.g. Pickleball Riverside) | One deployment = one social. `club_settings.club_name` exists (single row) but nothing reads or edits it                                                                                         | Wire it up in M5 (name on check-in page and header, admin edits it)                                                                                             |
| Social Manager                         | Role `admin`: invites/removes hosts, adds courts, (M5) reissues sticker tags; at least one admin is enforced. An admin can also run sessions                                                     | UI calls it "Admin". Renaming the label to "Social manager" is cosmetic                                                                                         |
| Operational hosts                      | Role `host`: run sessions, manage members, approve check-ins                                                                                                                                     | Matches                                                                                                                                                         |
| Hosts working together                 | Each session belongs to the host who created it. Only that host can edit it in Setup; its check-ins arrive via that host's sticker. Live actions and check-in approvals are allowed for any host | Open: do the two hosts co-run one session (needs shared setup and either sticker opening it) or each run their own?                                             |
| Members, courts                        | Shared by the whole social                                                                                                                                                                       | Matches                                                                                                                                                         |
| Saved setups                           | Private to the host who saved them                                                                                                                                                               | Open: should the manager's setups be shared with the social's hosts?                                                                                            |
| Several socials at one venue           | Plan §1 assumed 3-4 socials at once, each with its own host, in one deployment                                                                                                                   | Open: is each social its own deployment (own members and managers), or must one deployment hold several socials? The latter is multi-tenant and a larger change |
