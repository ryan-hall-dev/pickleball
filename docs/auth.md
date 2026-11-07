# Host authentication

Hosts sign in with an emailed 6-digit code (Supabase email OTP). Players never sign in: `/t/<tag>` is public and isn't touched by the auth proxy.

## How it works

- **Login** (`/login`): enter email, get a code, enter it. The server actions in `src/server/auth/loginActions.ts` call `signInWithOtp` / `verifyOtp` through `@supabase/ssr`, which sets the session cookie.
- **No sign-ups from the login form.** `shouldCreateUser: false`, plus `enable_signup = false` in `supabase/config.toml`. Logins are created only when an admin invites someone, or by `pnpm create-admin`. An email that isn't invited gets the same "if this email is on the hosts list, a code is on its way" screen, and no email is sent, so the form can't be used to find out who the hosts are.
- **Throttle.** Supabase's own per-IP limits only ever see the Next.js server's IP, so they act as one global counter, and one attacker could lock every host out. So before asking Supabase to send or check a code, the server calls `record_login_attempt` (service_role only; migration `20261108090000_login_throttle.sql`). Limits per 10 minutes: 20 attempts per client IP, 5 code requests and 10 code checks per email. Refused attempts aren't recorded, and rows older than a day are pruned. Only hashes are stored: an HMAC of the IP (`hashClientIp`, keyed with `CHECKIN_IP_HMAC_SECRET`) and a SHA-256 of the email. Invited and uninvited emails get the same answers, and Supabase's per-email send limit (which only fires for existing users) is also shown as "code sent".
- **Client IP.** The client IP is the first `x-forwarded-for` entry, set by the host platform. Vercel overwrites whatever the client sends. A bare `next start` with no proxy in front keeps a client-supplied value, so self-hosting needs a proxy that sets the header. The per-email limits still apply either way.
- **Allow-list.** Signing in isn't enough. The host area (`src/app/(host)/layout.tsx`) checks the `hosts` table with a verified `getUser()`. A signed-in user without a hosts row sees "You're not a host here. Ask an admin for an invite." and can sign out.
- **Session refresh.** `src/proxy.ts` refreshes the Supabase session on every request and sends signed-out visitors to `/login`. That's only an optimistic check: pages and every server action check access again on the server.
- **Invites** (`/hosts`, admins only). The admin enters an email and a display name. The server confirms the caller is an admin, then uses the service-role client (`SUPABASE_SECRET_KEY`, server only) to create a confirmed, passwordless login (or reuse an existing one) and add a `hosts` row with role `host`. The database default generates the `checkin_tag` (122 random bits). No invite email is sent: tell the new host to sign in at `/login` with that email.
- **Removing hosts** (admins only). The `hosts` row is deleted first, which revokes access straight away (RLS), and then the login itself. Admins can't remove themselves, and the last admin can't be removed: the server checks this, and the database trigger `hosts_keep_one_admin` (`LAST_ADMIN`) is the final guard.

## First admin (empty database)

While the `hosts` table is empty, nobody can sign in, and `/login` shows "No hosts yet" with this command:

```sh
pnpm create-admin --email you@example.com --name "Your name"
```

It reads `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SECRET_KEY` from `.env.local`, creates (or reuses) the login and upserts an admin `hosts` row. You can safely run it again. It refuses any non-local URL unless you pass `--production`. For a hosted project, run it once with that project's URL and secret key in the environment and `--production`, and only with Ryan's OK.

For local development, `pnpm seed` already creates the admin `host@example.test`.

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
