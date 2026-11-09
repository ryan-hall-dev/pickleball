-- M4.5 increment A1: socials and hosts. Plan: docs/plans/socials.md §1-§2, §8 A1.
-- Decision: docs/decisions/0003-socials-and-data-isolation.md.
--
-- An installation holds several independent socials. One login belongs to
-- exactly one social (hosts.user_id stays the primary key), as `manager`
-- (Social Manager, was `admin`) or `host`.
--
-- This increment:
--   * creates `socials` (name, per-social check-in tag) and moves the tag off
--     `hosts` and the club name off `club_settings` (dropped);
--   * adds `hosts.social_id` (immutable), renames the enum value
--     `admin` -> `manager` and replaces the installation-wide last-admin
--     guard with a per-social, deferred last-manager guard;
--   * scopes RLS on `socials` and `hosts` to the caller's own social
--     (private.current_social_id());
--   * adds the operator function create_social_with_manager.
--
-- NOT yet scoped (A2 directory, A3 sessions): members, member_devices, courts,
-- saved_setups, sessions and everything under a session stay installation-wide
-- and keep their private.is_host() policies; the write functions keep using
-- private.require_host. Until A3, sessions still belong to a host, so a
-- social's check-in tag can match one open session per host of the social:
-- find_open_session_by_checkin_tag picks one deterministically.
--
-- Backfill: when data exists, one default social is created (named from
-- club_settings) and every host joins it; existing admins become managers.
-- On an empty database nothing is backfilled; the first social comes from
-- `pnpm create-social`. A2/A3 can find the default social as the oldest one
-- (`order by created_at, id limit 1`): it is created here, before any other.
-- Their backfills must raise instead of guessing when that is ambiguous (rows
-- to backfill while several socials exist, or none), since test and
-- operator-created socials can appear between increments.

-- ---------------------------------------------------------------------------
-- Socials
-- ---------------------------------------------------------------------------

create table public.socials (
  id uuid primary key default gen_random_uuid(),
  -- Not unique: the operator script warns on duplicates instead, so no error
  -- can ever reveal another social's name.
  name public.short_label not null,
  -- Unguessable slug in the social's sticker URL `/t/<tag>` (122 random bits).
  checkin_tag text not null unique default replace(gen_random_uuid()::text, '-', '')
    check (checkin_tag ~ '^[a-z0-9_-]{16,64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger socials_set_updated_at before update on public.socials
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Roles: admin -> manager. The old guard's body compares against the literal
-- 'admin', which fails once the value is renamed, so it goes first.
-- ---------------------------------------------------------------------------

drop trigger hosts_keep_one_admin on public.hosts;
drop function private.keep_one_admin();
alter type public.host_role rename value 'admin' to 'manager';

-- ---------------------------------------------------------------------------
-- hosts.social_id, with the backfill in between nullable and not null
-- ---------------------------------------------------------------------------

alter table public.hosts add column social_id uuid;

do $$
declare
  v_default_social_id uuid;
begin
  if exists (select 1 from public.hosts)
    or exists (select 1 from public.members)
    or exists (select 1 from public.courts)
    or exists (select 1 from public.saved_setups)
    or exists (select 1 from public.sessions) then
    insert into public.socials (name)
    values (coalesce((select club_name from public.club_settings), 'Pickleball Social'))
    returning id into v_default_social_id;

    -- Keep each host's real updated_at.
    alter table public.hosts disable trigger hosts_set_updated_at;
    update public.hosts set social_id = v_default_social_id;
    alter table public.hosts enable trigger hosts_set_updated_at;

    raise notice 'Default social % created; % host(s) joined it.',
      v_default_social_id, (select count(*) from public.hosts);
  end if;
end;
$$;

alter table public.hosts
  alter column social_id set not null,
  add constraint hosts_social_id_fkey foreign key (social_id) references public.socials (id) on delete restrict;
create index hosts_social_id_idx on public.hosts (social_id);

-- The sticker tag now belongs to the social.
alter table public.hosts drop column checkin_tag;

-- The club name now lives on the social.
drop table public.club_settings;

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

-- A row never moves to another social (A2/A3 attach this to their tables too).
create function private.reject_social_id_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'SOCIAL_ID_IMMUTABLE' using errcode = 'P0001',
    detail = format('%s rows never move to another social.', tg_table_name);
end;
$$;

create trigger hosts_reject_social_id_change
  before update of social_id on public.hosts
  for each row
  when (old.social_id is distinct from new.social_id)
  execute function private.reject_social_id_change();

-- A social that still has hosts keeps at least one manager. Checked once at
-- commit (deferred constraint trigger), so a statement that deletes a manager
-- and hosts together passes or fails on the final state, never on row order.
-- Emptying a social entirely is allowed (operator, test cleanup). Security
-- definer: it also runs when deleting an auth user cascades to `hosts`.
-- It only fires when the changed row was a manager: inserting hosts into a
-- social without a manager is allowed (the app can't do it: invites need a
-- manager, and create_social_with_manager inserts the manager first), and
-- removing a plain host from such a social is not refused.
create function private.keep_one_manager_per_social()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role <> 'manager' then
    return null;
  end if;
  -- Serialises concurrent demotions/removals within one social.
  perform 1 from public.socials where id = old.social_id for update;
  if exists (select 1 from public.hosts where social_id = old.social_id)
    and not exists (
      select 1 from public.hosts where social_id = old.social_id and role = 'manager'
    ) then
    raise exception 'LAST_MANAGER' using errcode = 'P0001',
      detail = 'A social with hosts needs at least one social manager.';
  end if;
  return null;
end;
$$;

create constraint trigger hosts_keep_one_manager_per_social
  after update of role or delete on public.hosts
  deferrable initially deferred
  for each row execute function private.keep_one_manager_per_social();

-- ---------------------------------------------------------------------------
-- Check-in: the sticker tag is the social's. Until A3 makes sessions belong
-- to the social, the open session is found through its host's social; with
-- several open sessions in one social, a live one wins, then the most
-- recently updated.
-- ---------------------------------------------------------------------------

create or replace function private.find_open_session_by_checkin_tag(p_checkin_tag text)
returns public.sessions
language plpgsql
stable
set search_path = ''
as $$
declare
  v_session public.sessions;
begin
  if p_checkin_tag is not null and p_checkin_tag ~ '^[a-z0-9_-]{16,64}$' then
    select open_session.* into v_session
    from public.sessions as open_session
    join public.hosts as host on host.user_id = open_session.host_id
    join public.socials as social on social.id = host.social_id
    where social.checkin_tag = p_checkin_tag
      and open_session.status in ('draft', 'live')
      and open_session.checkin_open
    order by (open_session.status = 'live') desc, open_session.updated_at desc, open_session.id
    limit 1;
  end if;
  if v_session.id is null then
    raise exception 'NO_OPEN_SESSION' using errcode = 'P0002', detail = 'No social is open here right now.';
  end if;
  return v_session;
end;
$$;

-- ---------------------------------------------------------------------------
-- Operator: a new social and its first manager, in one transaction. The
-- `pnpm create-social` script calls it with the secret key.
-- ---------------------------------------------------------------------------

create function public.create_social_with_manager(
  p_name text,
  p_manager_user_id uuid,
  p_manager_display_name text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_social_id uuid;
begin
  insert into public.socials (name) values (p_name) returning id into v_social_id;
  -- A user who is already a host anywhere fails here (23505): one login, one social.
  insert into public.hosts (user_id, display_name, role, social_id)
  values (p_manager_user_id, p_manager_display_name, 'manager', v_social_id);
  return v_social_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS: a host reads only their own social and its hosts
-- ---------------------------------------------------------------------------

-- The caller's social; null for anyone not on the hosts list, so policies
-- comparing against it match nothing.
create function private.current_social_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select social_id from public.hosts where user_id = (select auth.uid());
$$;

alter table public.socials enable row level security;

create policy socials_select_own_social on public.socials
  for select to authenticated using (id = (select private.current_social_id()));

drop policy hosts_select_hosts on public.hosts;
create policy hosts_select_own_social on public.hosts
  for select to authenticated using (social_id = (select private.current_social_id()));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on public.socials from anon, authenticated;
grant select on public.socials to authenticated;

revoke execute on all functions in schema private from public;
-- private.is_host() stays for the tables A2/A3 haven't scoped yet.
grant execute on function private.current_social_id() to authenticated;
revoke all on function public.create_social_with_manager(text, uuid, text) from public, anon, authenticated;
grant execute on function public.create_social_with_manager(text, uuid, text) to service_role;
