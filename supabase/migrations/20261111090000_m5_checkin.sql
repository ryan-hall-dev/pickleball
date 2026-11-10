-- M5 increment 1: player check-in, database. Plan: docs/plans/m5-player-checkin.md
-- (decisions 2026-11-09 and 2026-11-10, increment 1). Designs: docs/designs/m5/.
--
-- This increment:
--   * a new request outcome `already_checked_in` (D-A): a host closed a
--     request for a member who is already attending. It is a decided status
--     (decided_by / decided_at set), not a rejection;
--   * submit_checkin answers `already_checked_in` only to the member's OWN
--     linked phone (member_devices in this social). Any other phone naming an
--     attending member gets an ordinary pending request, so nobody learns who
--     is checked in;
--   * search_checkin_names matches accent-insensitively on members.search_name;
--     the query is folded by private.normalise_name_for_search, the same
--     folding as the generated column;
--   * get_checkin_page: the public page's read (header, phone recognition,
--     this phone's current request). Not rate-limited: it is polled every 5 s
--     and reveals nothing beyond what the page shows to that phone;
--   * approve_checkin refuses a member who is already attending
--     (ALREADY_IN_SESSION) before touching the member, the phone or the
--     attendance. The old PARTICIPANT_ID_MISMATCH / reuse-participant path is gone;
--   * close_checkin_already_checked_in: the host closes such a request (D-A to
--     D-C): no member, phone or attendance change;
--   * list_checkin_requests_for_open_session: the host tray's read, with the
--     already-attending and possible-duplicate (D-D) flags;
--   * reissue_checkin_tag: a social manager replaces the social's check-in tag;
--     the old `/t/<tag>` link resolves to "inactive" at once.
--
-- Error convention (20261107120100): 42501 not allowed, P0002 not found,
-- 22023 invalid input, P0001 refused by the current state.
--
-- The new enum value can't be used as a literal by SQL that is planned in the
-- same transaction as ALTER TYPE ... ADD VALUE (migrations run in one), so the
-- check constraint below is written without it. PL/pgSQL bodies are planned at
-- call time, after this migration has committed, so they may name it.

-- ---------------------------------------------------------------------------
-- Request outcome: already checked in
-- ---------------------------------------------------------------------------

alter type public.checkin_request_status add value 'already_checked_in';

-- Every status except `pending` and `withdrawn` is a decision with a time
-- (approved, rejected, already_checked_in). `withdrawn` keeps the decision
-- time of the approval it replaced, if any.
alter table public.checkin_requests
  drop constraint checkin_requests_decided_when_final,
  add constraint checkin_requests_decided_when_final check (
    status = 'withdrawn' or ((status = 'pending') = (decided_at is null))
  );

-- ---------------------------------------------------------------------------
-- Name folding for search and duplicate checks
-- ---------------------------------------------------------------------------

-- Folds a name the same way as the generated members.search_name column
-- (20261109090000): lowercased, decomposed (NFD) with combining marks
-- removed, whitespace collapsed, then trimmed. 'Élodie  Durand' -> 'elodie durand'.
-- A full name is folded as first || ' ' || last.
create function private.normalise_name_for_search(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(regexp_replace(
    regexp_replace(normalize(lower(coalesce(p_text, '')), NFD), U&'[\0300-\036F]', '', 'g'),
    '\s+', ' ', 'g'
  ))
$$;

-- Check-in search now folds on search_name; the old lower(...) prefix indexes
-- served only the previous search and would just cost writes. No new index:
-- a social's directory is small (see 20261109090000).
drop index public.members_social_full_name_prefix_idx;
drop index public.members_social_last_name_prefix_idx;

-- ---------------------------------------------------------------------------
-- Public check-in (called by the /t/<tag> server code with the secret key)
-- ---------------------------------------------------------------------------

-- Directory search for "Not you? Find your name": active members of the
-- session's social whose full name, or last name, starts with the query,
-- ignoring case, accents and spacing. Nothing for fewer than 2 characters, at
-- most 5 results, names only.
create or replace function public.search_checkin_names(
  p_checkin_tag text,
  p_name_query text,
  p_device_token_hash text,
  p_ip_hash text
)
returns table (member_id uuid, first_name text, last_name text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  c_max_results constant integer := 5;
  v_session public.sessions;
  v_query text := private.normalise_name_for_search(p_name_query);
begin
  perform private.require_valid_client_identity(p_device_token_hash, p_ip_hash);
  v_session := private.find_open_session_by_checkin_tag(p_checkin_tag);

  if char_length(v_query) < 2 then
    return;
  end if;
  -- Letters (accents are already folded away), spaces, apostrophes, hyphens
  -- and dots only: also keeps LIKE wildcards and the escape character out.
  if char_length(v_query) > 50 or v_query !~ '^[[:alpha:] .''-]+$' then
    raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'Search with letters only.';
  end if;

  perform private.record_checkin_attempt('search', v_session.id, p_device_token_hash, p_ip_hash, 30, 120, 600);

  return query
    select member.id, member.first_name::text, member.last_name::text
    from public.members as member
    where member.social_id = v_session.social_id
      and member.is_active
      and (
        member.search_name like v_query || '%'
        or private.normalise_name_for_search(member.last_name) like v_query || '%'
      )
    order by member.first_name, member.last_name, member.id
    limit c_max_results;
end;
$$;

-- Creates a pending check-in request for the host's tray (unchanged apart from
-- the privacy rule). `already_checked_in` is answered only when THIS phone is
-- linked to the named member in this social and that member is attending;
-- any other phone gets a pending request (or its existing one), whoever is
-- attending. Results:
-- { status: 'pending', checkin_request_id, was_already_pending }
-- | { status: 'already_checked_in' } | { status: 'member_not_found' }.
create or replace function public.submit_checkin(
  p_checkin_tag text,
  p_device_token_hash text,
  p_ip_hash text,
  p_first_name text,
  p_last_name text,
  p_skill_level public.skill_level default null,
  p_member_id uuid default null
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
  if p_member_id is null and p_skill_level is null then
    raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'First-time players must choose a skill level.';
  end if;
  v_session := private.find_open_session_by_checkin_tag(p_checkin_tag);

  perform private.record_checkin_attempt('submit', v_session.id, p_device_token_hash, p_ip_hash, 10, 30, 300);

  if p_member_id is not null and not exists (
    select 1 from public.members where id = p_member_id and social_id = v_session.social_id and is_active
  ) then
    return jsonb_build_object('status', 'member_not_found');
  end if;

  if p_member_id is not null
    and exists (
      select 1 from public.member_devices
      where social_id = v_session.social_id
        and token_hash = p_device_token_hash
        and member_id = p_member_id
    )
    and exists (
      select 1 from public.session_participants
      where session_id = v_session.id and member_id = p_member_id
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
      session_id, social_id, member_id, first_name, last_name, skill_level, device_token_hash, ip_hash
    )
    values (
      v_session.id, v_session.social_id, p_member_id, v_first_name, v_last_name, p_skill_level,
      p_device_token_hash, p_ip_hash
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
-- only what the page shows: the social's name, the open session's header,
-- the member THIS phone is linked to in this social (if active), and this
-- phone's latest request in the session. Never anyone else's data.
--   unknown or reissued tag -> { status: 'inactive' } (nothing else)
--   no open session with check-in open -> { status: 'no_open_session', social_name }
--   otherwise { status: 'open', social_name, session: { name, status,
--     planned_start, planned_end, courts_count, checked_in_count },
--     recognised_member: { member_id, first_name, last_name, skill_level } | null,
--     current_request: { id, status, first_name, member_id } | null, now }
-- A null device hash (no cookie yet) recognises nothing and has no request.
create function public.get_checkin_page(p_checkin_tag text, p_device_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_social public.socials;
  v_session public.sessions;
  v_recognised_member jsonb;
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
      'member_id', member.id,
      'first_name', member.first_name,
      'last_name', member.last_name,
      'skill_level', member.skill_level
    ) into v_recognised_member
    from public.member_devices as device
    join public.members as member on member.id = device.member_id and member.social_id = device.social_id
    where device.social_id = v_social.id
      and device.token_hash = p_device_token_hash
      and member.is_active;

    select jsonb_build_object(
      'id', request.id,
      'status', request.status,
      'first_name', request.first_name,
      'member_id', request.member_id
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
    'recognised_member', v_recognised_member,
    'current_request', v_current_request,
    'now', now()
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Host entry points
-- ---------------------------------------------------------------------------

-- Approve: as before, except that a member who is already attending is
-- refused with ALREADY_IN_SESSION before the member, the phone or the
-- attendance is touched (the session lock serialises this with attendance
-- edits and other approvals). The participant is always new, with the
-- caller's `p_session_participant_id`.
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
  v_member_id uuid;
  v_member_skill_level public.skill_level;
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
      'member_id', v_request.member_id,
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
  if v_request.member_id is not null and exists (
    select 1 from public.session_participants
    where session_id = v_session.id and member_id = v_request.member_id
  ) then
    raise exception 'ALREADY_IN_SESSION' using errcode = 'P0001',
      detail = format('The member of check-in request %s is already attending.', p_checkin_request_id);
  end if;
  if v_session.status = 'live' and (p_event_id is null or p_expected_last_seq is null or p_occurred_at is null) then
    raise exception 'EVENT_REQUIRED' using errcode = '22023',
      detail = 'Approving into a live session needs event_id, expected_last_seq and occurred_at.';
  end if;
  if v_session.status = 'live' and exists (select 1 from public.session_events where event_id = p_event_id) then
    raise exception 'EVENT_ID_REUSED' using errcode = '22023',
      detail = format('event_id %s already belongs to a different action; generate a new one.', p_event_id);
  end if;

  if v_request.member_id is null then
    insert into public.members (social_id, first_name, last_name, skill_level, last_checked_in_at)
    values (v_social_id, v_request.first_name, v_request.last_name, v_request.skill_level, now())
    returning id, skill_level into v_member_id, v_member_skill_level;
  else
    update public.members
    set first_name = v_request.first_name,
        last_name = v_request.last_name,
        skill_level = coalesce(v_request.skill_level, skill_level),
        last_checked_in_at = now()
    where id = v_request.member_id
      and social_id = v_social_id
    returning id, skill_level into v_member_id, v_member_skill_level;
    if v_member_id is null then
      raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0002',
        detail = format('Check-in request %s names no member of this social.', p_checkin_request_id);
    end if;
  end if;

  insert into public.member_devices (social_id, token_hash, member_id)
  values (v_social_id, v_request.device_token_hash, v_member_id)
  on conflict (social_id, token_hash) do update set member_id = excluded.member_id, last_seen_at = now();

  insert into public.session_participants (
    id, session_id, social_id, member_id, is_guest, first_name, last_name, skill_level
  )
  values (
    p_session_participant_id, v_session.id, v_social_id, v_member_id, false,
    v_request.first_name, v_request.last_name, v_member_skill_level
  )
  returning * into v_participant;

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
      member_id = v_member_id,
      session_participant_id = v_participant.id
  where id = p_checkin_request_id;

  return jsonb_build_object(
    'status', 'approved',
    'member_id', v_member_id,
    'session_participant_id', v_participant.id,
    'event', v_event_result
  );
end;
$$;

-- Closes a pending request whose member is already attending (D-A to D-C).
-- Records the outcome `already_checked_in`; changes no member, phone link or
-- attendance. Same guard and lock order as approve (session, then request),
-- so it can't interleave with an approval of the same request.
-- Results: { status: 'closed' } | { status: 'already_closed' }.
create function public.close_checkin_already_checked_in(p_actor_user_id uuid, p_checkin_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_session_id uuid;
  v_request public.checkin_requests;
begin
  select session_id into v_session_id
  from public.checkin_requests
  where id = p_checkin_request_id and social_id = v_social_id;
  if not found then
    raise exception 'CHECKIN_REQUEST_NOT_FOUND' using errcode = 'P0002',
      detail = format('No check-in request %s.', p_checkin_request_id);
  end if;
  perform private.lock_social_session(v_social_id, v_session_id);
  select * into v_request from public.checkin_requests where id = p_checkin_request_id for update;

  if v_request.status = 'already_checked_in' then
    return jsonb_build_object('status', 'already_closed');
  end if;
  if v_request.status <> 'pending' then
    raise exception 'CHECKIN_REQUEST_NOT_PENDING' using errcode = 'P0001',
      detail = format('Check-in request %s is %s.', p_checkin_request_id, v_request.status);
  end if;
  if v_request.member_id is null or not exists (
    select 1 from public.session_participants
    where session_id = v_session_id and member_id = v_request.member_id
  ) then
    raise exception 'NOT_ALREADY_IN_SESSION' using errcode = 'P0001',
      detail = format('Check-in request %s names nobody who is attending; approve or reject it.', p_checkin_request_id);
  end if;

  update public.checkin_requests
  set status = 'already_checked_in', decided_by = p_actor_user_id, decided_at = now()
  where id = p_checkin_request_id;
  return jsonb_build_object('status', 'closed');
end;
$$;

-- The host tray: the PENDING requests of the actor's social's open (draft or
-- live) session, oldest first; empty when nothing is open.
--   saved_skill_level: the member's current level (null for a new player);
--   is_already_attending: the request's member is already a participant;
--   is_possible_duplicate (D-D): only for a new player (member_id null), whose
--     folded full name equals that of anyone attending this session, members
--     and host-added guests alike, by their name in this session. A hint for
--     the host, never acted on automatically.
create function public.list_checkin_requests_for_open_session(p_actor_user_id uuid)
returns table (
  id uuid,
  created_at timestamptz,
  member_id uuid,
  first_name text,
  last_name text,
  skill_level public.skill_level,
  saved_skill_level public.skill_level,
  is_already_attending boolean,
  is_possible_duplicate boolean
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
      request.member_id,
      request.first_name::text,
      request.last_name::text,
      request.skill_level,
      member.skill_level,
      request.member_id is not null and exists (
        select 1 from public.session_participants as participant
        where participant.session_id = request.session_id
          and participant.member_id = request.member_id
      ),
      request.member_id is null and exists (
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
    left join public.members as member
      on member.id = request.member_id and member.social_id = v_social_id
    where request.social_id = v_social_id
      and request.status = 'pending'
    order by request.created_at, request.id;
end;
$$;

-- A social manager replaces the social's check-in tag (UI: "Issue new link")
-- with a fresh value from the column default. The old tag stops resolving at
-- once (get_checkin_page answers `inactive`); requests already sent belong to
-- their session and are untouched. Returns the new tag.
create function public.reissue_checkin_tag(p_actor_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_checkin_tag text;
begin
  if not exists (
    select 1 from public.hosts where user_id = p_actor_user_id and role = 'manager'
  ) then
    raise exception 'NOT_A_MANAGER' using errcode = '42501', detail = 'Only the social manager can do this.';
  end if;
  update public.socials
  set checkin_tag = default
  where id = v_social_id
  returning checkin_tag into v_checkin_tag;
  return v_checkin_tag;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants (create or replace keeps grants; restated so this file is the record)
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema private from public;
revoke all on function private.normalise_name_for_search(text) from public, anon, authenticated, service_role;

revoke all on function public.search_checkin_names(text, text, text, text) from public, anon, authenticated;
revoke all on function public.submit_checkin(text, text, text, text, text, public.skill_level, uuid) from public, anon, authenticated;
revoke all on function public.get_checkin_page(text, text) from public, anon, authenticated;
revoke all on function public.approve_checkin(uuid, uuid, uuid, uuid, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.close_checkin_already_checked_in(uuid, uuid) from public, anon, authenticated;
revoke all on function public.list_checkin_requests_for_open_session(uuid) from public, anon, authenticated;
revoke all on function public.reissue_checkin_tag(uuid) from public, anon, authenticated;

grant execute on function public.search_checkin_names(text, text, text, text) to service_role;
grant execute on function public.submit_checkin(text, text, text, text, text, public.skill_level, uuid) to service_role;
grant execute on function public.get_checkin_page(text, text) to service_role;
grant execute on function public.approve_checkin(uuid, uuid, uuid, uuid, integer, timestamptz) to service_role;
grant execute on function public.close_checkin_already_checked_in(uuid, uuid) to service_role;
grant execute on function public.list_checkin_requests_for_open_session(uuid) to service_role;
grant execute on function public.reissue_checkin_tag(uuid) to service_role;
