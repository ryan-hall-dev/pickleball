# Light mode

Status: done
Branch: feature/light-mode

## Goal

Make every screen readable under bright court lighting. Ryan saw it at a social on 2026-11-21: the dark screens were hard to read.

## Scope

### In

- A light colour set for every screen: host screens, sign-in, the player check-in page, and Sticker & QR.
- Light is the default everywhere.
- Hosts get a sun/moon switch next to EN/VN in the header. On phones it sits in the 52 px bar. Each device remembers its choice.
- The player check-in page (`/t/<tag>`) is always light and has no switch.
- A screenshot review page for Ryan (phone and tablet, light beside dark) before the build is finished.

### Out

- Following the phone's own light/dark setting.
- A per-host saved preference (nothing on the server).
- Layout or wording changes.
- The print sticker sheet, which is already black on white.

## Decisions

- **Colours stay as tokens.**
  - Components keep their token utilities. Light values live in the base theme; dark values are a `[data-theme="dark"]` override in `src/app/globals.css`.
  - Today's dark values stay exactly as they are.
  - No hex values in components (DESIGN.md).
- **Status colours get separate text tokens.**
  - Lime, blue and orange are used both as fills and as text (`text-lime` 20 places, `text-blue` 7, `text-orange` 28).
  - Lime text is unreadable on white. New tokens `lime-ink`, `blue-ink` and `orange-ink` take over every `text-lime/blue/orange` (and the soft/text variants where they sit on light surfaces).
  - In dark they equal today's colours. In light they are deep green, blue and orange.
  - Fills (lime buttons, chips) keep the bright solids with their dark on-colour text.
- **Contrast target for light:**
  - Body and status text at least 7:1 (WCAG AAA), because the screens are read in glare.
  - Muted text at least 4.5:1.
  - Card edges visible on white (no near-white-on-white borders).
- **No flash on load.**
  - A tiny inline script in the root layout reads `localStorage["pickleball-theme"]` (in try/catch) and sets `data-theme` on `<html>` before first paint. If there is nothing saved, or storage is blocked, it uses light.
  - It also sets `color-scheme`, so date inputs and scrollbars match.
  - Pages stay statically cacheable (no cookie read in the root layout under cacheComponents).
- **The player page is locked to light, in two ways:**
  - The no-flash script always uses light on `/t/` paths, so the page background and overscroll are light.
  - The page's wrapper also carries `data-theme="light"`, which re-declares the light values whatever the device chose on the host side.
- **Fixed whites stay white.**
  - QR codes and the full-screen QR keep `bg-white` (scanners need it).
  - The toggle knob in `RotationCard` stays white.
  - Modal shadows soften in light via a `--shadow-modal` token.

## Tasks

### Phase 1: palette and plumbing

- [ ] **1.1** Light palette and theme plumbing. agent: implementer.
  - Files: `src/app/globals.css`, `src/app/layout.tsx`, `src/components/ThemeSwitch.tsx` (new), `src/components/ThemeSwitch.test.tsx` (new), `src/i18n/messages/*` (switch labels, EN + VN).
  - Light token values: draft, with every text/surface pair checked against the contrast target.
  - The `*-ink` and `--shadow-modal` tokens.
  - The no-flash script.
  - The switch: 44 px buttons, `aria-pressed`, the compact 32 px version with `tap-area-44`, matching LanguageSwitch.

### Phase 2: apply (after 1.1; files are disjoint)

- [ ] **2.1** Host header and live screens. agent: implementer.
  - Files: `src/app/(host)/layout.tsx`, `src/app/(host)/live/*`, `src/components/InitialsAvatar.tsx`, `src/components/AttentionMessage.tsx`.
  - Add the switch to the header and the ☰ menu row.
  - Move `text-lime/blue/orange` to `*-ink` where it is text on a surface.
- [ ] **2.2** Setup, hosts, Sticker & QR and sign-in. agent: implementer.
  - Files: `src/app/(host)/setup/*`, `src/app/(host)/hosts/*`, `src/app/(host)/checkin-link/*`, `src/app/login/*`.
  - Same token moves. Modal shadows use `--shadow-modal`.
- [ ] **2.3** Player check-in page locked to light. agent: implementer.
  - Files: `src/app/t/[tag]/*`.
  - Add the `data-theme="light"` wrapper, filling the viewport with `bg-bg`, plus the token moves.

### Phase 3: verify and review

- [ ] **3.1** e2e. agent: implementer.
  - Files: `e2e/theme.spec.ts` (new), `e2e/phoneLayout.spec.ts`.
  - Light is the default. The switch goes to dark, the choice survives a reload, and there is no dark flash on load.
  - The player page stays light after a host on the same browser chose dark.
  - Screenshots in both themes.
- [ ] **3.2** Screenshot review page for Ryan (light beside dark; phone 390 and tablet 820; setup, live with 8 courts, waiting, check-in tray, add-player sheet, player check-in states). agent: general. Files: scratchpad only.
  - Palette fixes from his review go back through 1.1's files.
- [ ] **3.3** Docs. agent: general. Files: `DESIGN.md` (light token table, the `*-ink` rule, the switch, the player page always light), `docs/ROADMAP.md`.

## Test plan

- Unit (Vitest):
  - ThemeSwitch: pressed state, saving the choice, labels in both languages.
  - Existing component tests still pass.
- e2e (Playwright, chromium and mobile): `e2e/theme.spec.ts` as in 3.1. The full suite runs against `pnpm build && pnpm start`.
- Contrast: a small check over the light token pairs (text on bg, card, inner and status surfaces) meets 7:1 (muted 4.5:1). The check runs as a Vitest test that reads `globals.css`.
- `/quality-check`: lint, typecheck, unit, build, e2e.
- Run the app: check every host screen and the player page in both themes at 390 and 820 px, then Ryan's screenshot review.
- Deploy only after Ryan approves.

## Log

- 2026-11-21:
  - Built on `feature/light-mode`.
  - The switch is a single moon/sun button rather than a pair, so it fits the 52 px phone bar.
  - The player page lock is a CSS `:has([data-theme-lock="light"])` guard on the dark override, plus the boot script ignoring the saved choice on `/t/`. This replaces a second copy of the light values.
  - Contrast test: 38 pairs pass.
  - Unit tests: 970 pass.
  - e2e:
    - 70 passed.
    - `live.spec.ts:244` (mobile) is flaky on a Rest-button count timeout. It fails 1 run in 15 both on `efa08ff` and on this branch, so the flakiness predates light mode. Left for a separate fix.
  - Screenshot review: https://claude.ai/artifact/NtGCczUh9nEHyoL3WQDZTu
- 2026-11-21: Ryan marked all 14 review screens "Looks right". Next: deploy approval.
- 2026-11-21: Deployed a clean export of `f2201f2` to production (`pickleball-pilot-9y4667qo9`); smoke checks passed. Rollback: promote `pickleball-pilot-hgals2y0b`.
