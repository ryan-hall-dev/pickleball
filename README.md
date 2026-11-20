# Pickleball Social

A court-rotation and check-in app for pickleball club socials. The host enters how many courts are open; players check in by scanning a QR code; the app decides who plays next so everyone gets a fair share of games, and keeps the courts full.

Built for real use: it runs a live club pilot, on phones and tablets, courtside.

## What it does

- **Fair court rotation.** A scheduling engine recommends the next group for every free court, balancing games played, waiting time, court time, rest and repeat partners/opponents, and explains each pick in plain words ("Waiting ~14 min", "No repeat partners").
- **Live host screen.** Courts, Up next, Waiting and Resting at a glance. *Game finished → Start these four* turns a court over in two taps. Rests keep a player's earned place in the queue.
- **QR player check-in.** Players scan a printed sticker and check themselves in; the host approves them from a pending tray.
- **Passwordless host login.** One-time email codes, with server-side throttling.
- **English / Tiếng Việt.** Bilingual interface for a Ho Chi Minh City club.
- **Built for courtside.** Dark, high-contrast UI readable from a distance; status never relies on colour alone; 44 px+ touch targets.

## Tech stack

| Area | Tools |
| --- | --- |
| App | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4 |
| Data | Supabase (Postgres, Row Level Security, OTP auth), SQL migrations, Zod validation |
| Quality | Vitest + Testing Library, fast-check property tests, Playwright end-to-end tests, pgTAP database tests |
| Ops | Sentry error monitoring, Vercel hosting |

## How it's built

```
src/engine/     Pure TypeScript scheduling + fairness engine (no React, Supabase, clock or randomness)
src/server/     Server-only writes: auth, setup, live session, check-in
src/app/        Next.js routes: host setup, live screen, printable check-in QR, public check-in page
supabase/       Migrations, RLS policies and database tests
docs/           Engine write-up, architecture decisions (ADRs), plans and design mockups
```

Design choices worth a look:

- **Deterministic engine.** The scheduler takes a plain snapshot and returns a recommendation. An architecture test fails the build if engine code imports a framework or calls `Date.now()` / `Math.random()`, so every decision is reproducible in tests. See [`docs/engine.md`](docs/engine.md).
- **Simulation testing.** Whole sessions are simulated through the real event model and scored with fairness metrics (including Jain's fairness index) to tune the engine.
- **Server-only writes + RLS.** The browser never writes to the database directly. See [`docs/decisions/0002-server-only-writes.md`](docs/decisions/0002-server-only-writes.md).
- **Decisions are written down.** Five ADRs in [`docs/decisions/`](docs/decisions/) cover the stack, data isolation between clubs, and the simplified host workflow.

## Running locally

Requires Node 24, pnpm and the Supabase CLI (Docker).

```bash
pnpm install
cp .env.example .env.local     # fill in the local Supabase values printed by db:start
pnpm db:start                  # local Supabase
pnpm db:reset                  # apply migrations
pnpm seed                      # sample data
pnpm dev                       # http://localhost:3000
```

Tests:

```bash
pnpm test        # unit, component and property tests
pnpm e2e         # Playwright end-to-end tests
pnpm typecheck && pnpm lint
```

## Status

In use at a club pilot. Built by [Ryan Hall](https://github.com/ryan-hall-dev).
