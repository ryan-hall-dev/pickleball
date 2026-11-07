-- Write path of the live session log. Plan §3: a server action validates the
-- action with the engine, then calls ONE of these functions, which in a single
-- transaction verifies the acting user is a host, checks `event_id`
-- (idempotency) BEFORE the sequence check, checks `expected_last_seq`, inserts
-- the event, applies any `matches` side effect and bumps `sessions.last_seq`.
--
-- Only service_role can execute these (docs/decisions/0002-server-only-writes.md):
-- server code verifies the signed-in user from their session cookie and passes
-- it as `p_actor_user_id`, which each function checks against `hosts`.
--
-- Error convention: `raise exception '<CODE>'`, where CODE is stable and mapped
-- by src/server. SQLSTATE: 42501 not allowed, P0002 not found, 22023 invalid
-- input, P0001 rejected by the current state (e.g. STALE_EXPECTED_SEQ).
-- Results are jsonb: { status: 'appended' | 'duplicate', seq, occurred_at, ... }.

-- How far the server's event time may be from the database clock.
create function private.max_event_clock_skew()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '5 minutes' $$;

-- Returns the actor when they are on the hosts list; raises NOT_A_HOST otherwise.
create function private.require_host(p_actor_user_id uuid)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_actor_user_id is null or not exists (select 1 from public.hosts where user_id = p_actor_user_id) then
    raise exception 'NOT_A_HOST' using errcode = '42501', detail = 'Only users on the hosts list can do this.';
  end if;
  return p_actor_user_id;
end;
$$;

-- Trims and collapses whitespace; raises INVALID_NAME unless 1-50 printable characters.
create function private.normalise_person_name(p_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
begin
  if char_length(v_name) not between 1 and 50 or v_name ~ '[[:cntrl:]]' then
    raise exception 'INVALID_NAME' using errcode = '22023', detail = 'Names must be 1-50 characters.';
  end if;
  return v_name;
end;
$$;

-- Serialises every write to one session's log.
create function private.lock_session(p_session_id uuid)
returns public.sessions
language plpgsql
set search_path = ''
as $$
declare
  v_session public.sessions;
begin
  select * into v_session from public.sessions where id = p_session_id for update;
  if not found then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'P0002', detail = format('No session %s.', p_session_id);
  end if;
  return v_session;
end;
$$;

-- The original result when `p_event_id` already landed (a double click or a
-- retry), or null. Called before any state or sequence check.
create function private.find_duplicate_session_event(
  p_session_id uuid,
  p_event_id uuid,
  p_type public.session_event_type
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_event public.session_events;
begin
  select * into v_event from public.session_events where event_id = p_event_id;
  if not found then
    return null;
  end if;
  if v_event.session_id <> p_session_id or v_event.type <> p_type then
    raise exception 'EVENT_ID_REUSED' using errcode = '22023',
      detail = format('event_id %s already belongs to a different action; generate a new one.', p_event_id);
  end if;
  return jsonb_build_object('status', 'duplicate', 'seq', v_event.seq, 'occurred_at', v_event.occurred_at);
end;
$$;

-- Appends one event after the sequence and time checks. `p_session` must be locked.
create function private.insert_session_event(
  p_session public.sessions,
  p_event_id uuid,
  p_expected_last_seq integer,
  p_type public.session_event_type,
  p_payload jsonb,
  p_occurred_at timestamptz,
  p_actor_user_id uuid
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
  from public.session_events
  where session_id = p_session.id
  order by seq desc
  limit 1;
  if p_occurred_at is null
    or p_occurred_at < v_previous_occurred_at
    or abs(extract(epoch from p_occurred_at - now())) > extract(epoch from private.max_event_clock_skew()) then
    raise exception 'INVALID_OCCURRED_AT' using errcode = '22023',
      detail = format('occurred_at %s must not precede the previous event (%s) and must be within %s of the database clock.',
        p_occurred_at, v_previous_occurred_at, private.max_event_clock_skew());
  end if;

  insert into public.session_events (session_id, seq, event_id, type, payload, occurred_at, actor_user_id)
  values (p_session.id, v_seq, p_event_id, p_type, p_payload, p_occurred_at, p_actor_user_id);
  update public.sessions set last_seq = v_seq where id = p_session.id;

  return jsonb_build_object('status', 'appended', 'seq', v_seq, 'occurred_at', p_occurred_at);
end;
$$;

-- Writes the `matches` row an event implies (see matchRecords().matchesRowStatus):
-- a completion or abandonment writes its final row; undoing one marks it `reverted`.
create function private.write_match_row(
  p_session_id uuid,
  p_type public.session_event_type,
  p_payload jsonb,
  p_match_row jsonb
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_expected_status public.match_row_status;
  v_match_id uuid;
  v_written_count integer;
begin
  v_expected_status := case p_type
    when 'MatchCompleted' then 'completed'::public.match_row_status
    when 'MatchAbandoned' then 'abandoned'::public.match_row_status
    when 'MatchCompletionReverted' then 'reverted'::public.match_row_status
    when 'MatchAbandonReverted' then 'reverted'::public.match_row_status
  end;

  if v_expected_status is null then
    if p_match_row is not null then
      raise exception 'MATCH_ROW_NOT_EXPECTED' using errcode = '22023',
        detail = format('%s does not change a matches row.', p_type);
    end if;
    return;
  end if;

  if p_match_row is null or jsonb_typeof(p_match_row) <> 'object' then
    raise exception 'MATCH_ROW_REQUIRED' using errcode = '22023',
      detail = format('%s must write its matches row.', p_type);
  end if;

  if p_type in ('MatchCompleted', 'MatchAbandoned') then
    v_match_id := (p_payload ->> 'matchId')::uuid;
  else
    select (payload ->> 'matchId')::uuid into v_match_id
    from public.session_events
    where session_id = p_session_id and seq = (p_payload ->> 'targetSeq')::integer;
  end if;

  if v_match_id is null
    or (p_match_row ->> 'id')::uuid is distinct from v_match_id
    or (p_match_row ->> 'status') is distinct from v_expected_status::text then
    raise exception 'MATCH_ROW_MISMATCH' using errcode = '22023',
      detail = format('%s needs a %s row for match %s.', p_type, v_expected_status, v_match_id);
  end if;

  insert into public.matches as existing (
    id, session_id, court_id, court_name, team_a, team_b,
    started_at, ended_at, duration_seconds, status
  )
  values (
    v_match_id,
    p_session_id,
    (p_match_row ->> 'court_id')::uuid,
    p_match_row ->> 'court_name',
    array(select jsonb_array_elements_text(p_match_row -> 'team_a'))::uuid[],
    array(select jsonb_array_elements_text(p_match_row -> 'team_b'))::uuid[],
    (p_match_row ->> 'started_at')::timestamptz,
    (p_match_row ->> 'ended_at')::timestamptz,
    (p_match_row ->> 'duration_seconds')::integer,
    v_expected_status
  )
  on conflict (id) do update set
    court_id = excluded.court_id,
    court_name = excluded.court_name,
    team_a = excluded.team_a,
    team_b = excluded.team_b,
    started_at = excluded.started_at,
    ended_at = excluded.ended_at,
    duration_seconds = excluded.duration_seconds,
    status = excluded.status
  where existing.session_id = excluded.session_id;

  get diagnostics v_written_count = row_count;
  if v_written_count = 0 then
    raise exception 'MATCH_ROW_MISMATCH' using errcode = '22023',
      detail = format('Match %s belongs to another session.', v_match_id);
  end if;
end;
$$;

-- The engine's PlayerJoined payload for a participant row (names come from the snapshot).
create function private.player_joined_payload(p_participant public.session_participants)
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
      'skill', p_participant.skill_level,
      'isGuest', p_participant.is_guest
    )
  );
$$;

-- ---------------------------------------------------------------------------
-- Host entry points
-- ---------------------------------------------------------------------------

-- Any live-session action except start and end (which have their own functions).
-- `p_match_row` is required for completions, abandonments and their undos, and
-- refused for everything else.
create function public.append_session_event(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_event_id uuid,
  p_expected_last_seq integer,
  p_type public.session_event_type,
  p_payload jsonb,
  p_occurred_at timestamptz,
  p_match_row jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := private.require_host(p_actor_user_id);
  v_session public.sessions := private.lock_session(p_session_id);
  v_duplicate jsonb;
  v_result jsonb;
begin
  v_duplicate := private.find_duplicate_session_event(p_session_id, p_event_id, p_type);
  if v_duplicate is not null then
    return v_duplicate;
  end if;

  if p_type in ('SessionStarted', 'SessionEnded') then
    raise exception 'USE_DEDICATED_FUNCTION' using errcode = '22023',
      detail = 'Use start_session or end_session.';
  end if;
  if v_session.status <> 'live' then
    raise exception 'SESSION_NOT_LIVE' using errcode = 'P0001',
      detail = format('Session %s is %s.', p_session_id, v_session.status);
  end if;
  if p_type = 'PlayerJoined' and not exists (
    select 1 from public.session_participants
    where session_id = p_session_id
      and id::text = p_payload #>> '{participant,participantId}'
  ) then
    raise exception 'UNKNOWN_PARTICIPANT' using errcode = '22023',
      detail = 'PlayerJoined must name a session_participants row of this session.';
  end if;

  v_result := private.insert_session_event(
    v_session, p_event_id, p_expected_last_seq, p_type, p_payload, p_occurred_at, v_actor_user_id
  );
  perform private.write_match_row(p_session_id, p_type, p_payload, p_match_row);
  return v_result;
end;
$$;

-- Draft -> live, the SessionStarted event (with its initial matches) and the
-- config snapshot, atomically. A draft session's last seq is always 0.
create function public.start_session(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_event_id uuid,
  p_occurred_at timestamptz,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := private.require_host(p_actor_user_id);
  v_session public.sessions := private.lock_session(p_session_id);
  v_duplicate jsonb;
begin
  v_duplicate := private.find_duplicate_session_event(p_session_id, p_event_id, 'SessionStarted');
  if v_duplicate is not null then
    return v_duplicate;
  end if;

  if v_session.status <> 'draft' then
    raise exception 'SESSION_NOT_DRAFT' using errcode = 'P0001',
      detail = format('Session %s is already %s.', p_session_id, v_session.status);
  end if;
  if jsonb_typeof(p_payload -> 'config') is distinct from 'object'
    or jsonb_typeof(p_payload #> '{config,participants}') is distinct from 'array'
    or jsonb_typeof(p_payload -> 'initialAttendeeIds') is distinct from 'array' then
    raise exception 'INVALID_PAYLOAD' using errcode = '22023',
      detail = 'SessionStarted needs config, config.participants and initialAttendeeIds.';
  end if;
  if exists (
    select 1
    from (
      select jsonb_array_elements_text(p_payload -> 'initialAttendeeIds') as participant_id
      union all
      select roster_entry ->> 'participantId'
      from jsonb_array_elements(p_payload #> '{config,participants}') as roster_entry
    ) as named
    where not exists (
      select 1 from public.session_participants as participant
      where participant.session_id = p_session_id and participant.id::text = named.participant_id
    )
  ) then
    raise exception 'UNKNOWN_PARTICIPANT' using errcode = '22023',
      detail = 'Every participant in SessionStarted must be a session_participants row of this session.';
  end if;

  -- Status first: the draft constraint requires last_seq = 0, which the insert bumps.
  update public.sessions
  set status = 'live', started_at = p_occurred_at, config_snapshot = p_payload -> 'config'
  where id = p_session_id;

  return private.insert_session_event(
    v_session, p_event_id, 0, 'SessionStarted', p_payload, p_occurred_at, v_actor_user_id
  );
end;
$$;

-- Live -> ended plus the SessionEnded event, atomically.
create function public.end_session(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_event_id uuid,
  p_expected_last_seq integer,
  p_occurred_at timestamptz,
  p_final_stats jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := private.require_host(p_actor_user_id);
  v_session public.sessions := private.lock_session(p_session_id);
  v_duplicate jsonb;
  v_result jsonb;
begin
  v_duplicate := private.find_duplicate_session_event(p_session_id, p_event_id, 'SessionEnded');
  if v_duplicate is not null then
    return v_duplicate;
  end if;

  if v_session.status <> 'live' then
    raise exception 'SESSION_NOT_LIVE' using errcode = 'P0001',
      detail = format('Session %s is %s.', p_session_id, v_session.status);
  end if;

  v_result := private.insert_session_event(
    v_session, p_event_id, p_expected_last_seq, 'SessionEnded', '{}'::jsonb, p_occurred_at, v_actor_user_id
  );
  update public.sessions
  set status = 'ended', ended_at = p_occurred_at, final_stats = p_final_stats
  where id = p_session_id;
  return v_result;
end;
$$;

-- A guest added by the host during a live session: the participant row and its
-- PlayerJoined event, atomically. The caller generates the participant id so
-- the engine can validate the exact event first.
create function public.add_guest_mid_session(
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
  v_actor_user_id uuid := private.require_host(p_actor_user_id);
  v_session public.sessions := private.lock_session(p_session_id);
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

  insert into public.session_participants (id, session_id, member_id, is_guest, first_name, last_name, skill_level)
  values (
    p_session_participant_id, p_session_id, null, true,
    private.normalise_person_name(p_first_name), private.normalise_person_name(p_last_name), p_skill_level
  )
  returning * into v_participant;

  v_result := private.insert_session_event(
    v_session, p_event_id, p_expected_last_seq, 'PlayerJoined',
    private.player_joined_payload(v_participant), p_occurred_at, v_actor_user_id
  );
  return v_result || jsonb_build_object('session_participant_id', v_participant.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Draft setup
-- ---------------------------------------------------------------------------

-- Abandons a draft, freeing the host's one open-session slot. Its rows stay for history.
create function public.cancel_draft_session(p_actor_user_id uuid, p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.sessions;
begin
  perform private.require_host(p_actor_user_id);
  v_session := private.lock_session(p_session_id);
  if v_session.status = 'cancelled' then
    return jsonb_build_object('status', 'already_cancelled');
  end if;
  if v_session.status <> 'draft' then
    raise exception 'SESSION_NOT_DRAFT' using errcode = 'P0001',
      detail = format('Session %s is %s; only a draft can be cancelled.', p_session_id, v_session.status);
  end if;
  update public.sessions set status = 'cancelled' where id = p_session_id;
  return jsonb_build_object('status', 'cancelled');
end;
$$;

-- Removes a participant from a draft's attendee list. If a check-in approval
-- added them, that request becomes `withdrawn` (it no longer points at a participant).
create function public.remove_draft_participant(p_actor_user_id uuid, p_session_participant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session_id uuid;
  v_session public.sessions;
begin
  perform private.require_host(p_actor_user_id);
  select session_id into v_session_id from public.session_participants where id = p_session_participant_id;
  if not found then
    raise exception 'PARTICIPANT_NOT_FOUND' using errcode = 'P0002',
      detail = format('No session participant %s.', p_session_participant_id);
  end if;
  v_session := private.lock_session(v_session_id);
  if v_session.status <> 'draft' then
    raise exception 'SESSION_NOT_DRAFT' using errcode = 'P0001',
      detail = format('Participants can only be removed from a draft; session %s is %s.', v_session_id, v_session.status);
  end if;

  update public.checkin_requests
  set status = 'withdrawn', session_participant_id = null
  where session_participant_id = p_session_participant_id;
  delete from public.session_participants where id = p_session_participant_id;
  return jsonb_build_object('status', 'removed');
end;
$$;

revoke execute on all functions in schema private from public;
revoke all on function public.append_session_event(uuid, uuid, uuid, integer, public.session_event_type, jsonb, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.start_session(uuid, uuid, uuid, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.end_session(uuid, uuid, uuid, integer, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.add_guest_mid_session(uuid, uuid, uuid, text, text, public.skill_level, uuid, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.cancel_draft_session(uuid, uuid) from public, anon, authenticated;
revoke all on function public.remove_draft_participant(uuid, uuid) from public, anon, authenticated;
grant execute on function public.append_session_event(uuid, uuid, uuid, integer, public.session_event_type, jsonb, timestamptz, jsonb) to service_role;
grant execute on function public.start_session(uuid, uuid, uuid, timestamptz, jsonb) to service_role;
grant execute on function public.end_session(uuid, uuid, uuid, integer, timestamptz, jsonb) to service_role;
grant execute on function public.add_guest_mid_session(uuid, uuid, uuid, text, text, public.skill_level, uuid, integer, timestamptz) to service_role;
grant execute on function public.cancel_draft_session(uuid, uuid) to service_role;
grant execute on function public.remove_draft_participant(uuid, uuid) to service_role;
