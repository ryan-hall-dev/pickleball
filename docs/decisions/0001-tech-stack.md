# 0001. Tech stack and key architectural decisions

Status: Accepted · 2026-11-07 · Plan: `docs/plans/session-manager-mvp.md`

## Context

Hosts run daily pickleball socials at a club, with 3-4 running at once, each with its own host. Attendance changes every session. Hosts need fair, explainable court rotation, reliable undo, and safe use from several devices at once. Players have no accounts and only check in from a phone. Correctness comes first, then maintainability, then effort. Cost should stay at free tiers until real usage needs more.

## Decision

**Stack:** Node 24 LTS, pnpm 12, Next.js 16.4 (App Router, server actions), React 19.3, TypeScript pinned to 5.9 (TS 7 is not supported by typescript-eslint yet), Tailwind CSS 4 with design tokens in `@theme`, Outfit via `next/font`, `@dnd-kit` for drag and drop. Supabase (Postgres + Auth) with `@supabase/supabase-js` + `@supabase/ssr` and generated types. Vitest + fast-check + `vitest bench`, Playwright, pgTAP. Sentry in production only. Vercel + Supabase free tiers, separate dev and prod projects. CI on GitHub Actions against a local Supabase stack.

**Architecture:**

- **Event-sourced action log.** Every host action is an append-only row in `session_events`; state is `replay(events)`. Undo appends a compensating action targeting a specific `target_seq`; rows are never edited or deleted. Writes go through a server action that validates with the engine, then one Postgres function (single transaction, `event_id` idempotency, `expected_seq` conflict check). Clients cannot insert events.
- **Pure scheduling engine** in `src/engine/` (no React, DB, clock or global RNG; time and a seeded RNG are passed in). Decisions (`schedule`) are separate from fairness measurement (`report`); the scheduler never reads the report.
- **Continuous weighted scoring, no hard fairness guard.** Every objective feeds one bounded (saturating) priority score. Hard constraints are validity only. Weights are calibrated by simulation.
- **Greedy plus swap local search** to pick groups. No exhaustive enumeration, so cost stays O(courts x players).
- **Supabase client + RLS instead of an ORM.** Row-level security enforces host-only access; schema changes only through `supabase/migrations`.
- **Invite-only host auth** with an email 6-digit code. Hosts are an allow-list.
- **NFC check-in**: one permanent sticker (with QR fallback) per host opens `/t/<tag>`; the player's phone is recognised by a hashed device token; the host approves every check-in from a pending tray. The only public database entry point is `submit_checkin`.
- **Polling, not Realtime**: host screens check for new actions and check-ins every 5 s, and on focus or conflict.
- **Independent sessions**: no scheduling state carries across sessions.
- **Free tiers**; upgrade when real usage requires it. No keep-alive jobs.

## Consequences

- Full history and reliable undo, including undoing an older action when still valid; multi-host conflicts are detected rather than silently overwritten. Cost: more up-front design (event types and their compensating actions) and replay on every state read (target: replay 1,000 actions in under 5 ms).
- The engine is deterministic and testable in isolation with simulations and benchmarks; fairness is a tunable trade-off, not a guarantee. Weights need calibration and tuning after real sessions.
- No ORM means hand-written SQL and RLS policies, covered by pgTAP, but fewer abstractions and automatic host-scoped security.
- Polling adds up to about 5 s latency for other hosts' changes and some load, in exchange for simplicity and no Realtime dependency.
- Free-tier risks accepted: Supabase pauses after about a week of inactivity and has no backups; restore from the dashboard, upgrade when needed.
- Very new tool versions (TS 7, ESLint 10, Vitest 5) are pinned; fall back to ESLint 9 if plugins lag.
- Sticker links can be shared, so host approval, rate limits, one pending request per phone and re-issuable tags are the controls.
