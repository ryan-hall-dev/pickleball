-- Additive participant details only. Existing participant/request/event rows and
-- config snapshots are untouched; historical missing values remain unknown.
alter table public.session_participants add column gender text
  constraint session_participants_gender_check check (gender in ('male', 'female'));
alter table public.checkin_requests add column gender text
  constraint checkin_requests_gender_check check (gender in ('male', 'female'));

-- Remove writable old signatures, rather than leaving a gender-free bypass.
drop function public.submit_checkin(text, uuid, text, text, text, text, public.skill_level);
drop function public.add_draft_participant(uuid, uuid, uuid, text, text, public.skill_level);
drop function public.add_participant_mid_session(uuid, uuid, uuid, text, text, public.skill_level, uuid, integer, timestamptz);
drop function public.approve_checkin(uuid, uuid, uuid, uuid, integer, timestamptz);
drop function public.start_session(uuid, uuid, uuid, timestamptz, jsonb);
drop function private.insert_session_participant(uuid, uuid, uuid, text, text, public.skill_level);


create function private.insert_session_participant(
  p_session_participant_id uuid,
  p_session_id uuid,
  p_social_id uuid,
  p_first_name text,
  p_last_name text,
  p_skill_level public.skill_level,
  p_gender text
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
  if p_session_participant_id is null then
    raise exception 'INVALID_PARTICIPANT_ID' using errcode = '22023',
      detail = 'p_session_participant_id is required.';
  end if;
  if p_skill_level is null then
    raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'Choose a playing level.';
  end if;
  if p_gender is null or p_gender not in ('male', 'female') then
    raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'Choose male or female.';
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
    insert into public.session_participants (id, session_id, social_id, first_name, last_name, skill_level, gender)
    values (p_session_participant_id, p_session_id, p_social_id, v_first_name, v_last_name, p_skill_level, p_gender)
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
    ) || case when p_participant.gender is null then '{}'::jsonb
      else jsonb_build_object('gender', p_participant.gender) end
  );
$$;

create function public.submit_checkin(
  p_checkin_tag text,
  p_expected_session_id uuid,
  p_device_token_hash text,
  p_ip_hash text,
  p_first_name text,
  p_last_name text,
  p_skill_level public.skill_level,
  p_gender text
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
  if p_gender is null or p_gender not in ('male', 'female') then
    raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'Choose male or female.';
  end if;
  -- Lock the rendered session, not whichever session opened after it. Host
  -- session transitions take this same row lock. Revalidate after waiting.
  if p_expected_session_id is null then
    raise exception 'SESSION_CHANGED' using errcode = 'P0001';
  end if;
  select * into v_session from public.sessions where id = p_expected_session_id for update;
  if not found or v_session.status not in ('draft', 'live') or not v_session.checkin_open then
    raise exception 'SESSION_CHANGED' using errcode = 'P0001';
  end if;
  -- Lock the tag's social too, so reissuing a tag cannot race this submit.
  perform 1 from public.socials
  where id = v_session.social_id and checkin_tag = p_checkin_tag
  for share;
  if not found then
    raise exception 'SESSION_CHANGED' using errcode = 'P0001';
  end if;

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
      session_id, social_id, first_name, last_name, skill_level, gender, device_token_hash, ip_hash
    )
    values (
      v_session.id, v_session.social_id, v_first_name, v_last_name, p_skill_level, p_gender, p_device_token_hash, p_ip_hash
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

create function public.add_draft_participant(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_session_participant_id uuid,
  p_first_name text,
  p_last_name text,
  p_skill_level public.skill_level,
  p_gender text
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
    p_session_participant_id, p_session_id, v_social_id, p_first_name, p_last_name, p_skill_level, p_gender
  );
  return p_session_participant_id;
end;
$$;

create function public.add_participant_mid_session(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_session_participant_id uuid,
  p_first_name text,
  p_last_name text,
  p_skill_level public.skill_level,
  p_event_id uuid,
  p_expected_last_seq integer,
  p_occurred_at timestamptz,
  p_gender text
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
    p_session_participant_id, p_session_id, v_social_id, p_first_name, p_last_name, p_skill_level, p_gender
  );

  v_result := private.insert_session_event(
    v_session, p_event_id, p_expected_last_seq, 'PlayerJoined',
    private.player_joined_payload(v_participant), p_occurred_at, p_actor_user_id
  );
  return v_result || jsonb_build_object('session_participant_id', v_participant.id);
end;
$$;

create function public.approve_checkin(
  p_actor_user_id uuid,
  p_checkin_request_id uuid,
  p_session_participant_id uuid,
  p_event_id uuid default null,
  p_expected_last_seq integer default null,
  p_occurred_at timestamptz default null,
  p_gender text default null
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
  v_gender text;
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

  if v_request.gender is not null and p_gender is not null and p_gender <> v_request.gender then
    raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'A submitted gender cannot be overridden.';
  end if;
  v_gender := coalesce(v_request.gender, p_gender);
  v_participant := private.insert_session_participant(
    p_session_participant_id, v_session.id, v_social_id,
    v_request.first_name, v_request.last_name, v_request.skill_level, v_gender
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

drop function public.list_checkin_requests_for_open_session(uuid);
create function public.list_checkin_requests_for_open_session(p_actor_user_id uuid)
returns table (
  id uuid,
  created_at timestamptz,
  first_name text,
  last_name text,
  skill_level public.skill_level,
  gender text,
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
      request.gender,
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

-- Explicit host completion of old draft details; never edits names or history.
create function public.set_draft_participant_details(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_participant_id uuid,
  p_gender text,
  p_skill_level public.skill_level,
  p_expected_draft_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_revision integer;
begin
  perform private.lock_social_open_draft(v_social_id, p_session_id);
  if p_gender is null or p_gender not in ('male', 'female') or p_skill_level is null then
    raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'Choose male or female and a playing level.';
  end if;
  update public.sessions set draft_revision = draft_revision + 1
  where id = p_session_id and social_id = v_social_id and draft_revision = p_expected_draft_revision
  returning draft_revision into v_revision;
  if not found then
    raise exception 'DRAFT_CHANGED_ELSEWHERE' using errcode = 'P0409';
  end if;
  update public.session_participants set gender = p_gender, skill_level = p_skill_level
  where id = p_participant_id and session_id = p_session_id and social_id = v_social_id;
  if not found then
    raise exception 'UNKNOWN_PARTICIPANT' using errcode = '22023';
  end if;
  return jsonb_build_object('status', 'saved', 'draftRevision', v_revision);
end;
$$;

create function public.start_session(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_event_id uuid,
  p_occurred_at timestamptz,
  p_payload jsonb,
  p_expected_draft_revision integer default null
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

  if p_payload #>> '{config,policyVersion}' = 'simple-social-v1' then
    if p_expected_draft_revision is null or p_expected_draft_revision <> v_session.draft_revision then
      raise exception 'DRAFT_CHANGED_ELSEWHERE' using errcode = 'P0409';
    end if;
    if jsonb_typeof(p_payload #> '{config,courts}') is distinct from 'array' then
      raise exception 'INVALID_PAYLOAD' using errcode = '22023';
    end if;
    if jsonb_array_length(p_payload #> '{config,courts}') = 0
      or exists (select 1 from jsonb_array_elements(p_payload #> '{config,courts}') court
        where court ->> 'format' is distinct from 'doubles') then
      raise exception 'INVALID_PAYLOAD' using errcode = '22023', detail = 'Simple socials need doubles courts.';
    end if;
    if p_payload #> '{config,courts}' is distinct from v_session.config_snapshot -> 'courts' then
      raise exception 'DRAFT_CHANGED_ELSEWHERE' using errcode = 'P0409', detail = 'Selected courts changed.';
    end if;
    if exists (select 1 from public.session_participants
      where session_id = p_session_id and social_id = v_social_id
        and (gender is null or skill_level is null)) then
      raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'Complete every player gender and playing level.';
    end if;
    -- Array order is irrelevant; duplicates, omissions and stale details are not.
    if (select coalesce(jsonb_agg(entry order by entry ->> 'participantId'), '[]'::jsonb)
        from jsonb_array_elements(p_payload #> '{config,participants}') entry)
      is distinct from
       (select coalesce(jsonb_agg(private.player_joined_payload(participant) -> 'participant' order by participant.id::text), '[]'::jsonb)
        from public.session_participants participant where session_id = p_session_id and social_id = v_social_id)
      or (select coalesce(jsonb_agg(entry order by entry #>> '{}'), '[]'::jsonb)
        from jsonb_array_elements(p_payload -> 'initialAttendeeIds') entry)
      is distinct from
       (select coalesce(jsonb_agg(to_jsonb(id::text) order by id::text), '[]'::jsonb)
        from public.session_participants where session_id = p_session_id and social_id = v_social_id) then
      raise exception 'STALE_DRAFT_ROSTER' using errcode = 'P0001', detail = 'Reload the current draft participants.';
    end if;
  end if;

  -- Status first: the draft constraint requires last_seq = 0, which the insert bumps.
  update public.sessions
  set status = 'live', started_at = p_occurred_at, config_snapshot = p_payload -> 'config'
  where id = p_session_id;

  return private.insert_session_event(
    v_session, p_event_id, 0, 'SessionStarted', p_payload, p_occurred_at, p_actor_user_id
  );
end;
$$;

create or replace function public.append_session_event(
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
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_session public.sessions := private.lock_social_session(v_social_id, p_session_id);
  v_duplicate jsonb;
  v_result jsonb;
  v_participant public.session_participants;
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

  if p_type = 'PlayerJoined' and v_session.config_snapshot ->> 'policyVersion' = 'simple-social-v1' then
    select * into v_participant from public.session_participants
    where session_id = p_session_id and social_id = v_social_id
      and id::text = p_payload #>> '{participant,participantId}';
    if v_participant.gender is null or v_participant.skill_level is null
      or p_payload -> 'participant' is distinct from private.player_joined_payload(v_participant) -> 'participant' then
      raise exception 'INVALID_PAYLOAD' using errcode = '22023', detail = 'PlayerJoined must match the stored participant details.';
    end if;
  end if;

  v_result := private.insert_session_event(
    v_session, p_event_id, p_expected_last_seq, p_type, p_payload, p_occurred_at, p_actor_user_id
  );
  perform private.write_match_row(p_session_id, p_type, p_payload, p_match_row);
  return v_result;
end;
$$;

-- Explicit privileges on every changed entry point. No client-side writes.

revoke all on function public.submit_checkin(text, uuid, text, text, text, text, public.skill_level, text) from public, anon, authenticated;
grant execute on function public.submit_checkin(text, uuid, text, text, text, text, public.skill_level, text) to service_role;

revoke all on function public.add_draft_participant(uuid, uuid, uuid, text, text, public.skill_level, text) from public, anon, authenticated;
grant execute on function public.add_draft_participant(uuid, uuid, uuid, text, text, public.skill_level, text) to service_role;

revoke all on function public.add_participant_mid_session(uuid, uuid, uuid, text, text, public.skill_level, uuid, integer, timestamptz, text) from public, anon, authenticated;
grant execute on function public.add_participant_mid_session(uuid, uuid, uuid, text, text, public.skill_level, uuid, integer, timestamptz, text) to service_role;

revoke all on function public.approve_checkin(uuid, uuid, uuid, uuid, integer, timestamptz, text) from public, anon, authenticated;
grant execute on function public.approve_checkin(uuid, uuid, uuid, uuid, integer, timestamptz, text) to service_role;

revoke all on function public.list_checkin_requests_for_open_session(uuid) from public, anon, authenticated;
grant execute on function public.list_checkin_requests_for_open_session(uuid) to service_role;

revoke all on function public.set_draft_participant_details(uuid, uuid, uuid, text, public.skill_level, integer) from public, anon, authenticated;
grant execute on function public.set_draft_participant_details(uuid, uuid, uuid, text, public.skill_level, integer) to service_role;

revoke all on function public.start_session(uuid, uuid, uuid, timestamptz, jsonb, integer) from public, anon, authenticated;
grant execute on function public.start_session(uuid, uuid, uuid, timestamptz, jsonb, integer) to service_role;

revoke all on function public.append_session_event(uuid, uuid, uuid, integer, public.session_event_type, jsonb, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.append_session_event(uuid, uuid, uuid, integer, public.session_event_type, jsonb, timestamptz, jsonb) to service_role;

revoke all on function private.insert_session_participant(uuid, uuid, uuid, text, text, public.skill_level, text) from public, anon, authenticated, service_role;

revoke all on function private.player_joined_payload(public.session_participants) from public, anon, authenticated, service_role;
