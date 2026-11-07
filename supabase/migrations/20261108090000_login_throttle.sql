-- App-level throttle for host sign-in (docs/auth.md).
--
-- Supabase Auth rate-limits per IP, but every request comes from the Next.js
-- server, so its limits act as one global counter: one attacker could lock
-- every host out. The server calls record_login_attempt (service_role only)
-- before asking Supabase to send or check a code, keyed on the hashed client
-- IP and the hashed email. Only hashes are stored; rows are pruned after a day.

create table public.login_attempts (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('request_code', 'verify_code')),
  -- HMAC-SHA256 of the client IP (hashClientIp).
  ip_hash public.sha256_hex not null,
  -- SHA-256 of the normalised (trimmed, lowercased) email.
  email_hash public.sha256_hex not null,
  created_at timestamptz not null default now()
);
create index login_attempts_ip_recent_idx on public.login_attempts (ip_hash, created_at);
create index login_attempts_email_recent_idx on public.login_attempts (email_hash, kind, created_at);
create index login_attempts_created_at_idx on public.login_attempts (created_at);

-- Nobody reads or writes the table directly; only the function below does.
alter table public.login_attempts enable row level security;
revoke all on public.login_attempts from anon, authenticated, service_role;

-- Returns true and records the attempt when it is within the limits; returns
-- false (recording nothing) when the caller must wait. Limits per 10 minutes:
-- 20 attempts of any kind per IP, 5 code requests and 10 code checks per email.
create function public.record_login_attempt(
  p_kind text,
  p_ip_hash text,
  p_email_hash text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_since timestamptz := now() - interval '10 minutes';
  v_max_per_email integer;
begin
  if p_kind = 'request_code' then
    v_max_per_email := 5;
  elsif p_kind = 'verify_code' then
    v_max_per_email := 10;
  else
    raise exception 'INVALID_LOGIN_ATTEMPT_KIND' using errcode = '22023',
      detail = format('Unknown login attempt kind %L; use request_code or verify_code.', p_kind);
  end if;
  -- Domain checks (sha256_hex) reject malformed hashes.
  perform p_ip_hash::public.sha256_hex, p_email_hash::public.sha256_hex;

  -- Serialise attempts for one email so parallel requests can't overshoot its limit.
  perform pg_advisory_xact_lock(hashtextextended('login_attempts:' || p_email_hash, 0));

  if (select count(*) from public.login_attempts
      where ip_hash = p_ip_hash and created_at > v_since) >= 20
     or (select count(*) from public.login_attempts
         where email_hash = p_email_hash and kind = p_kind and created_at > v_since) >= v_max_per_email then
    return false;
  end if;

  insert into public.login_attempts (kind, ip_hash, email_hash)
  values (p_kind, p_ip_hash, p_email_hash);
  -- Attempts are only needed for the window; prune old ones as we go.
  delete from public.login_attempts where created_at < now() - interval '1 day';
  return true;
end;
$$;

revoke all on function public.record_login_attempt(text, text, text) from public, anon, authenticated;
grant execute on function public.record_login_attempt(text, text, text) to service_role;
