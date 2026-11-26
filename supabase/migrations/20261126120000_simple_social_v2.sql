-- simple-social-v2 (docs/plans/reclub-to-court-v1.md, Phase 2): new log
-- actions, system-recorded automatic preparation, and v2 sessions accepted
-- by the start and append functions with the same rules as v1.
--
-- Additive. v1 sessions and their logs are unchanged.
--   * session_event_type gains NextGroupSeatConfirmed, NextGroupMoved,
--     CourtCloseScheduled and CourtCloseCancelled.
--   * An event may have no person as its actor only when the app prepared or
--     closed something by itself (NextGroupCalled, NextGroupChanged,
--     CourtClosed): recorded truthfully instead of borrowing whoever's page
--     read triggered it.
--   * start_session and append_session_event: the v1 checks also apply to v2.
-- Rollback: revert the app; restore the two functions from 20261115100000 and
-- the one-actor check from 20261126090000 (only if no system event exists).
-- Enum values can't be dropped; unused ones are harmless.

alter type public.session_event_type add value if not exists 'NextGroupSeatConfirmed';
alter type public.session_event_type add value if not exists 'NextGroupMoved';
alter type public.session_event_type add value if not exists 'CourtCloseScheduled';
alter type public.session_event_type add value if not exists 'CourtCloseCancelled';

alter table public.session_events drop constraint session_events_one_actor;
alter table public.session_events add constraint session_events_one_actor check (
  not (actor_user_id is not null and actor_session_participant_id is not null)
  and (
    actor_user_id is not null
    or actor_session_participant_id is not null
    or type in ('NextGroupCalled', 'NextGroupChanged', 'CourtClosed')
  )
);

create or replace function public.start_session(
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

  if p_payload #>> '{config,policyVersion}' in ('simple-social-v1', 'simple-social-v2') then
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

  if p_type = 'PlayerJoined' and v_session.config_snapshot ->> 'policyVersion' in ('simple-social-v1', 'simple-social-v2') then
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
