# Compact phone layout for host screens

Status: built 2026-11-20; Ryan's screenshot review passed 2026-11-20 (all 11 screens, no changes); not deployed. Branch: `feature/mobile-compact-ui` (on top of `feature/bilingual-host-screens`).

## Why

The host screens were designed desktop-first. On a phone they waste space: the header, session card, section tabs and court cards push the courts and the waiting list below the fold. Ryan supplied Design A: `docs/designs/mobile-compact/mobile-live-compact-A.html`.

## Decisions (Ryan, 2026-11-20)

1. **Phones only.** Narrow screens (below Tailwind `sm`, 640 px) get the compact layout. Tablets and laptops keep today's layout.
2. **Live order on phones: Courts, then Waiting, then Check-ins** (Design A). Tablets keep today's order.
3. **Menu and +.** On phones the header shows logo, brand, EN/VN and a ☰ button, which opens a menu with Session setup, Live courts, Hosts, the host's name and Sign out. On Live, a lime + next to the jump bar opens Add player as a bottom sheet. Tablets keep the header links and the inline form.
4. **Tap size.** Elements drawn below 44 px (EN/VN 32 px, jump links 38 px, End 40 px) keep Design A's look, but their tap area extends to 44 px.
5. **All host pages.** Setup, Hosts, Sticker & QR and sign-in get the same compact rules (top bar, spacing, corners, type sizes). Ryan reviews screenshots of every page and state.

## Compact rules (from Design A)

| Element              | Phone value                                                                    |
| -------------------- | ------------------------------------------------------------------------------ |
| Page                 | 12 px padding, 10 px gap between blocks                                        |
| Top bar              | 52 px, sticky, brand 16/700, logo 28 px                                        |
| Cards                | 16 px radius, padding 10–12 px                                                 |
| Page / session title | 17/700 (no 32 px h1)                                                           |
| Section heading      | 16/700; section label 13/700 muted uppercase                                   |
| Body                 | 14 px; captions 12 px muted                                                    |
| Buttons              | 44 px high, 12 px radius, 13 px label (primary 700, outline 600)               |
| Jump bar             | three equal links with counts, 38 px drawn / 44 px tap; current link `#2A3642` |

Colours and fonts are unchanged (existing tokens; Be Vietnam Pro in Vietnamese).

## Live screen on phones

- **Session strip:** eyebrow (LIVE · host name), session name, "N min left · updates every 5 s", End on the right. "Finish games before ending" stays as a caption under it when End is disabled.
- **Jump bar:** Courts N · Waiting N · Check-ins N (N = courts, waiting players, pending check-ins), plus the + button.
- **Ready court:** blue card, names in two columns with VS, note line, Start game / Change / Release in one row.
- **Free court:** one row, title + Free pill + caption, "Prepare next 4" on the right.
- **Waiting:** one card, rows divided by 1 px lines: "rank. Name wait", "level · status", Rest 10 and Left on the right.
- **Check-ins:** one row with the count, caption and QR button; pending rows below it in the same compact row style.
- **Not in Design A, styled the same way:** a court with a game in progress (timer, Game finished, court options, end as interrupted), the change-players panel, time-up notice, end-session dialog, Add player sheet, resting/returning players, failure and retry messages, the ended state.

## Other pages on phones

Same top bar and menu. Setup's cards, the Who's playing form and chips, the pending tray, the Start button and the confirm dialog use the compact rules; Hosts and Sticker & QR the same. Nothing is removed and no wording changes.

## Out of scope

No behaviour, data or wording changes beyond the ☰ menu, the + sheet and the jump-bar counts. No changes to the player check-in page (already phone-first). No database changes.

## Tasks

1. Shared compact styles: phone variants in `controlStyles.ts` (cards, buttons, headings) using `max-sm:` so tablets are untouched; 44 px tap-area helper.
2. Host header: phone top bar with ☰ menu (keyboard and screen-reader accessible, closes on Escape and on navigation); tablet header unchanged.
3. Live: session strip, jump bar with counts and +, order on phones, court card states, waiting rows, check-ins row, Add player sheet.
4. Setup, Hosts, Sticker & QR, sign-in: apply compact styles.
5. Tests: unit tests for the menu, the + sheet and the jump-bar counts; e2e at 390 px for both languages (no sideways scroll, nothing clipped, every tappable at least 44 px); existing e2e at desktop width still passes.
6. Review: screenshots of every page and state at 390 px in English and Vietnamese, in a review artifact for Ryan.

## Testing

Lint, typecheck, Vitest, build, Playwright against a production build. Then the screenshot review. Deploy only with Ryan's explicit approval.

## As built (2026-11-20)

- Shared phone sizes live in `src/components/controlStyles.ts` (`max-sm:` classes) and `globals.css` (14 px base, `tap-area-44`).
- Header: `src/app/(host)/HostMenu.tsx` (☰ menu); `HostNav` takes `layout="column"`; `LanguageSwitch compactOnPhones`.
- Live: the jump bar counts courts, waiting players (called players included, as in Design A) and pending check-ins (`PendingCheckinTray onWaitingCountChange`). Sections are in phone order in the DOM; `sm:order-*` puts check-ins first again on larger screens. `LiveAddPlayer` is controlled by the Live screen.
- Court card on phones: `phoneCourtLayout` picks playing / group / free; the Up next box uses `display: contents` so the free row and the ready card share the card grid. On phones the "Ready to start" heading is the pill; the "Group prepared" status shows on larger screens only.
- One new string: `host.header.menu` ("Menu" in both languages; Vietnamese to confirm).
- "Updates every 5 seconds" moved into the session card (all sizes).
- Tests: `e2e/phoneLayout.spec.ts` (390 px, both languages: no sideways scroll, no tap area under 44 px, order, counts, menu, sheet; `PHONE_SCREENSHOT_DIR` saves screenshots); `HostMenu.test.tsx`; existing tests updated for the phone order and the menu.
