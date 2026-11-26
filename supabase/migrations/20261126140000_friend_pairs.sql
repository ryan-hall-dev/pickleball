-- simple-social-v2 friend pairs (docs/plans/reclub-to-court-v1.md, D4):
-- two Ready players agree to be on the same team for their next game.
--
-- Additive: three event types, and append_session_event_without_host (from
-- 20261126130000) also lets a player ask for themselves, accept a request
-- made to them, and end a pair they are in. Rollback: revert the app and
-- restore that function from 20261126130000; unused enum values are harmless.

alter type public.session_event_type add value if not exists 'FriendPairRequested';
alter type public.session_event_type add value if not exists 'FriendPairAccepted';
alter type public.session_event_type add value if not exists 'FriendPairEnded';

create or replace function public.append_session_event_without_host(
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
    elsif p_type = 'FriendPairRequested' then
      if p_payload ->> 'participantId' is distinct from v_actor then
        raise exception 'ACTION_NOT_ALLOWED' using errcode = '42501', detail = 'A player can only ask for themselves.';
      end if;
    elsif p_type in ('FriendPairAccepted', 'FriendPairEnded') then
      select * into v_target from public.session_events
      where session_id = p_session_id and seq = (p_payload ->> 'requestSeq')::integer;
      if v_target.type is distinct from 'FriendPairRequested'
        or (p_type = 'FriendPairAccepted' and v_target.payload ->> 'friendId' is distinct from v_actor)
        or (p_type = 'FriendPairEnded' and v_actor not in (
          v_target.payload ->> 'participantId', v_target.payload ->> 'friendId')) then
        raise exception 'ACTION_NOT_ALLOWED' using errcode = '42501',
          detail = 'Only the friend asked can accept; only the two of them can end it.';
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
