# 0004 — Session-only participants

Status: Accepted (Ryan, 2026-11-11; implementation resumed 2026-11-15).

## Decision

Players exist only as participant snapshots within a session. Remove the membership directory, member devices, member IDs and guest/member distinction. Every session requires fresh first name, last name and Beginner/Intermediate/Advanced level, followed by host approval. Hosts supply the same required fields when adding a player.

A database unique index enforces normalised full-name uniqueness within each session, including concurrent host adds and approvals. Public requests with conflicting names remain pending; only the host sees the conflict and can reject it. A player never learns whether another person with that name is attending.

Use a separate independent 32-byte random HttpOnly cookie per session, scoped to the social's check-in path, with a one-day lifetime. Store only its SHA-256. Ignore the legacy universal `checkin_device` cookie; keep existing request rows and history. Do not use a persistent token with a public session UUID as an HMAC key: it retains universal identity at the server boundary and is deterministic from the same input.

Every submit includes the session UUID rendered with its form. The server validates and compares it with the open page; the database locks and revalidates the expected session and tag/social before writing rate-limit attempts or requests. A stale form receives `session_changed`, clears its fields and reloads. Reloads and retries within the same session reuse its cookie and pending request; rejected players can send a new request.

## Consequences

Session history, participant IDs, matches, action logs, scheduler behaviour, server-only writes and social isolation remain intact. Historical `isGuest` event fields are accepted and ignored by replay. Names are not cross-session identifiers. Clearing cookies can lose access to this phone's request; legacy-cookie requests no longer resume automatically, while the host still retains their rows.

Migrations are `20261112090000`, `20261112100000` and `20261112110000`. Apply only after backup and separate scratch rehearsal. The coordinator owns migration application, schema comparison, independent review and commits. See [the approved plan](../plans/session-only-participants.md).
