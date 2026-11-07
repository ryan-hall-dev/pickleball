-- NFC/QR check-in. Plan §4.1.
--
-- Public check-in: search_checkin_names and submit_checkin serve the public
-- `/t/<tag>` page, but only service_role can execute them: the page's server
-- code calls them with the secret key (docs/decisions/0002-server-only-writes.md).
-- It passes the SHA-256 of the device token from the player's cookie and an
-- HMAC-SHA256 of the client IP (src/server/checkin/clientIdentity.ts), so raw
-- tokens and IP addresses never reach the database.
--
-- Both functions need an open session for the sticker's tag, validate every
-- field, rate-limit every attempt per device, per IP and per session, and
-- reveal nothing beyond member names. The host's approval is the final gate
-- (approve_checkin / reject_checkin).

-- The rolling window for all check-in rate limits.
create function private.checkin_rate_window()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '10 minutes' $$;

-- Raises INVALID_INPUT unless both client identity hashes are lowercase hex SHA-256.
create function private.require_valid_client_identity(p_device_token_hash text, p_ip_hash text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_device_token_hash is null or p_device_token_hash !~ '^[0-9a-f]{64}$'
    or p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023',
      detail = 'Device token hash and IP hash must be lowercase hex SHA-256.';
  end if;
end;
$$;

-- The open (draft or live, check-in open) session behind a sticker tag. An
-- unknown tag and a host with nothing open give the same error, so the tag
-- space can't be probed.
create function private.find_open_session_by_checkin_tag(p_checkin_tag text)
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
    where host.checkin_tag = p_checkin_tag
      and open_session.status in ('draft', 'live')
      and open_session.checkin_open;
  end if;
  if v_session.id is null then
    raise exception 'NO_OPEN_SESSION' using errcode = 'P0002', detail = 'No social is open with this host right now.';
  end if;
  return v_session;
end;
$$;

-- Raises RATE_LIMITED if this device, IP or session has used up its attempts of
-- `p_kind` in the window; otherwise records the attempt (and prunes old ones).
-- Callers record the attempt BEFORE any early return, so every outcome counts.
-- Count-then-insert isn't serialised: a burst of concurrent calls can overshoot
-- a limit by the number in flight. Accepted: the limits damp abuse, and host
-- approval is the real gate.
create function private.record_checkin_attempt(
  p_kind public.checkin_attempt_kind,
  p_session_id uuid,
  p_device_token_hash text,
  p_ip_hash text,
  p_max_per_device integer,
  p_max_per_ip integer,
  p_max_per_session integer
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_since timestamptz := now() - private.checkin_rate_window();
  v_scope text;
begin
  if (select count(*) from public.checkin_attempts
      where kind = p_kind and device_token_hash = p_device_token_hash and created_at > v_since) >= p_max_per_device then
    v_scope := 'device';
  elsif (select count(*) from public.checkin_attempts
         where kind = p_kind and ip_hash = p_ip_hash and created_at > v_since) >= p_max_per_ip then
    v_scope := 'network';
  elsif (select count(*) from public.checkin_attempts
         where kind = p_kind and session_id = p_session_id and created_at > v_since) >= p_max_per_session then
    v_scope := 'session';
  end if;
  if v_scope is not null then
    raise exception 'RATE_LIMITED' using errcode = 'P0001',
      detail = format('Too many check-in attempts (%s). Wait a few minutes and try again.', v_scope);
  end if;

  insert into public.checkin_attempts (kind, session_id, device_token_hash, ip_hash)
  values (p_kind, p_session_id, p_device_token_hash, p_ip_hash);
  -- Attempts are only needed for the rate window; prune old ones as we go.
  delete from public.checkin_attempts where created_at < now() - interval '1 day';
end;
$$;

-- ---------------------------------------------------------------------------
-- Public check-in (called by the /t/<tag> server code with the secret key)
-- ---------------------------------------------------------------------------

-- Directory search for "Not you? Find your name". Returns nothing for fewer
-- than 2 characters and at most 5 active members; names only.
create function public.search_checkin_names(
  p_checkin_tag text,
  p_name_query text,
  p_device_token_hash text,
  p_ip_hash text
)
returns table (member_id uuid, first_name text, last_name text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  c_max_results constant integer := 5;
  v_session public.sessions;
  v_query text := lower(btrim(regexp_replace(coalesce(p_name_query, ''), '\s+', ' ', 'g')));
begin
  perform private.require_valid_client_identity(p_device_token_hash, p_ip_hash);
  v_session := private.find_open_session_by_checkin_tag(p_checkin_tag);

  if char_length(v_query) < 2 then
    return;
  end if;
  -- Letters, spaces, apostrophes, hyphens and dots only: also keeps LIKE wildcards out.
  if char_length(v_query) > 50 or v_query !~ '^[[:alpha:] .''-]+$' then
    raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'Search with letters only.';
  end if;

  perform private.record_checkin_attempt('search', v_session.id, p_device_token_hash, p_ip_hash, 30, 120, 600);

  return query
    select member.id, member.first_name::text, member.last_name::text
    from public.members as member
    where member.is_active
      and (
        lower(member.first_name || ' ' || member.last_name) like v_query || '%'
        or lower(member.last_name) like v_query || '%'
      )
    order by member.first_name, member.last_name, member.id
    limit c_max_results;
end;
$$;

-- Creates a pending check-in request for the host's tray. `p_member_id` is the
-- recognised or searched-for member (null for a first-timer, who must give a
-- skill level). One pending request per phone per session: a repeat returns
-- the existing request. Outcomes after the rate check are returned (not
-- raised) so the recorded attempt is kept and counts toward the limit:
-- { status: 'pending', checkin_request_id, was_already_pending }
-- | { status: 'already_checked_in' } | { status: 'member_not_found' }.
create function public.submit_checkin(
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
volatile
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
    select 1 from public.members where id = p_member_id and is_active
  ) then
    return jsonb_build_object('status', 'member_not_found');
  end if;

  if p_member_id is not null and exists (
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
      session_id, member_id, first_name, last_name, skill_level, device_token_hash, ip_hash
    )
    values (
      v_session.id, p_member_id, v_first_name, v_last_name, p_skill_level, p_device_token_hash, p_ip_hash
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

-- ---------------------------------------------------------------------------
-- Host entry points
-- ---------------------------------------------------------------------------

-- Approves a pending request, atomically: creates the member for a first-timer
-- (or refreshes the returning member's details), links the phone, adds the
-- session participant (reusing the member's existing one) and, when the
-- session is live, appends the PlayerJoined event. The caller generates
-- `p_session_participant_id` (or passes the member's existing participant id)
-- so the engine can validate the exact event first. The event arguments are
-- required only for a live session.
create function public.approve_checkin(
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
  v_actor_user_id uuid := private.require_host(p_actor_user_id);
  v_session_id uuid;
  v_session public.sessions;
  v_request public.checkin_requests;
  v_member_id uuid;
  v_member_skill_level public.skill_level;
  v_participant public.session_participants;
  v_event_result jsonb;
begin
  select session_id into v_session_id from public.checkin_requests where id = p_checkin_request_id;
  if not found then
    raise exception 'CHECKIN_REQUEST_NOT_FOUND' using errcode = 'P0002',
      detail = format('No check-in request %s.', p_checkin_request_id);
  end if;
  -- Session first, the same lock order as every other log write.
  v_session := private.lock_session(v_session_id);
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
  if v_session.status = 'live' and (p_event_id is null or p_expected_last_seq is null or p_occurred_at is null) then
    raise exception 'EVENT_REQUIRED' using errcode = '22023',
      detail = 'Approving into a live session needs event_id, expected_last_seq and occurred_at.';
  end if;
  if v_session.status = 'live' and exists (select 1 from public.session_events where event_id = p_event_id) then
    raise exception 'EVENT_ID_REUSED' using errcode = '22023',
      detail = format('event_id %s already belongs to a different action; generate a new one.', p_event_id);
  end if;

  if v_request.member_id is null then
    insert into public.members (first_name, last_name, skill_level, last_checked_in_at)
    values (v_request.first_name, v_request.last_name, v_request.skill_level, now())
    returning id, skill_level into v_member_id, v_member_skill_level;
  else
    update public.members
    set first_name = v_request.first_name,
        last_name = v_request.last_name,
        skill_level = coalesce(v_request.skill_level, skill_level),
        last_checked_in_at = now()
    where id = v_request.member_id
    returning id, skill_level into v_member_id, v_member_skill_level;
  end if;

  insert into public.member_devices (token_hash, member_id)
  values (v_request.device_token_hash, v_member_id)
  on conflict (token_hash) do update set member_id = excluded.member_id, last_seen_at = now();

  select * into v_participant
  from public.session_participants
  where session_id = v_session.id and member_id = v_member_id;
  if found then
    if v_participant.id is distinct from p_session_participant_id then
      raise exception 'PARTICIPANT_ID_MISMATCH' using errcode = '22023',
        detail = format('This member is already participant %s in the session.', v_participant.id);
    end if;
  else
    insert into public.session_participants (id, session_id, member_id, is_guest, first_name, last_name, skill_level)
    values (p_session_participant_id, v_session.id, v_member_id, false, v_request.first_name, v_request.last_name, v_member_skill_level)
    returning * into v_participant;
  end if;

  if v_session.status = 'live' then
    v_event_result := private.insert_session_event(
      v_session, p_event_id, p_expected_last_seq, 'PlayerJoined',
      private.player_joined_payload(v_participant), p_occurred_at, v_actor_user_id
    );
  end if;

  update public.checkin_requests
  set status = 'approved',
      decided_by = v_actor_user_id,
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

create function public.reject_checkin(p_actor_user_id uuid, p_checkin_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := private.require_host(p_actor_user_id);
  v_request public.checkin_requests;
begin
  select * into v_request from public.checkin_requests where id = p_checkin_request_id for update;
  if not found then
    raise exception 'CHECKIN_REQUEST_NOT_FOUND' using errcode = 'P0002',
      detail = format('No check-in request %s.', p_checkin_request_id);
  end if;
  if v_request.status = 'rejected' then
    return jsonb_build_object('status', 'already_rejected');
  end if;
  if v_request.status <> 'pending' then
    raise exception 'CHECKIN_REQUEST_NOT_PENDING' using errcode = 'P0001',
      detail = format('Check-in request %s is %s.', p_checkin_request_id, v_request.status);
  end if;

  update public.checkin_requests
  set status = 'rejected', decided_by = v_actor_user_id, decided_at = now()
  where id = p_checkin_request_id;
  return jsonb_build_object('status', 'rejected');
end;
$$;

revoke execute on all functions in schema private from public;
revoke all on function public.search_checkin_names(text, text, text, text) from public, anon, authenticated;
revoke all on function public.submit_checkin(text, text, text, text, text, public.skill_level, uuid) from public, anon, authenticated;
revoke all on function public.approve_checkin(uuid, uuid, uuid, uuid, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.reject_checkin(uuid, uuid) from public, anon, authenticated;
grant execute on function public.search_checkin_names(text, text, text, text) to service_role;
grant execute on function public.submit_checkin(text, text, text, text, text, public.skill_level, uuid) to service_role;
grant execute on function public.approve_checkin(uuid, uuid, uuid, uuid, integer, timestamptz) to service_role;
grant execute on function public.reject_checkin(uuid, uuid) to service_role;
