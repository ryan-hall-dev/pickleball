-- Session-only participants: the membership system is removed.
-- Plan: docs/plans/session-only-participants.md (approved 2026-11-11), §2-§3.
--
-- Session participants become the only player records: a name and a level
-- per session, with no member directory, no phone-to-member links and no
-- cross-session identity. History is preserved: every session_participants
-- row keeps its id and its snapshotted name and level, so session_events,
-- matches and check-in requests are untouched.
--
-- This migration, in order:
--   1. no two participants of one session share a name (case, accents and
--      spacing ignored): asserted, then guaranteed by a unique index;
--   2. checkin_request_status loses `already_checked_in` (the type is
--      recreated; no row uses the value);
--   3. checkin_requests loses member_id; skill_level becomes required;
--   4. session_participants loses member_id and is_guest;
--   5. member_devices and members are dropped (with their policies,
--      triggers, indexes and grants);
--   6. functions: the member-only ones are dropped, the check-in and
--      attendance writers are rewritten around participants, and every write
--      path reports a name clash as NAME_ALREADY_IN_SESSION;
--   7. RLS: nothing new. The remaining tables keep their policies and
--      `authenticated` keeps SELECT only.
--
-- Error convention (20261107120100): 42501 not allowed, P0002 not found,
-- 22023 invalid input, P0001 refused by the current state.

-- ---------------------------------------------------------------------------
-- 1. One name per session
-- ---------------------------------------------------------------------------

-- private.normalise_name_for_search (20261111090000) is IMMUTABLE, as an
-- index expression requires.
do $$
begin
  if exists (
    select 1
    from public.session_participants
    group by session_id, private.normalise_name_for_search(first_name || ' ' || last_name)
    having count(*) > 1
  ) then
    raise exception 'A session has two participants with the same name; resolve them before this migration.';
  end if;
end;
$$;

create unique index session_participants_unique_name_per_session_idx
  on public.session_participants (session_id, private.normalise_name_for_search(first_name || ' ' || last_name));

-- An index expression runs with the privileges of the role writing the row
-- (it calls the function by oid, so no schema USAGE is involved). The
-- server's direct service_role writes to session_participants (dev seed,
-- test fixtures) therefore need EXECUTE on this one pure text function.
-- Nothing else in `private` is executable by service_role
-- (01_rls_and_grants.test.sql); anon and authenticated execute nothing new.
grant execute on function private.normalise_name_for_search(text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Request status without `already_checked_in`
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from public.checkin_requests where status::text = 'already_checked_in') then
    raise exception 'A check-in request has status already_checked_in; it cannot be migrated.';
  end if;
end;
$$;

alter type public.checkin_request_status rename to checkin_request_status_before_session_only;
create type public.checkin_request_status as enum ('pending', 'approved', 'rejected', 'withdrawn');

drop index public.checkin_requests_one_pending_per_device_idx;
alter table public.checkin_requests
  drop constraint checkin_requests_decided_when_final,
  drop constraint checkin_requests_approved_has_participant,
  alter column status drop default,
  alter column status type public.checkin_request_status using status::text::public.checkin_request_status,
  alter column status set default 'pending',
  -- Every status except `pending` and `withdrawn` is a decision with a time
  -- (approved, rejected). `withdrawn` keeps the decision time of the
  -- approval it replaced, if any.
  add constraint checkin_requests_decided_when_final check (
    status = 'withdrawn' or ((status = 'pending') = (decided_at is null))
  ),
  add constraint checkin_requests_approved_has_participant check (
    (status = 'approved') = (session_participant_id is not null)
  );
-- One pending request per phone per session (same-phone resubmissions).
create unique index checkin_requests_one_pending_per_device_idx
  on public.checkin_requests (session_id, device_token_hash)
  where status = 'pending';

drop type public.checkin_request_status_before_session_only;

-- ---------------------------------------------------------------------------
-- 3. Check-in requests: no member, level required
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from public.checkin_requests where skill_level is null) then
    raise exception 'A check-in request has no skill level; it cannot be migrated.';
  end if;
end;
$$;

alter table public.checkin_requests
  drop constraint checkin_requests_first_timer_has_skill,
  drop constraint checkin_requests_member_id_social_id_fkey,
  alter column skill_level set not null;
drop index public.checkin_requests_member_id_idx;
alter table public.checkin_requests drop column member_id;

-- ---------------------------------------------------------------------------
-- 4. Session participants: no member, no guest flag
-- ---------------------------------------------------------------------------

alter table public.session_participants
  drop constraint session_participants_one_row_per_member,
  drop constraint session_participants_member_unless_guest,
  drop constraint session_participants_member_id_social_id_fkey;
drop index public.session_participants_member_id_idx;
alter table public.session_participants
  drop column member_id,
  drop column is_guest;

-- ---------------------------------------------------------------------------
-- 5. The member directory and phone links
-- ---------------------------------------------------------------------------

-- Nothing else references them now (the two foreign keys above are gone), so
-- no cascade: their policies, triggers, indexes and grants go with them.
drop table public.member_devices;
drop table public.members;

-- ---------------------------------------------------------------------------
-- 6. Functions
-- ---------------------------------------------------------------------------

drop function public.search_checkin_names(text, text, text, text);
drop function public.close_checkin_already_checked_in(uuid, uuid);
drop function public.set_draft_member_attendance(uuid, uuid, uuid[], boolean);
drop function public.remove_draft_guest(uuid, uuid, uuid);
drop function public.add_draft_guest(uuid, uuid, uuid, text, text, public.skill_level);
drop function public.add_guest_mid_session(uuid, uuid, uuid, text, text, public.skill_level, uuid, integer, timestamptz);
drop function public.submit_checkin(text, text, text, text, text, public.skill_level, uuid);
-- Its return columns change.
drop function public.list_checkin_requests_for_open_session(uuid);

-- The PlayerJoined payload for a participant. Old events in the log still
-- carry `isGuest`; the engine ignores it.
create or replace function private.player_joined_payload(p_participant public.session_participants)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'participant', jsonb_build_object(
      'participantId', p_participant.id,
      'firstName', p_participant.first_name,
      'lastName', p_participant.last_name,
      'skill', p_participant.skill_level
    )
  );
$$;

-- Inserts a participant into a session the caller has already locked
-- (lock_social_session or lock_social_open_draft lock the session row, which
-- serialises every attendance write of the session). Names are normalised;
-- a level is required. A name already in the session (case, accents and
-- spacing ignored) is NAME_ALREADY_IN_SESSION; the unique index is the
-- backstop. The detail never repeats the name.
create function private.insert_session_participant(
  p_session_participant_id uuid,
  p_session_id uuid,
  p_social_id uuid,
  p_first_name text,
  p_last_name text,
  p_skill_level public.skill_level
)
returns public.session_participants
language plpgsql
set search_path = ''
as $$
declare
  v_first_name text := private.normalise_person_name(p_first_name);
  v_last_name text := private.normalise_person_name(p_last_name);
  v_participant public.session_participants;
  v_violated_constraint_name text;
begin
  if p_skill_level is null then
    raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'Choose a playing level.';
  end if;
  if exists (
    select 1 from public.session_participants
    where session_id = p_session_id
      and private.normalise_name_for_search(first_name || ' ' || last_name)
        = private.normalise_name_for_search(v_first_name || ' ' || v_last_name)
  ) then
    raise exception 'NAME_ALREADY_IN_SESSION' using errcode = 'P0001',
      detail = format('Someone with this name is already in session %s.', p_session_id);
  end if;

  begin
    insert into public.session_participants (id, session_id, social_id, first_name, last_name, skill_level)
    values (p_session_participant_id, p_session_id, p_social_id, v_first_name, v_last_name, p_skill_level)
    returning * into v_participant;
  exception when unique_violation then
    get stacked diagnostics v_violated_constraint_name = constraint_name;
    if v_violated_constraint_name = 'session_participants_unique_name_per_session_idx' then
      raise exception 'NAME_ALREADY_IN_SESSION' using errcode = 'P0001',
        detail = format('Someone with this name is already in session %s.', p_session_id);
    end if;
    raise;
  end;
  return v_participant;
end;
$$;

-- ---------------------------------------------------------------------------
-- Public check-in (called by the /t/<tag> server code with the secret key)
-- ---------------------------------------------------------------------------

-- Creates a pending check-in request for the host's tray. Name and level are
-- required. Only THIS phone's own requests in this session are consulted:
--   approved -> { status: 'already_checked_in' }
--   pending  -> { status: 'pending', checkin_request_id, was_already_pending: true }
--   otherwise (none, rejected or withdrawn) a new pending request:
--            -> { status: 'pending', checkin_request_id, was_already_pending: false }
-- Other participants' names are never looked up, so a phone can't learn
-- whether a name is attending.
create function public.submit_checkin(
  p_checkin_tag text,
  p_device_token_hash text,
  p_ip_hash text,
  p_first_name text,
  p_last_name text,
  p_skill_level public.skill_level
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.sessions;
  v_first_name text;
  v_last_name text;
  v_request_id uuid;
begin
  perform private.require_valid_client_identity(p_device_token_hash, p_ip_hash);
  v_first_name := private.normalise_person_name(p_first_name);
  v_last_name := private.normalise_person_name(p_last_name);
  if p_skill_level is null then
    raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'Choose a playing level.';
  end if;
  v_session := private.find_open_session_by_checkin_tag(p_checkin_tag);

  perform private.record_checkin_attempt('submit', v_session.id, p_device_token_hash, p_ip_hash, 10, 30, 300);

  if exists (
    select 1 from public.checkin_requests
    where session_id = v_session.id and device_token_hash = p_device_token_hash and status = 'approved'
  ) then
    return jsonb_build_object('status', 'already_checked_in');
  end if;

  select id into v_request_id
  from public.checkin_requests
  where session_id = v_session.id and device_token_hash = p_device_token_hash and status = 'pending';
  if found then
    return jsonb_build_object('status', 'pending', 'checkin_request_id', v_request_id, 'was_already_pending', true);
  end if;

  begin
    insert into public.checkin_requests (
      session_id, social_id, first_name, last_name, skill_level, device_token_hash, ip_hash
    )
    values (
      v_session.id, v_session.social_id, v_first_name, v_last_name, p_skill_level, p_device_token_hash, p_ip_hash
    )
    returning id into v_request_id;
  exception when unique_violation then
    -- A concurrent submit from the same phone won the race; report its request.
    select id into strict v_request_id
    from public.checkin_requests
    where session_id = v_session.id and device_token_hash = p_device_token_hash and status = 'pending';
    return jsonb_build_object('status', 'pending', 'checkin_request_id', v_request_id, 'was_already_pending', true);
  end;

  return jsonb_build_object('status', 'pending', 'checkin_request_id', v_request_id, 'was_already_pending', false);
end;
$$;

-- The public page's read, polled every 5 s (so not rate-limited). It returns
-- only what the page shows: the social's name, the open session's header and
-- this phone's latest request in the session. Never anyone else's data.
--   unknown or reissued tag -> { status: 'inactive' } (nothing else)
--   no open session with check-in open -> { status: 'no_open_session', social_name }
--   otherwise { status: 'open', social_name, session: { name, status,
--     planned_start, planned_end, courts_count, checked_in_count },
--     current_request: { id, status, first_name } | null, now }
-- A null device hash (no cookie yet) has no request.
create or replace function public.get_checkin_page(p_checkin_tag text, p_device_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_social public.socials;
  v_session public.sessions;
  v_current_request jsonb;
begin
  if p_device_token_hash is not null and p_device_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023',
      detail = 'Device token hash must be lowercase hex SHA-256.';
  end if;

  if p_checkin_tag is not null and p_checkin_tag ~ '^[a-z0-9_-]{16,64}$' then
    select * into v_social from public.socials where checkin_tag = p_checkin_tag;
  end if;
  if v_social.id is null then
    return jsonb_build_object('status', 'inactive');
  end if;

  -- At most one open session per social (sessions_one_open_per_social_idx).
  select * into v_session
  from public.sessions
  where social_id = v_social.id
    and status in ('draft', 'live')
    and checkin_open;
  if v_session.id is null then
    return jsonb_build_object('status', 'no_open_session', 'social_name', v_social.name);
  end if;

  if p_device_token_hash is not null then
    select jsonb_build_object(
      'id', request.id,
      'status', request.status,
      'first_name', request.first_name
    ) into v_current_request
    from public.checkin_requests as request
    where request.session_id = v_session.id
      and request.device_token_hash = p_device_token_hash
    order by request.created_at desc, request.id desc
    limit 1;
  end if;

  return jsonb_build_object(
    'status', 'open',
    'social_name', v_social.name,
    'session', jsonb_build_object(
      'name', v_session.name,
      'status', v_session.status,
      'planned_start', v_session.planned_start,
      'planned_end', v_session.planned_end,
      -- The draft's selected courts, or the courts enabled at the start
      -- (the SessionStarted config replaces the draft's snapshot).
      'courts_count', case
        when jsonb_typeof(v_session.config_snapshot -> 'courts') = 'array'
          then jsonb_array_length(v_session.config_snapshot -> 'courts')
        else 0
      end,
      'checked_in_count', (
        select count(*) from public.session_participants where session_id = v_session.id
      )
    ),
    'current_request', v_current_request,
    'now', now()
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Host entry points
-- ---------------------------------------------------------------------------

-- Approve: the participant is created from the request's name and level and
-- the request is marked approved, in one transaction. Lock order as every
-- other log write: the session, then the request; the session lock also
-- serialises this with other approvals and host adds, so two hosts can't add
-- the same name. A name already in the session is NAME_ALREADY_IN_SESSION
-- and the request stays pending (the host rejects it; the player re-submits
-- with a distinguishing name).
-- Results: { status: 'approved', session_participant_id, event }
--        | { status: 'already_approved', session_participant_id }.
create or replace function public.approve_checkin(
  p_actor_user_id uuid,
  p_checkin_request_id uuid,
  p_session_participant_id uuid,
  p_event_id uuid default null,
  p_expected_last_seq integer default null,
  p_occurred_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_session_id uuid;
  v_session public.sessions;
  v_request public.checkin_requests;
  v_participant public.session_participants;
  v_event_result jsonb;
begin
  select session_id into v_session_id
  from public.checkin_requests
  where id = p_checkin_request_id and social_id = v_social_id;
  if not found then
    raise exception 'CHECKIN_REQUEST_NOT_FOUND' using errcode = 'P0002',
      detail = format('No check-in request %s.', p_checkin_request_id);
  end if;
  -- Session first, the same lock order as every other log write.
  v_session := private.lock_social_session(v_social_id, v_session_id);
  select * into v_request from public.checkin_requests where id = p_checkin_request_id for update;

  if v_request.status = 'approved' then
    return jsonb_build_object(
      'status', 'already_approved',
      'session_participant_id', v_request.session_participant_id
    );
  end if;
  if v_request.status <> 'pending' then
    raise exception 'CHECKIN_REQUEST_NOT_PENDING' using errcode = 'P0001',
      detail = format('Check-in request %s is %s.', p_checkin_request_id, v_request.status);
  end if;
  if v_session.status in ('ended', 'cancelled') then
    raise exception 'SESSION_CLOSED' using errcode = 'P0001',
      detail = format('Session %s is %s.', v_session.id, v_session.status);
  end if;
  if v_session.status = 'live' and (p_event_id is null or p_expected_last_seq is null or p_occurred_at is null) then
    raise exception 'EVENT_REQUIRED' using errcode = '22023',
      detail = 'Approving into a live session needs event_id, expected_last_seq and occurred_at.';
  end if;
  if v_session.status = 'live' and exists (select 1 from public.session_events where event_id = p_event_id) then
    raise exception 'EVENT_ID_REUSED' using errcode = '22023',
      detail = format('event_id %s already belongs to a different action; generate a new one.', p_event_id);
  end if;

  v_participant := private.insert_session_participant(
    p_session_participant_id, v_session.id, v_social_id,
    v_request.first_name, v_request.last_name, v_request.skill_level
  );

  if v_session.status = 'live' then
    v_event_result := private.insert_session_event(
      v_session, p_event_id, p_expected_last_seq, 'PlayerJoined',
      private.player_joined_payload(v_participant), p_occurred_at, p_actor_user_id
    );
  end if;

  update public.checkin_requests
  set status = 'approved',
      decided_by = p_actor_user_id,
      decided_at = now(),
      session_participant_id = v_participant.id
  where id = p_checkin_request_id;

  return jsonb_build_object(
    'status', 'approved',
    'session_participant_id', v_participant.id,
    'event', v_event_result
  );
end;
$$;

-- The host tray: the PENDING requests of the actor's social's open (draft or
-- live) session, oldest first; empty when nothing is open.
-- is_name_already_in_session: someone with the request's name (case, accents
-- and spacing ignored) is already a participant; approving it would be
-- refused with NAME_ALREADY_IN_SESSION.
create function public.list_checkin_requests_for_open_session(p_actor_user_id uuid)
returns table (
  id uuid,
  created_at timestamptz,
  first_name text,
  last_name text,
  skill_level public.skill_level,
  is_name_already_in_session boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_social_id uuid := private.require_host_social(p_actor_user_id);
begin
  return query
    select
      request.id,
      request.created_at,
      request.first_name::text,
      request.last_name::text,
      request.skill_level,
      exists (
        select 1 from public.session_participants as participant
        where participant.session_id = request.session_id
          and private.normalise_name_for_search(participant.first_name || ' ' || participant.last_name)
            = private.normalise_name_for_search(request.first_name || ' ' || request.last_name)
      )
    from public.checkin_requests as request
    join public.sessions as open_session
      on open_session.id = request.session_id
      and open_session.social_id = v_social_id
      and open_session.status in ('draft', 'live')
    where request.social_id = v_social_id
      and request.status = 'pending'
    order by request.created_at, request.id;
end;
$$;

-- A host adds a player to one of the social's drafts. Name and level are
-- required; a name already in the session is NAME_ALREADY_IN_SESSION.
-- Idempotent on the caller's participant id: a retry with an id already in
-- this session returns it; an id of another session is PARTICIPANT_ID_TAKEN.
-- remove_draft_participant (unchanged) removes any participant.
create function public.add_draft_participant(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_session_participant_id uuid,
  p_first_name text,
  p_last_name text,
  p_skill_level public.skill_level
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_existing_session_id uuid;
begin
  perform private.lock_social_open_draft(v_social_id, p_session_id);
  if p_session_participant_id is null then
    raise exception 'INVALID_PARTICIPANT_ID' using errcode = '22023',
      detail = 'p_session_participant_id is required.';
  end if;

  select session_id into v_existing_session_id
  from public.session_participants
  where id = p_session_participant_id;
  if found then
    if v_existing_session_id = p_session_id then
      return p_session_participant_id;
    end if;
    raise exception 'PARTICIPANT_ID_TAKEN' using errcode = '23505',
      detail = format('Participant %s belongs to another session.', p_session_participant_id);
  end if;

  perform private.insert_session_participant(
    p_session_participant_id, p_session_id, v_social_id, p_first_name, p_last_name, p_skill_level
  );
  return p_session_participant_id;
end;
$$;

-- A host adds a player to the social's live session (M7): the participant
-- and its PlayerJoined event in one transaction. Same rules as
-- add_draft_participant; idempotent on p_event_id.
create function public.add_participant_mid_session(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_session_participant_id uuid,
  p_first_name text,
  p_last_name text,
  p_skill_level public.skill_level,
  p_event_id uuid,
  p_expected_last_seq integer,
  p_occurred_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_session public.sessions := private.lock_social_session(v_social_id, p_session_id);
  v_duplicate jsonb;
  v_participant public.session_participants;
  v_result jsonb;
begin
  v_duplicate := private.find_duplicate_session_event(p_session_id, p_event_id, 'PlayerJoined');
  if v_duplicate is not null then
    return v_duplicate || jsonb_build_object(
      'session_participant_id',
      (select payload #>> '{participant,participantId}' from public.session_events where event_id = p_event_id)
    );
  end if;

  if v_session.status <> 'live' then
    raise exception 'SESSION_NOT_LIVE' using errcode = 'P0001',
      detail = format('Session %s is %s.', p_session_id, v_session.status);
  end if;

  v_participant := private.insert_session_participant(
    p_session_participant_id, p_session_id, v_social_id, p_first_name, p_last_name, p_skill_level
  );

  v_result := private.insert_session_event(
    v_session, p_event_id, p_expected_last_seq, 'PlayerJoined',
    private.player_joined_payload(v_participant), p_occurred_at, p_actor_user_id
  );
  return v_result || jsonb_build_object('session_participant_id', v_participant.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants (restated so this file is the record). service_role only; anon and
-- authenticated execute none of these.
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema private from public;
revoke all on function private.player_joined_payload(public.session_participants) from public, anon, authenticated, service_role;
revoke all on function private.insert_session_participant(uuid, uuid, uuid, text, text, public.skill_level) from public, anon, authenticated, service_role;

revoke all on function public.submit_checkin(text, text, text, text, text, public.skill_level) from public, anon, authenticated;
revoke all on function public.get_checkin_page(text, text) from public, anon, authenticated;
revoke all on function public.approve_checkin(uuid, uuid, uuid, uuid, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.list_checkin_requests_for_open_session(uuid) from public, anon, authenticated;
revoke all on function public.add_draft_participant(uuid, uuid, uuid, text, text, public.skill_level) from public, anon, authenticated;
revoke all on function public.add_participant_mid_session(uuid, uuid, uuid, text, text, public.skill_level, uuid, integer, timestamptz) from public, anon, authenticated;

grant execute on function public.submit_checkin(text, text, text, text, text, public.skill_level) to service_role;
grant execute on function public.get_checkin_page(text, text) to service_role;
grant execute on function public.approve_checkin(uuid, uuid, uuid, uuid, integer, timestamptz) to service_role;
grant execute on function public.list_checkin_requests_for_open_session(uuid) to service_role;
grant execute on function public.add_draft_participant(uuid, uuid, uuid, text, text, public.skill_level) to service_role;
grant execute on function public.add_participant_mid_session(uuid, uuid, uuid, text, text, public.skill_level, uuid, integer, timestamptz) to service_role;
