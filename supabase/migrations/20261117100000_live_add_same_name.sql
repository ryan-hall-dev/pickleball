-- Two different people can share a name (ADR 0004 follow-up). Only a host
-- adding someone on the live screen may do it: the player is identified by
-- UUID, the retry guard is the event id, and the name is never used to merge
-- or refuse them. Public check-in, approvals and Setup keep their one-name rule.
--
-- `allows_same_name` marks such a row. It is left out of the unique name index
-- (a partial index of the same name, so existing constraint handling keeps
-- working) and the shared name check is skipped when the live add sets it.
-- Rollback: drop the function overload, recreate the full index (fails while a
-- shared name exists in any session), then drop the column.

alter table public.session_participants
  add column allows_same_name boolean not null default false;

drop index public.session_participants_unique_name_per_session_idx;
create unique index session_participants_unique_name_per_session_idx
  on public.session_participants (session_id, private.normalise_name_for_search(first_name || ' ' || last_name))
  where not allows_same_name;

drop function private.insert_session_participant(uuid, uuid, uuid, text, text, public.skill_level, text);
create function private.insert_session_participant(
  p_session_participant_id uuid,
  p_session_id uuid,
  p_social_id uuid,
  p_first_name text,
  p_last_name text,
  p_skill_level public.skill_level,
  p_gender text,
  p_allows_same_name boolean default false
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
  if not p_allows_same_name and exists (
    select 1 from public.session_participants
    where session_id = p_session_id
      and private.normalise_name_for_search(first_name || ' ' || last_name)
        = private.normalise_name_for_search(v_first_name || ' ' || v_last_name)
  ) then
    raise exception 'NAME_ALREADY_IN_SESSION' using errcode = 'P0001',
      detail = format('Someone with this name is already in session %s.', p_session_id);
  end if;

  begin
    insert into public.session_participants (id, session_id, social_id, first_name, last_name, skill_level, gender, allows_same_name)
    values (p_session_participant_id, p_session_id, p_social_id, v_first_name, v_last_name, p_skill_level, p_gender, p_allows_same_name)
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
revoke all on function private.insert_session_participant(uuid, uuid, uuid, text, text, public.skill_level, text, boolean) from public, anon, authenticated, service_role;

drop function public.add_participant_mid_session(uuid, uuid, uuid, text, text, public.skill_level, uuid, integer, timestamptz, text);
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
  p_gender text,
  p_allows_same_name boolean default false
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
    p_session_participant_id, p_session_id, v_social_id, p_first_name, p_last_name, p_skill_level, p_gender,
    coalesce(p_allows_same_name, false)
  );

  v_result := private.insert_session_event(
    v_session, p_event_id, p_expected_last_seq, 'PlayerJoined',
    private.player_joined_payload(v_participant), p_occurred_at, p_actor_user_id
  );
  return v_result || jsonb_build_object('session_participant_id', v_participant.id);
end;
$$;
revoke all on function public.add_participant_mid_session(uuid, uuid, uuid, text, text, public.skill_level, uuid, integer, timestamptz, text, boolean) from public, anon, authenticated;
grant execute on function public.add_participant_mid_session(uuid, uuid, uuid, text, text, public.skill_level, uuid, integer, timestamptz, text, boolean) to service_role;
