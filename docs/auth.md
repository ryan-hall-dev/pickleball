# Host authentication

Hosts sign in with an emailed 6-digit code (Supabase email OTP). Players never sign in: `/t/<tag>` is public and isn't touched by the auth proxy.

## How it works

- **Login** (`/login`): enter email, get a code, enter it. The server actions in `src/server/auth/loginActions.ts` call `signInWithOtp` / `verifyOtp` through `@supabase/ssr`, which sets the session cookie.
- **No sign-ups from the login form.** `shouldCreateUser: false`, plus `enable_signup = false` in `supabase/config.toml`. Logins are created only when a social manager invites someone, or by `pnpm create-social`. An email that isn't invited gets the same "if this email is on the hosts list, a code is on its way" screen, and no email is sent, so the form can't be used to find out who the hosts are.
- **Throttle.** Supabase's own per-IP limits only ever see the Next.js server's IP, so they act as one global counter, and one attacker could lock every host out. So before asking Supabase to send or check a code, the server calls `record_login_attempt` (service_role only; migration `20261108090000_login_throttle.sql`). Limits per 10 minutes: 20 attempts per client IP, 5 code requests and 10 code checks per email. Refused attempts aren't recorded, and rows older than a day are pruned. Only hashes are stored: an HMAC of the IP (`hashClientIp`, keyed with `CHECKIN_IP_HMAC_SECRET`) and a SHA-256 of the email. Invited and uninvited emails get the same answers, and Supabase's per-email send limit (which only fires for existing users) is also shown as "code sent".
- **Client IP.** The client IP is the first `x-forwarded-for` entry, set by the host platform. Vercel overwrites whatever the client sends. A bare `next start` with no proxy in front keeps a client-supplied value, so self-hosting needs a proxy that sets the header. The per-email limits still apply either way.
- **Allow-list.** Signing in isn't enough. The host area (`src/app/(host)/layout.tsx`) checks the `hosts` table with a verified `getUser()`. A signed-in user without a hosts row sees "You're not a host here. Ask your social manager for an invite." and can sign out.
- **Session refresh.** `src/proxy.ts` refreshes the Supabase session on every request and sends signed-out visitors to `/login`. That's only an optimistic check: pages and every server action check access again on the server.
- **Socials and roles** (`docs/plans/socials.md`). An installation holds several independent socials. One login belongs to exactly one social (`hosts.social_id`, which never changes), as a **social manager** (`manager`) or a **host** (`host`). A host reads only their own social and its hosts (RLS via `private.current_social_id()`). A manager can also invite and remove hosts, rename the social (Hosts page, "Social name") and add courts. The header shows the social's name. The check-in sticker tag belongs to the social (`socials.checkin_tag`, 122 random bits), not to a host.
- **Invites** (`/hosts`, social managers only). The manager enters an email and a display name. The server confirms the caller is a manager, then uses the service-role client (`SUPABASE_SECRET_KEY`, server only) to create a confirmed, passwordless login (or reuse an existing one) and add a `hosts` row with role `host` in the manager's own social. An email that already hosts another social gets a neutral "That email can't be invited here. Use a different email." that reveals nothing about that social. No invite email is sent: tell the new host to sign in at `/login` with that email.
- **Removing hosts** (social managers only, own social only). The `hosts` row is deleted first, which revokes access straight away (RLS), and then the login itself (only if a row was actually deleted). Managers can't remove themselves, and nobody can remove a manager in the app (`CANNOT_REMOVE_MANAGER`: "Only the operator can remove a social manager."); the operator does it in the database. Whoever writes, the deferred database trigger `hosts_keep_one_manager_per_social` (`LAST_MANAGER`) refuses to leave a social that still has hosts without a manager; it checks at commit, and emptying a social entirely is allowed.

## First social (empty database)

While the `hosts` table is empty, nobody can sign in, and `/login` shows "No hosts yet" with this command. The operator (Ryan) creates every social and its first social manager the same way:

```sh
pnpm create-social --name "Your social" --manager-email you@example.com --manager-name "Your name"
```

It reads `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SECRET_KEY` from `.env.local`, creates (or reuses) the login, then creates the social and its manager in one transaction (`create_social_with_manager`, service_role only). It prints the social's id and its check-in link `/t/<tag>`, and warns if another social already has the same name. `pnpm create-social --help` shows all options.

- **Another manager for an existing social:** `pnpm create-social --social-id <uuid> --manager-email co@example.com --manager-name "Co Manager"`. If that login is already a host of the social, it is promoted to manager, and `--manager-name` can be left out (the existing display name is kept).
- **Safe to re-run:** a login that already manages the social is reported, not duplicated (`--manager-name` is optional then). A login that hosts a different social is refused: one login belongs to one social.
- **Hosted projects:** it refuses any non-local URL unless you pass `--production`. Run it with that project's URL and secret key in the environment and `--production`, and only with Ryan's OK.

For local development, `pnpm seed` already creates the social manager `host@example.test`.

## Local development

- Codes arrive in Mailpit at http://127.0.0.1:54324.
- `.env.local` needs `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` (from `pnpm exec supabase status`), plus `CHECKIN_IP_HMAC_SECRET` (`openssl rand -base64 32`), which the sign-in throttle needs too.
- The sign-in email template is `supabase/templates/magic_link.html`. It must show `{{ .Token }}`, because the default template only has a link. Template changes need `pnpm db:stop && pnpm db:start`.

## Production checklist (hosted Supabase project)

- Authentication > Sign In / Providers: turn email sign-ups off ("Allow new users to sign up" off). Email provider on.
- Authentication > Emails > Magic Link: paste `supabase/templates/magic_link.html` (subject "Your sign-in code").
- Email OTP length 6, expiry 600 s (matches `supabase/config.toml`).
- Set up custom SMTP: the built-in sender is heavily rate limited.
- Server env (never `NEXT_PUBLIC_`): `SUPABASE_SECRET_KEY` and `CHECKIN_IP_HMAC_SECRET`.
