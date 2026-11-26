-- Player and system actions in simple-social-v2 sessions
-- (docs/plans/reclub-to-court-v1.md, Phase 2; Phase 0 findings 6 and 7).
--
-- Until now every log write named a host. Two writers act without one:
--   * the app itself, preparing a due court, refilling an emptied seat or
--     closing a court after its last game (no person is the actor);
--   * a checked-in player on their own phone: I'm ready, Need a rest,
--     Ready again, I'm leaving, Game started.
-- One function appends both, executable by service_role only. The server
-- validates every action with the engine first; this function enforces who
-- may do what again, at the database boundary: system writes only prepare or
-- close, and a player acts only for themselves.
--
-- Additive: new functions only. Rollback: revert the app, drop them.

-- The participant this phone checked in as, in the open session the page
-- showed: a roster claim, or an approved walk-in. Null when neither.
create function public.get_checkin_participant(
  p_checkin_tag text,
  p_expected_session_id uuid,
  p_device_token_hash text
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_session public.sessions;
  v_participant_id uuid;
begin
  if p_device_token_hash is null or p_device_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select open_session.* into v_session
  from public.sessions as open_session
  join public.socials as social on social.id = open_session.social_id
  where open_session.id = p_expected_session_id
    and social.checkin_tag = p_checkin_tag
    and open_session.status in ('draft', 'live')
    and open_session.checkin_open;
  if not found then
    raise exception 'SESSION_CHANGED' using errcode = 'P0001';
  end if;
  select session_participant_id into v_participant_id
  from public.session_roster_entries
  where session_id = v_session.id and claimed_device_token_hash = p_device_token_hash;
  if v_participant_id is null then
    select session_participant_id into v_participant_id
    from public.checkin_requests
    where session_id = v_session.id and device_token_hash = p_device_token_hash
      and status = 'approved'
    order by decided_at desc
    limit 1;
  end if;
  return v_participant_id;
end;
$$;

-- insert_session_event (20261107120100) for a player or the system: the
-- same sequence and clock checks, with the actor recorded truthfully.
create function private.insert_session_event_without_host(
  p_session public.sessions,
  p_event_id uuid,
  p_expected_last_seq integer,
  p_type public.session_event_type,
  p_payload jsonb,
  p_occurred_at timestamptz,
  p_actor_session_participant_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_previous_occurred_at timestamptz;
  v_seq integer := p_session.last_seq + 1;
begin
  if p_expected_last_seq is distinct from p_session.last_seq then
    raise exception 'STALE_EXPECTED_SEQ' using errcode = 'P0001',
      detail = format('Expected last seq %s but session %s is at %s.', p_expected_last_seq, p_session.id, p_session.last_seq);
  end if;
  select occurred_at into v_previous_occurred_at
  from public.session_events where session_id = p_session.id
  order by seq desc limit 1;
  if p_occurred_at is null
    or p_occurred_at < v_previous_occurred_at
    or abs(extract(epoch from p_occurred_at - now())) > extract(epoch from private.max_event_clock_skew()) then
    raise exception 'INVALID_OCCURRED_AT' using errcode = '22023';
  end if;
  insert into public.session_events (
    session_id, seq, event_id, type, payload, occurred_at, actor_user_id, actor_session_participant_id
  )
  values (
    p_session.id, v_seq, p_event_id, p_type, p_payload, p_occurred_at, null, p_actor_session_participant_id
  );
  update public.sessions set last_seq = v_seq where id = p_session.id;
  return jsonb_build_object('status', 'appended', 'seq', v_seq, 'occurred_at', p_occurred_at);
end;
$$;

-- Appends a system action (p_actor_session_participant_id null) or a
-- player's own action to a live simple-social-v2 session.
create function public.append_session_event_without_host(
  p_session_id uuid,
  p_event_id uuid,
  p_expected_last_seq integer,
  p_type public.session_event_type,
  p_payload jsonb,
  p_occurred_at timestamptz,
  p_actor_session_participant_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.sessions;
  v_duplicate jsonb;
  v_actor text := p_actor_session_participant_id::text;
  v_target public.session_events;
begin
  -- Serialises every write to this session's log (as the host functions do).
  select * into v_session from public.sessions where id = p_session_id for update;
  if not found then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'P0002';
  end if;
  v_duplicate := private.find_duplicate_session_event(p_session_id, p_event_id, p_type);
  if v_duplicate is not null then
    return v_duplicate;
  end if;
  if v_session.status <> 'live' then
    raise exception 'SESSION_NOT_LIVE' using errcode = 'P0001';
  end if;
  if v_session.config_snapshot ->> 'policyVersion' is distinct from 'simple-social-v2' then
    raise exception 'POLICY_ACTION_NOT_ALLOWED' using errcode = 'P0001',
      detail = 'Only simple-social-v2 sessions take player or automatic actions.';
  end if;

  if p_actor_session_participant_id is null then
    if p_type not in ('NextGroupCalled', 'NextGroupChanged', 'CourtClosed') then
      raise exception 'ACTION_NOT_ALLOWED' using errcode = '42501',
        detail = 'The app may only prepare groups, refill seats and close courts by itself.';
    end if;
  else
    if not exists (
      select 1 from public.session_participants
      where id = p_actor_session_participant_id and session_id = p_session_id
    ) then
      raise exception 'UNKNOWN_PARTICIPANT' using errcode = '42501';
    end if;
    if p_type in ('NextGroupSeatConfirmed', 'PlayerLeft') then
      if p_payload ->> 'participantId' is distinct from v_actor then
        raise exception 'ACTION_NOT_ALLOWED' using errcode = '42501', detail = 'A player acts only for themselves.';
      end if;
    elsif p_type = 'PlayerSkipped' then
      if p_payload ->> 'participantId' is distinct from v_actor
        or p_payload ->> 'reason' is distinct from 'break' then
        raise exception 'ACTION_NOT_ALLOWED' using errcode = '42501', detail = 'A player can only take their own break.';
      end if;
    elsif p_type = 'PlayerUnskipped' then
      select * into v_target from public.session_events
      where session_id = p_session_id and seq = (p_payload ->> 'targetSeq')::integer;
      if v_target.type is distinct from 'PlayerSkipped'
        or v_target.payload ->> 'participantId' is distinct from v_actor then
        raise exception 'ACTION_NOT_ALLOWED' using errcode = '42501', detail = 'A player can only end their own break.';
      end if;
    elsif p_type = 'MatchStarted' then
      if p_payload ->> 'calledEventId' is null
        or not ((p_payload -> 'teamA') ? v_actor or (p_payload -> 'teamB') ? v_actor) then
        raise exception 'ACTION_NOT_ALLOWED' using errcode = '42501', detail = 'Only a player in the called group can start it.';
      end if;
    else
      raise exception 'ACTION_NOT_ALLOWED' using errcode = '42501',
        detail = format('A player can''t record %s.', p_type);
    end if;
  end if;

  return private.insert_session_event_without_host(
    v_session, p_event_id, p_expected_last_seq, p_type, p_payload, p_occurred_at,
    p_actor_session_participant_id
  );
end;
$$;

revoke all on function public.get_checkin_participant(text, uuid, text) from public, anon, authenticated;
grant execute on function public.get_checkin_participant(text, uuid, text) to service_role;
revoke all on function public.append_session_event_without_host(uuid, uuid, integer, public.session_event_type, jsonb, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.append_session_event_without_host(uuid, uuid, integer, public.session_event_type, jsonb, timestamptz, uuid) to service_role;
revoke all on function private.insert_session_event_without_host(public.sessions, uuid, integer, public.session_event_type, jsonb, timestamptz, uuid) from public, anon, authenticated, service_role;
