# Design System

Source: HTML exports in `Reference Designs/` (`Setup.dc.html`, `SetupConfirm.dc.html`, `Volley.dc.html`), plus PNGs in the same folder (including `Player 1 · Welcome check in@1x.png`). The Claude design tool link is not available; the exports are the source of truth for values. Last updated: 2026-11-07.

**Designs still missing:** the host pending-check-in tray (Ryan to add). The player check-in PNG exists but has no HTML export, and it differs from the plan in places (see Screens).

Tokens live in `src/app/globals.css` under `@theme`. Never hard-code hex values in components.

## Principles

- Dark, high-contrast, glanceable from a distance: hosts use this standing at the courts, often on a tablet.
- Status is never colour alone: always pair colour with text (and an icon where there's room).
- Touch targets at least 44px. Primary actions are large (52-64px high).
- Lime means "playing / go / primary action". Blue means "next / secondary action". Orange means "attention".
- Desktop-first, wraps cleanly to tablet and phone (flex-wrap and auto-fit grids, no fixed widths except modals).
- Numbers are tabular (`font-variant-numeric: tabular-nums`) so timers and counts don't jitter.

## Color tokens (dark only)

| Token                       | Value                       | Use                                                                 |
| --------------------------- | --------------------------- | ------------------------------------------------------------------- |
| bg                          | `#0F1419`                   | Page background                                                     |
| bg-header                   | `#121A21`                   | Top nav bar (1px bottom border `#24303B`)                           |
| bg-backdrop                 | `#080B0E`                   | Behind modals                                                       |
| card                        | `#182028`                   | Cards and sections                                                  |
| card-border                 | `#24303B`                   | Card border (1px)                                                   |
| inner                       | `#1C2630`                   | Inner tiles, inputs, rows                                           |
| inner-border                | `#2A3642`                   | Inner border, input border, progress track                          |
| nav-active                  | `#222D37`                   | Active nav item background                                          |
| text                        | `#F1F5F9`                   | Primary text                                                        |
| text-muted                  | `#9AA8B6`                   | Labels, captions                                                    |
| text-soft                   | `#D5DEE7`                   | Text on grey chips/avatars                                          |
| text-row                    | `#C3CDD8`                   | Secondary table cells                                               |
| placeholder / disabled text | `#7D8B99`                   | Input placeholder, disabled button                                  |
| outline                     | `#3A4856`                   | Outline/ghost button border, dashed "add" borders, off-toggle track |
| outline-blue                | `#2F4A68`                   | Outline buttons on blue (Up next) cards                             |
| drag-handle                 | `#5B6B7A`                   | Drag grip, waiting dots in capacity diagram                         |
| link                        | `#8CC4FF` (hover `#BFDFFF`) | Links                                                               |

Status colours (each has a solid, a tinted surface, an edge and an on-colour):

| Status             | Solid                  | Surface                           | Edge                                        | On-solid text | Soft text                                           |
| ------------------ | ---------------------- | --------------------------------- | ------------------------------------------- | ------------- | --------------------------------------------------- |
| Playing (lime)     | `#D4F23A`              | `#1F2A14`                         | `#4C5F14`                                   | `#18200A`     | `#E3FA7A` (also `#C9D6A0`, `#C9E86A` for secondary) |
| Next (blue)        | `#5AA9FF`              | `#13263C`                         | `#2F5E8F`                                   | `#06182B`     | `#CFE6FF` / `#8CC4FF`                               |
| Waiting (grey)     | `#64748B` (legend dot) | `#1C2630`                         | `#2A3642`                                   | n/a           | `#D5DEE7`                                           |
| Attention (orange) | `#FF9F43`              | `#251C12` / `#22201A` / `#2B2114` | `#5A4220` (`#6A4520` on overdue court card) | `#2A1606`     | `#FFB877` / `#FFD6AE`                               |

Other: avatar fills, playing `#2B3A12` on `#E3FA7A` text; next `#1D3550` on `#CFE6FF`; waiting `#2A3642` on `#D5DEE7` (not-attending `#9AA8B6`); attention `#3A2612` on `#FFC48F`. Lime track on toggles/progress: `#D4F23A`; capacity court border `#4C5F14`, divider `#4C5F14`.

## Typography

Family: **Outfit** (400, 500, 600, 700, 800), fallback `system-ui, sans-serif`. Base 15px / line-height 1.4.

| Role                             | Size / weight                                 |
| -------------------------------- | --------------------------------------------- |
| Page title (h1)                  | 32 / 800, letter-spacing -0.01em              |
| Modal title                      | 26 / 800                                      |
| Brand name (live header)         | 22 / 700, -0.01em                             |
| Brand name (nav)                 | 19 / 700                                      |
| Section h2                       | 20 / 700                                      |
| Court card title                 | 18 / 700                                      |
| Sub-heading h3                   | 15-16 / 700                                   |
| Big timer                        | 40 / 700, tabular                             |
| Stat value                       | 34 / 700 (modal tiles 28 / 700)               |
| Body                             | 15 / 400-600                                  |
| Secondary / hint                 | 13-14 / 400-500, muted                        |
| Caption (games count, sub-lines) | 12, muted                                     |
| Eyebrow (e.g. "ELAPSED")         | 12, uppercase, letter-spacing 0.12em, muted   |
| Chip / pill label                | 11-13 / 700                                   |
| Primary CTA                      | 17-19 / 800, letter-spacing 0.03em, uppercase |

## Spacing, layout

- Main column: `max-width: 1440px`, centred, padding `24px 28px 48px` (setup 56px bottom); vertical gap 16-18px between sections.
- Card padding: 22px (setup sections), 20px 22px (live sections), 18px (court cards), 16px 18px (stat tiles).
- Gaps in use: 6, 8, 10, 12, 14, 16, 18, 20, 24.
- Setup: two columns, main `flex: 999 1 640px` and summary aside `flex: 1 1 360px`.
- Live: header card `flex: 2 1 520px` + 2x2 stat grid `flex: 1 1 360px`; court grid `repeat(auto-fit, minmax(300px, 1fr))`; Up next `minmax(240px, 1fr)`; waiting queue `repeat(auto-fill, minmax(190px, 1fr))`; setup member grid `minmax(250px, 1fr)`; setup court tiles `minmax(150px, 1fr)`.
- Confirm modal: 760px wide (max 100%), 4-column stat row, 2-column match and steps grids.

## Radii and shadows

| Element                                              | Radius                        |
| ---------------------------------------------------- | ----------------------------- |
| Cards / sections                                     | 24px                          |
| Modal                                                | 28px                          |
| Up next cards, guest box                             | 20px                          |
| Court tiles, member rows, queue rows, summary panels | 16-18px                       |
| Inputs, primary/secondary buttons (44-56px)          | 14-16px (primary CTA 16-18px) |
| Small buttons (36-40px), duration/format chips       | 10-12px                       |
| Pills, chips, toggles, filter chips                  | 999px                         |
| Avatars, dots                                        | 50%                           |
| Progress bar                                         | 4px                           |

Shadow: only the modal, `0 24px 64px rgba(0,0,0,.5)`. Everything else is flat with a 1px border.

## Components

**Buttons**

- Primary (lime): `#D4F23A` bg, `#18200A` text, no border, weight 800. Sizes: Start session 64px high / 18px radius / 19px; modal Start 56px / 16px / 17px with play icon; "Done" on overdue court 44px / 14px / 700.
- Secondary (blue): `#5AA9FF` bg, `#06182B` text, 44-46px high, 14px radius ("Accept", "Add guest").
- Inverse: `#F1F5F9` bg, `#0F1419` text, 52px high, 16px radius, 700 ("Pause").
- Outline/ghost: transparent, 1px `#3A4856` border, `#F1F5F9` text, weight 600. Heights 56 (modal), 52 (End), 44 (header), 40 (section actions, 12px radius), 36 (compact, 10px radius). On blue cards use border `#2F4A68`. In the blue reuse banner: border `#2F5E8F`, text `#CFE6FF`.
- Icon button: 44x44, 12-14px radius, outline (court +/-, close x, lock).
- Disabled: transparent, `#2A3642` border, `#7D8B99` text.
- Selectable option buttons (duration, format): 44/40px high; selected = lime fill, 700; unselected = `#1C2630` fill with `#2A3642` border. "Custom..." uses dashed `#3A4856` border and muted text. Use `aria-pressed`.

**Inputs**: 48px high (46px inside guest box), radius 14px (12px in guest box), 1px `#2A3642`, bg `#1C2630` (`#182028` inside the inner guest box), text 15-16px, padding 0 14px, label above at 13px muted weight 500, gap 6px. Search input has a 42px left padding for a 18px icon. Invalid: 2px `#FF9F43` border plus orange message (12px, `#FFB877`) linked with `aria-describedby`.

**Toggle switch**: 52x30, radius 999, padding 3, 24px white knob; on = `#D4F23A` track, knob right; off = `#3A4856`, knob left. `role="switch"`, labelled by its row title. Row: title 15/600, hint 12 muted, bottom border `#24303B`, padding 10px 0.

**Avatars (initials circles)**: sizes 28 (table), 30 (guest chip), 36 (lists), 38 (up next, overlapping `margin-right:-8px` with 2px ring in card colour), 40 (court card, with 2px lime ring `box-shadow: 0 0 0 2px #D4F23A`), 52 (club logo). Initials 10-13px / 700. Colour follows status (lime / blue / grey / orange, see tokens). Logo: lime disc with six dark dots.

**Pills and chips**: status pill (table) 12/700, padding 4px 10px; skill chip 12/600, padding 3px 8px, `#2A3642` bg; court timer chip 15/700 tabular, padding 6px 12px (lime normally, orange when over target); `DEFAULT` badge 11/700 padding 3px 8px lime; guest chip: 999px, `#13263C` bg, `#2F5E8F` border, label "GUEST . LEVEL" 11/700 `#8CC4FF` tracking 0.08em, remove button 30px; counter chips on setup (padding 8px 14px, radius 14, count 18px bold; attending uses lime tint, guests blue tint); skill filter chips 40px high, selected = `#F1F5F9` fill.

**Stepper (setup progress)**: pill items, padding 8px 14px 8px 8px, `#1C2630`, 14/600; 24px circle marker: done = lime with check, attention = orange `!` on `#2B2114` with `#5A4220` border and text "Players . 1 to fix", upcoming = 2px `#3A4856` ring with number and muted text. Numbered section badges: 32x32, radius 10, `#2A3642`, weight 800.

**Cards**: `#182028`, 1px `#24303B`, radius 24. Court card: border `#24303B` (overdue `#6A4520`); header (name + timer chip), team grid `1fr auto 1fr` with "vs" (13/700 muted), players as avatar + name 600 + "N games" 12 muted, footer with 8px progress bar (track `#2A3642`, fill lime, orange when overdue) and caption "Since 19:16 . 15 min target" (overdue: "past 15 min . wrap up"), plus Done button (lime when overdue, otherwise outline). Bar width = elapsed / 15 min, capped at 100%.

**Up next card**: radius 20, padding 16; first ("Ready now") `#13263C` with `#2F5E8F` edge, others `#1C2630` with `#2A3642`; title 16/700, ETA 13/600 `#8CC4FF` ("Ready now", "In ~3 min"); overlapping blue avatars; teams line 14 ("Zoe & Kofi vs ..."); reason 13 muted; actions: Accept (flex 1, blue), Swap (outline), Lock (44px icon).

**Queue row (waiting)**: radius 18, padding 10px 12px, grab cursor, avatar 36, "rank. Name" 14/600, "N games . Total" 12 muted, wait time 15/700 tabular on the right. Next = blue tint; long wait (15 min or more) = orange tint with `#FFB877` time.

**Table (Members stats)**: `border-collapse: separate; border-spacing: 0 4px`, min-width 940, header 13/500 muted, cells padding 8px 12px, rounded rows (12px at the ends), row bg `#1C2630`, behind-average rows `#251C12`; columns Player, Games, vs avg, Playing, Total wait, Avg wait, Last game, Status. vs-avg colour: behind `#FFB877`, ahead muted, else text.

**Stat tiles**: live (card style, 16px 18px, label 13 muted, value 34/700, caption 13 muted; Courts value lime, wait caption orange); modal (`#1C2630`, radius 16, padding 12px 14px, label 13, value 28/700; "On court" tile `#1F2A14` with lime value).

**Elapsed ring**: 76px conic-gradient (lime progress on `#2A3642`), 60px inner disc `#182028`, "31:46 left". Has `role="img"` and an aria-label.

**Court tile (setup)**: 118px high, radius 18, 2px border; selected = lime border, `#1F2A14` bg, check badge; shows player dots (20px) split by a net bar; add-court tile is dashed `#3A4856`.

**Banners**: reuse banner (blue: `#13263C`, `#2F5E8F`, radius 20, padding 12px 16px, clock icon). Warning (orange: `#22201A`, `#5A4220`, radius 14, padding 10px 14px, 20px orange `!` badge, text `#FFD6AE`). Info (lime: `#1F2A14`, `#4C5F14`, radius 16, text `#E3FA7A`).

**Capacity diagram**: per-court tile (2px `#4C5F14` border, radius 10, four 14px lime dots, label `C1`) plus waiting dots (grey, with blue for the next players), with text counts below.

**Header / nav**: bar `#121A21`, inner max 1440, padding 12px 28px; logo 40px + club name 19/700; nav items padding 10px 16px, radius 12, active `#222D37` text `#F1F5F9` weight 600 (`aria-current="page"`), inactive muted weight 500; items: Session setup, Live courts, Members, History; host avatar 36px + "Host . Name" on the right.

## States

- Hover: links lighten to `#BFDFFF`. No other hover styling is specified in the exports; keep it subtle (slight surface lighten).
- Focus: not shown in the exports. Use a visible 2px focus ring (suggested lime or `#8CC4FF` with offset) on every interactive element. Mark as a decision to confirm.
- Selected: lime tint surface + lime border + check (members, courts), or lime fill (option buttons).
- Disabled: see Disabled button; also `disabled` Singles option.
- Error/attention: orange border and message text, never colour alone (icon `!` plus words).
- Drag: grab cursor on priority and queue rows; keyboard move up/down buttons are required by the plan.
- Loading, empty, pending/failed action states: not designed yet. The plan requires pending and failed states with retry, "Not enough players", "Updated by another host".

## Patterns

- Section card = numbered badge + h2 left, actions right, 16px below to content.
- Forms: label above, hint/error below, auto-fit grid (min 200px), name field spans the full row.
- Overdue court: orange chip, orange bar, orange-edged card, lime "Done" button, "wrap up" text.
- Time always `m:ss` or `h:mm:ss` tabular; estimates labelled "~" or "about"; actuals never.

## Accessibility

- Status = colour + text/icon, always (court chips show time and text; status pills show "Court 3", "Next", "Waiting"; warnings use `!` and words).
- 44px minimum targets (the exports use 36-40px for some compact buttons; build those at 44px on touch).
- Text contrast: all text tokens above are on dark surfaces; verify AA for `#9AA8B6` on `#182028` and `#7D8B99` placeholder during M9.
- Semantics used in the exports: `aria-pressed` on toggle buttons, `role="switch"` for toggles, `role="dialog" aria-modal` for the confirm modal, `aria-current="page"`, `aria-label` on icon buttons and the ring, `aria-invalid` + `aria-describedby` on invalid inputs, labelled landmarks (`aria-labelledby` on sections).
- Drag-and-drop needs keyboard and screen-reader alternatives (`@dnd-kit` plus move up/down buttons).
- Respect `prefers-reduced-motion`; no animation is specified in the exports.

## Screens

| Screen                                                            | Source                                                            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host setup (new session)                                          | `Setup.dc.html`, `Host setup — new session (Volley style)@1x.png` | Header nav, reuse banner, stepper, 4 numbered cards (Session details, Courts, Who's playing, Rotation) in the main column; summary aside with capacity diagram, estimate (the export says "About 9 rounds fit in 120 min"; build it as computed copy, e.g. "About 7 rounds fit in 120 min, so expect N-M games per player" for 15 + 2 min slots, the range computed from seats and players), checklist, and the 64px lime START PICKLEBALL SESSION button. Quick add a guest (first and last name required, skill optional). Rotation: drag-to-order priorities (Equal games for everyone, Shortest waits, Full courts, No back-to-back games) and 5 rule toggles.                                                                                                                                                                                   |
| Confirm and start                                                 | `SetupConfirm.dc.html`, `Host setup — confirm & start@1x.png`     | Modal 760px: title "Start <session>?", 4 stat tiles, First matches grid with Shuffle, "When you press Start" 4 steps, orange warning for unfinished guest, Back to setup (outline) and START SESSION (lime).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Live courts                                                       | `Volley.dc.html`, `5 · Volley — bento, fairness-first@1x.png`     | Session header (logo, elapsed ring and timer, Pause/End), 2x2 stats, Courts grid with legend (Playing, Next, Waiting, Attention), Up next with Undo and Shuffle suggestions, Players waiting queue (Skip, Add member), Members stats table.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Player check-in (phone)                                           | `Player 1 · Welcome check in@1x.png` (390px wide, no HTML export) | Top: lime logo + club name. A card with "LIVE NOW" lime label, session title (about 26/800), date and time line with "80 min left", then three mini stats (4 courts, 26 checked in, ~6m to first game). "Who's checking in?" heading, a blue-tinted recognised-phone card ("This phone was used by" / **Grace Kim**, initials circle, blue check), "Not you? Find your name", search field "Type your first name", member rows (initials, name, "Not checked in"), link "Not a member? Check in as a guest" (`#8CC4FF`), and a full-width lime CTA pinned to the bottom ("Check in as Grace" with check icon).                                                                                                                                                                                                                                       |
| Host pending-check-in tray                                        | NOT DESIGNED YET                                                  | Ryan to add. Appears on Setup and Live; approve/reject per request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Members page (`/members`)                                         | Setup design styles (`Setup.dc.html` "Who's playing?" card)       | Built in M4 from the setup member list: h1 + counter chips ("N active", "N deactivated"), blue "Add member"; one card holding the search input (18px icon, 42px left padding), skill filter chips (All/Beginner/Intermediate/Advanced) and Active/Deactivated chips (44px, `aria-pressed`, selected = `#F1F5F9` fill), a live "Showing N of M" line, then member rows in `repeat(auto-fill, minmax(min(300px, 100%), 1fr))` (wider than setup's 250px so names and the one-line "Checked in 2d ago" caption fit). Row = 36px grey avatar, name 15/600 (ellipsis), caption 12 muted (one line), skill chip; deactivated rows have a dashed `#3A4856` border and start their caption with "Deactivated". "Show N more" outline button. Add/edit is its own page: labels above, inline orange errors, duplicate-name warning banner with "Save anyway". |
| History list                                                      | NOT DESIGNED YET                                                  | History is a nav item only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Check-in (first-time form, waiting for approval, no open session) | NOT DESIGNED YET                                                  | Required by the plan (M5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
