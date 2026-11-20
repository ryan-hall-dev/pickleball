# English / Tiếng Việt switch

Status: approved 2026-11-19. Phase 1 deployed 2026-11-20 (review passed, no changes). Phase 2 (host screens) built 2026-11-20; Vietnamese review passed the same day (all 435 lines approved, no changes); not deployed.

## Goal

Hosts and players can switch the interface between English and Vietnamese without signing in. Each browser remembers its own choice. Buttons, instructions, errors and messages, and dates and times follow the chosen language. Player names, social names, QR codes and links stay exactly as entered.

## Decisions

- **Languages:** `en` and `vi` only.
- **First visit:** `vi` when the browser's `Accept-Language` prefers Vietnamese, otherwise `en`.
- **Remembered choice:** the cookie `pickleball_locale` (`en` | `vi`), one year, `SameSite=Lax`, not HttpOnly. It holds no personal data and doesn't depend on signing in. Using a cookie rather than localStorage lets the server render the right language and `<html lang>` on the first paint.
- **No i18n library.** `src/i18n/en.ts` is the source of truth. `src/i18n/vi.ts` is typed as the same message tree, so a missing or extra key fails `pnpm typecheck`. A small `t(key, values)` handles `{name}` placeholders. English plurals use explicit `one`/`other` keys; Vietnamese has no plural forms.
- **Access:**
  - Server components call `getMessages()`, which reads the cookie.
  - Client components get the messages through a `LocaleProvider` set in the root layout.
  - Switching writes the cookie in the browser (no server action), re-renders client text at once, then calls `router.refresh()` for server-rendered text. State held in client components (typed fields, host drafts) is kept.
- **Server messages:** server actions read the locale and translate where the message is produced. Engine `sessionError` codes are mapped to translated text in the app layer, and the engine stays pure with its English text as the fallback. Check-in results are already code-based.
- **Dates and times:** `src/lib/sessionTime.ts` takes the locale and uses `vi-VN` or `en-GB` (24-hour clock in both).
- **Switch:** an "EN | VI" pair, each a 44px button with `aria-pressed`, labelled "Language" / "Ngôn ngữ". It goes at the top of the public check-in page, in the host header and on the sign-in page.
- **Tone:** player-facing Vietnamese uses "bạn". The reviewer can change it.
- **Review:** Claude drafts `vi.ts` and generates a side-by-side English | Vietnamese review page. A native speaker reviews it before each phase is deployed.

## Out of scope

- The Supabase sign-in email template. It is hosted Auth config and needs separate approval.
- A host final report or History screen. It isn't in the simple workflow; the end-of-session summary and time-up notice on Live are translated.
- Server logs and Sentry, which stay in English.
- Data stored in the database: event payloads and snapshots are never translated.

## Phases

### Phase 1: language setup and public check-in

1. `src/i18n/` holds `locales.ts` (types, `pickLocale(acceptLanguage, cookie)`), `en.ts`, `vi.ts`, `t()`, `getLocale()`/`getMessages()` (server) and `LocaleProvider`/`useMessages()` (client).
2. The root layout uses `<html lang={locale}>`, and `global-error.tsx` falls back to `en`.
3. Add the `LanguageSwitch` component (it saves the cookie in the browser).
4. Translate everything under `src/app/t/[tag]/` and the check-in server messages (`checkinResults`, `checkinActions`). Dates in the check-in header follow the locale.
5. Tests:
   - Unit tests for `pickLocale` and `t()`.
   - A component test showing the switch changes the text and keeps typed input.
   - The `vi` keys must match `en` (typecheck, plus one runtime test for the placeholders).
   - An e2e check-in journey in Vietnamese, starting from a browser with a Vietnamese `Accept-Language`.
6. Generate the review page for the check-in strings, then fix any wording the review turns up.

### Phase 2: host screens

The host screens are sign-in, the host header and nav, Setup (with the pending check-in tray), Live (courts, waiting, add player, seat picker, recovery, time-up, end), Hosts, Sticker and QR, and the print page. Translate them with their server action messages and the engine error-code map. Tests: the existing English suites stay as they are, plus a Vietnamese live smoke e2e at 390px. Phone layout check: Vietnamese text is often longer, so every button must still fit.

## Verification

Each phase runs lint, typecheck, format check, Vitest with local Supabase, pgTAP (it shouldn't change) and the full Playwright suite. No migration is expected. Each deploy needs its own approval.

## Phase 1 as built (2026-11-19)

- **Files:**
  - `src/i18n/locales.ts` (`pickLocale`, `localeFromAcceptLanguage`).
  - `src/i18n/messages/{en,vi,index}.ts`.
  - `src/i18n/getLocale.ts` (server).
  - `src/i18n/LocaleProvider.tsx` (client: `useLocale`, `useMessages`).
  - `src/components/LanguageSwitch.tsx` (in the check-in brand line on every check-in screen).
- **First paint:** the check-in page reads the locale inside its Suspense boundary and wraps the page in `LocaleProvider`. `<html lang>` stays `en` in the static shell (`cacheComponents`), and the provider wraps its children in a `lang` element (correct from the first paint), then updates `<html lang>` after hydration. The Suspense fallback shows "Loading… · Đang tải…". The page title follows the locale (`generateMetadata`).
- **Font:** Outfit has no Vietnamese tone marks (Google subsets `latin`, `latin-ext` only). Vietnamese text uses Be Vietnam Pro (`--font-vietnamese`, weights 400-800, not preloaded), applied by the provider when the locale is `vi`. English keeps Outfit.
- **Validation:** the shared input rules keep their English messages, which now come from `en.validation`. `translateValidationMessage` shows them in the chosen language, so the server's field errors are translated too. Check-in failures were already codes.
- **Dates:** `formatSessionWhen(start, end, locale)` uses `en-GB` or `vi-VN` ("Thứ 7, 7 thg 11 · 18:00 – 20:00"). Host callers still default to English until phase 2.
- **Review:** `pnpm i18n-review-rows` prints every line as `{key, en, vi}` JSON. The private review page (claude.ai artifact `G6GKdttwi7Cti1ghBfxDP6`) stores the reviewer's ticks and wordings in its `suggestions` collection, which Claude reads back and applies.
- **Tests:**
  - `src/i18n/locales.test.ts`.
  - The Vietnamese date case in `checkinHeaderFormatting.test.ts`.
  - The switch keeping typed input and translating errors (`ParticipantCheckinForm.test.tsx`).
  - The e2e "in Vietnamese" describe in `e2e/checkin.spec.ts`: a `vi-VN` browser checks in in Vietnamese at 390px, gets approved, switches to English, and the choice survives a reload; plus the inactive link in Vietnamese.

## Phase 2 as built (2026-11-20)

- **Where the switch is:** the host header (every host page) and the sign-in page. The host layout reads the language once and wraps the area in `LocaleProvider`; Suspense fallbacks outside a provider show "Loading… · Đang tải…".
- **Files:** `src/i18n/messages/hostEn.ts` / `hostVi.ts` (screen text), `serverEn.ts` / `serverVi.ts` (server messages and one sentence per engine error code), `src/i18n/courtName.ts`, `getMessages()` and `hostPageTitle()` in `src/i18n/getLocale.ts`.
- **Server messages:** server actions still answer in English, now taken from `en.serverMessages` / `en.validation` (one source). The browser shows them through `translateMessage`, which matches exact strings and the patterns of message functions (names and numbers carried over). A message stays in the stored English and is translated when drawn, so an error on screen follows a language switch. Messages made in the browser (offline, unconfirmed write, wait for save) use the same set.
- **Engine rejections:** `LiveWriteResult` carries `engineErrorCode`; English shows the engine's own detailed message, Vietnamese the sentence for the code (`translateEngineError`).
- **Court names:** generated names ("Court 3") read "Sân 3" in Vietnamese; any other stored name stays as entered.
- **Printed stickers** use the printing host's language ("Scan to check in" / "Quét để điểm danh").
- **Not translated:** the six old Setup components no longer rendered (`CourtsCard`, `RotationCard`, `SavedSetups`, `SessionDetailsCard`, `SessionSummary`, `SetupStepper`), and server messages only they can trigger.
- **Review:** `pnpm i18n-review-rows` now picks sample values by parameter name and runs with a small resolve hook (`scripts/resolveTsExtensions.mjs`). The phase 2 review page (claude.ai artifact `Bus1U7NV2B6ekDx1yYrEjL`) holds the 435 new lines; notes save to its `suggestions` collection.
- **Tests:** `translateMessage` / engine / court-name unit tests (`src/i18n/locales.test.ts`), a Vietnamese court card test, host component tests render inside `renderWithLocale`, and `e2e/hostVietnamese.spec.ts`: a `vi-VN` phone at 390px signs in, sets up, starts and finishes a game in Vietnamese with no sideways scroll, then switches to English and the choice survives a reload.
- **Known:** in Who's playing, the longer Vietnamese chip label ("TRUNG BÌNH · NAM") truncates names sooner on a phone (the English chip already truncates long names).
