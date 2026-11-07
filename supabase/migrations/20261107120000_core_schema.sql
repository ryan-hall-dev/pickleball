-- Core schema: tables, constraints, indexes, row-level security and grants.
-- Plan: docs/plans/session-manager-mvp.md §3-§4.
--
-- Access model (docs/decisions/0002-server-only-writes.md):
--   * Reads: only users in `hosts`, with their own session (RLS via private.is_host()).
--   * Writes: ONLY server code with the secret key (service_role), after it has
--     verified the signed-in user. `authenticated` and `anon` have no write
--     grants and can't execute any public function.
--   * The session log, matches and check-in decisions are written only by the
--     security-definer functions in the next migrations, which take the acting
--     host's id and check it against `hosts`.

-- Nothing created by these migrations is reachable by default: every grant below is explicit.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated;

-- Helpers live in a schema the Data API doesn't expose.
create schema private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type public.host_role as enum ('admin', 'host');
create type public.skill_level as enum ('beginner', 'intermediate', 'advanced');
create type public.court_format as enum ('doubles', 'singles');
-- `cancelled`: a draft the host abandoned (cancel_draft_session); it never had a log.
create type public.session_status as enum ('draft', 'live', 'ended', 'cancelled');
create type public.checkin_attempt_kind as enum ('search', 'submit');
create type public.checkin_request_status as enum ('pending', 'approved', 'rejected', 'withdrawn');
create type public.match_row_status as enum ('completed', 'abandoned', 'reverted');

-- Mirrors SessionEventType in src/engine/session/events.ts. src/server checks
-- at compile time that the generated enum and the engine union are identical.
create type public.session_event_type as enum (
  'SessionStarted',
  'PlayerJoined',
  'PlayerJoinReverted',
  'PlayerLeft',
  'PlayerLeaveReverted',
  'PlayerSkipped',
  'PlayerUnskipped',
  'PlayerLocked',
  'PlayerUnlocked',
  'CourtAdded',
  'CourtAddReverted',
  'CourtClosed',
  'CourtReopened',
  'MatchStarted',
  'MatchStartReverted',
  'MatchCompleted',
  'MatchCompletionReverted',
  'PlayerReplaced',
  'PlayerReplacementReverted',
  'PlayerRemovedMidMatch',
  'PlayerRemovalReverted',
  'MatchAbandoned',
  'MatchAbandonReverted',
  'QueueReordered',
  'SuggestionsShuffled',
  'Paused',
  'Resumed',
  'SessionEnded'
);

-- A trimmed, non-empty person name with no control characters.
create domain public.person_name as text
  check (value = btrim(value) and char_length(value) between 1 and 50 and value !~ '[[:cntrl:]]');

-- A short trimmed label (club, court, session and setup names).
create domain public.short_label as text
  check (value = btrim(value) and char_length(value) between 1 and 80 and value !~ '[[:cntrl:]]');

-- Lowercase hex SHA-256 (device tokens and IP addresses are only ever stored hashed).
create domain public.sha256_hex as text
  check (value ~ '^[0-9a-f]{64}$');

-- ---------------------------------------------------------------------------
-- Shared trigger
-- ---------------------------------------------------------------------------

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.club_settings (
  -- Single-row table: the only allowed key is `true`.
  id boolean primary key default true check (id),
  club_name public.short_label not null,
  updated_at timestamptz not null default now()
);

create table public.hosts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name public.short_label not null,
  role public.host_role not null default 'host',
  -- Unguessable slug in the host's sticker URL `/t/<tag>` (122 random bits).
  checkin_tag text not null unique default replace(gen_random_uuid()::text, '-', '')
    check (checkin_tag ~ '^[a-z0-9_-]{16,64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.members (
  id uuid primary key default gen_random_uuid(),
  first_name public.person_name not null,
  last_name public.person_name not null,
  -- Null when unknown (e.g. added by a host without a level).
  skill_level public.skill_level,
  avatar_url text check (avatar_url ~ '^https://' and char_length(avatar_url) <= 2048),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_checked_in_at timestamptz
);

-- Prefix search for the check-in page and the directory (lower(...) LIKE 'abc%').
create index members_full_name_prefix_idx
  on public.members (lower(first_name || ' ' || last_name) text_pattern_ops)
  where is_active;
create index members_last_name_prefix_idx
  on public.members (lower(last_name) text_pattern_ops)
  where is_active;

create table public.member_devices (
  -- SHA-256 of the random device token in the player's cookie; the raw token is never stored.
  token_hash public.sha256_hex primary key,
  member_id uuid not null references public.members (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index member_devices_member_id_idx on public.member_devices (member_id);

create table public.courts (
  id uuid primary key default gen_random_uuid(),
  name public.short_label not null unique,
  is_active boolean not null default true,
  supported_formats public.court_format[] not null default '{doubles,singles}'
    check (
      cardinality(supported_formats) between 1 and 2
      and array_position(supported_formats, null) is null
      and (cardinality(supported_formats) = 1 or supported_formats[1] <> supported_formats[2])
    ),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.saved_setups (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.hosts (user_id) on delete cascade,
  name public.short_label not null,
  config jsonb not null check (jsonb_typeof(config) = 'object'),
  last_used_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- "Reuse last" = this host's most recent setup.
create index saved_setups_host_recent_idx on public.saved_setups (host_id, last_used_at desc);

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  -- Whose sticker opens this session's check-in. Null once that host is removed;
  -- `host_name` keeps the history readable.
  host_id uuid references public.hosts (user_id) on delete set null,
  name public.short_label not null,
  location text check (location = btrim(location) and char_length(location) <= 120),
  host_name public.short_label not null,
  planned_start timestamptz not null,
  planned_end timestamptz not null,
  status public.session_status not null default 'draft',
  checkin_open boolean not null default true,
  -- Setup draft while `draft`; replaced by the SessionStarted config at start.
  config_snapshot jsonb check (config_snapshot is null or jsonb_typeof(config_snapshot) = 'object'),
  started_at timestamptz,
  ended_at timestamptz,
  -- Seq of the newest session_events row (0 = no events).
  last_seq integer not null default 0 check (last_seq >= 0),
  final_stats jsonb check (final_stats is null or jsonb_typeof(final_stats) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sessions_planned_end_after_start check (planned_end > planned_start),
  constraint sessions_draft_has_no_log check (
    status not in ('draft', 'cancelled') or (started_at is null and ended_at is null and last_seq = 0)
  ),
  constraint sessions_live_has_started check (
    status <> 'live' or (started_at is not null and ended_at is null)
  ),
  constraint sessions_ended_has_times check (
    status <> 'ended' or (started_at is not null and ended_at is not null and ended_at >= started_at)
  )
);
-- One open (draft or live) session per host, so `/t/<tag>` is never ambiguous.
create unique index sessions_one_open_per_host_idx
  on public.sessions (host_id)
  where status in ('draft', 'live');
create index sessions_status_planned_start_idx on public.sessions (status, planned_start desc);

create table public.session_participants (
  -- Session-level player id (the engine's ParticipantId).
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id),
  member_id uuid references public.members (id),
  is_guest boolean not null default false,
  first_name public.person_name not null,
  last_name public.person_name not null,
  skill_level public.skill_level,
  created_at timestamptz not null default now(),
  constraint session_participants_one_row_per_member unique (session_id, member_id),
  -- A guest may later be registered (linked to a member); a non-guest always is.
  constraint session_participants_member_unless_guest check (is_guest or member_id is not null)
);
create index session_participants_member_id_idx on public.session_participants (member_id);

create table public.session_events (
  session_id uuid not null references public.sessions (id),
  seq integer not null check (seq >= 1),
  -- Client-generated idempotency key.
  event_id uuid not null unique,
  type public.session_event_type not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  -- Server time the engine validated the event with (the event's `at`).
  occurred_at timestamptz not null,
  -- Audit id; no foreign key so the log outlives removed users and is never rewritten.
  actor_user_id uuid not null,
  recorded_at timestamptz not null default now(),
  primary key (session_id, seq)
);

create table public.matches (
  -- The engine's MatchId (client-generated when the match starts).
  id uuid primary key,
  session_id uuid not null references public.sessions (id),
  -- Snapshot from the session config; no foreign key, like court_name.
  court_id uuid not null,
  court_name text not null,
  -- session_participants ids; a short-handed match can leave one team empty.
  team_a uuid[] not null,
  team_b uuid[] not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  duration_seconds integer not null check (duration_seconds >= 0),
  status public.match_row_status not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint matches_team_sizes check (
    cardinality(team_a) <= 2
    and cardinality(team_b) <= 2
    and cardinality(team_a) + cardinality(team_b) >= 1
  ),
  constraint matches_ended_unless_reverted check (status = 'reverted' or ended_at is not null),
  constraint matches_ended_after_started check (ended_at is null or ended_at >= started_at)
);
create index matches_session_started_idx on public.matches (session_id, started_at);

create table public.checkin_requests (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id),
  -- Null for a first-timer until the host approves (approval creates the member).
  member_id uuid references public.members (id),
  first_name public.person_name not null,
  last_name public.person_name not null,
  skill_level public.skill_level,
  status public.checkin_request_status not null default 'pending',
  device_token_hash public.sha256_hex not null,
  -- Hashed by the server before it reaches the database; used only for rate limits.
  ip_hash public.sha256_hex not null,
  created_at timestamptz not null default now(),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  -- The participant an approval created or reused; cleared when the host
  -- removes that participant from a draft (the request becomes `withdrawn`).
  session_participant_id uuid references public.session_participants (id),
  constraint checkin_requests_first_timer_has_skill check (member_id is not null or skill_level is not null),
  -- `withdrawn` keeps the decision time of the approval it replaced, if any.
  constraint checkin_requests_decided_when_final check (
    (status = 'pending' and decided_at is null)
    or (status in ('approved', 'rejected') and decided_at is not null)
    or status = 'withdrawn'
  ),
  constraint checkin_requests_approved_has_participant check (
    (status = 'approved') = (session_participant_id is not null)
  )
);
-- One pending request per phone per session.
create unique index checkin_requests_one_pending_per_device_idx
  on public.checkin_requests (session_id, device_token_hash)
  where status = 'pending';
create index checkin_requests_session_status_idx on public.checkin_requests (session_id, status, created_at);
create index checkin_requests_device_recent_idx on public.checkin_requests (device_token_hash, created_at);
create index checkin_requests_ip_recent_idx on public.checkin_requests (ip_hash, created_at);
create index checkin_requests_member_id_idx on public.checkin_requests (member_id);

-- Every public search and submit, kept for a day so the check-in functions can
-- rate-limit all attempts (including ones that return early without a request).
create table public.checkin_attempts (
  id bigint generated always as identity primary key,
  kind public.checkin_attempt_kind not null,
  session_id uuid not null references public.sessions (id),
  device_token_hash public.sha256_hex not null,
  ip_hash public.sha256_hex not null,
  created_at timestamptz not null default now()
);
create index checkin_attempts_device_recent_idx on public.checkin_attempts (kind, device_token_hash, created_at);
create index checkin_attempts_ip_recent_idx on public.checkin_attempts (kind, ip_hash, created_at);
create index checkin_attempts_session_recent_idx on public.checkin_attempts (kind, session_id, created_at);
create index checkin_attempts_created_at_idx on public.checkin_attempts (created_at);

-- updated_at maintenance
create trigger club_settings_set_updated_at before update on public.club_settings
  for each row execute function private.set_updated_at();
create trigger hosts_set_updated_at before update on public.hosts
  for each row execute function private.set_updated_at();
create trigger members_set_updated_at before update on public.members
  for each row execute function private.set_updated_at();
create trigger courts_set_updated_at before update on public.courts
  for each row execute function private.set_updated_at();
create trigger saved_setups_set_updated_at before update on public.saved_setups
  for each row execute function private.set_updated_at();
create trigger sessions_set_updated_at before update on public.sessions
  for each row execute function private.set_updated_at();
create trigger matches_set_updated_at before update on public.matches
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Integrity triggers. Writes come from trusted server code, but these rules
-- must hold whoever writes (grants don't bind the table owner or service_role).
-- ---------------------------------------------------------------------------

-- The session log is append-only.
create function private.reject_session_event_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'SESSION_EVENTS_APPEND_ONLY'
    using errcode = '42501',
          detail = 'session_events rows are never updated or deleted; undo appends a compensating event.';
end;
$$;

create trigger session_events_block_update_delete
  before update or delete on public.session_events
  for each row execute function private.reject_session_event_change();
create trigger session_events_block_truncate
  before truncate on public.session_events
  for each statement execute function private.reject_session_event_change();

-- The config snapshot is the setup draft until the start; after that it is
-- history (the SessionStarted event's config) and never changes.
create function private.reject_config_snapshot_change_after_draft()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.config_snapshot is distinct from old.config_snapshot and old.status <> 'draft' then
    raise exception 'CONFIG_SNAPSHOT_LOCKED' using errcode = 'P0001',
      detail = format('Session %s is %s; its config snapshot can only change while it is a draft.', old.id, old.status);
  end if;
  return new;
end;
$$;

create trigger sessions_lock_config_snapshot
  before update on public.sessions
  for each row execute function private.reject_config_snapshot_change_after_draft();

-- Once a session has started, its participants are referenced by the log.
create function private.reject_participant_delete_after_draft()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status public.session_status;
begin
  select status into v_status from public.sessions where id = old.session_id;
  if v_status <> 'draft' then
    raise exception 'SESSION_NOT_DRAFT' using errcode = 'P0001',
      detail = format('Participants can only be removed from a draft; session %s is %s.', old.session_id, v_status);
  end if;
  return old;
end;
$$;

create trigger session_participants_delete_only_in_draft
  before delete on public.session_participants
  for each row execute function private.reject_participant_delete_after_draft();

-- The club always keeps at least one admin (also when an admin's auth user is deleted).
create function private.keep_one_admin()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.role <> 'admin' or (tg_op = 'UPDATE' and new.role = 'admin') then
    return coalesce(new, old);
  end if;
  -- Lock every admin row so two concurrent demotions can't both pass the check.
  perform 1 from public.hosts where role = 'admin' for update;
  if not exists (select 1 from public.hosts where role = 'admin' and user_id <> old.user_id) then
    raise exception 'LAST_ADMIN' using errcode = 'P0001',
      detail = 'The club needs at least one admin; make another host an admin first.';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger hosts_keep_one_admin
  before update of role or delete on public.hosts
  for each row execute function private.keep_one_admin();

-- ---------------------------------------------------------------------------
-- Authorisation helper for RLS
-- ---------------------------------------------------------------------------

create function private.is_host()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.hosts where user_id = (select auth.uid()));
$$;

-- ---------------------------------------------------------------------------
-- Row-level security: hosts read with their own session; nobody writes through it.
-- member_devices and checkin_attempts have no read policy at all.
-- ---------------------------------------------------------------------------

alter table public.club_settings enable row level security;
alter table public.hosts enable row level security;
alter table public.members enable row level security;
alter table public.member_devices enable row level security;
alter table public.courts enable row level security;
alter table public.saved_setups enable row level security;
alter table public.sessions enable row level security;
alter table public.session_participants enable row level security;
alter table public.session_events enable row level security;
alter table public.matches enable row level security;
alter table public.checkin_requests enable row level security;
alter table public.checkin_attempts enable row level security;

create policy club_settings_select_hosts on public.club_settings
  for select to authenticated using ((select private.is_host()));
create policy hosts_select_hosts on public.hosts
  for select to authenticated using ((select private.is_host()));
create policy members_select_hosts on public.members
  for select to authenticated using ((select private.is_host()));
create policy courts_select_hosts on public.courts
  for select to authenticated using ((select private.is_host()));
create policy saved_setups_select_hosts on public.saved_setups
  for select to authenticated using ((select private.is_host()));
create policy sessions_select_hosts on public.sessions
  for select to authenticated using ((select private.is_host()));
create policy session_participants_select_hosts on public.session_participants
  for select to authenticated using ((select private.is_host()));
create policy session_events_select_hosts on public.session_events
  for select to authenticated using ((select private.is_host()));
create policy matches_select_hosts on public.matches
  for select to authenticated using ((select private.is_host()));
create policy checkin_requests_select_hosts on public.checkin_requests
  for select to authenticated using ((select private.is_host()));

-- ---------------------------------------------------------------------------
-- Grants (Supabase's defaults grant everything to anon/authenticated; start from nothing)
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
-- Even the secret key can't write the log directly: only the functions (run as owner) append.
revoke insert, update, delete, truncate on public.session_events from service_role;

grant select on
  public.club_settings,
  public.hosts,
  public.members,
  public.courts,
  public.saved_setups,
  public.sessions,
  public.session_participants,
  public.session_events,
  public.matches,
  public.checkin_requests
to authenticated;

revoke execute on all functions in schema private from public;
grant execute on function private.is_host() to authenticated;
