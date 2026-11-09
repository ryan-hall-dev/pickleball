-- Setup screen (M4.3, "Who's playing?"): attendance for a host's own draft.
--
-- Attendance lives in session_participants. Each function is one
-- transaction that first locks the actor's OWN session row while it is a
-- draft (DRAFT_NOT_OPEN otherwise), so attendance changes queue behind each
-- other and behind start_session / cancel_draft_session (which lock the same
-- row). Member changes have set semantics: "attending" inserts rows that are
-- missing and "not attending" deletes rows that exist, so two tabs or a
-- retry can repeat a change without clobbering each other.
--
-- Deleting draft attendee rows is allowed (the append-only rule is for
-- session_events; the session_participants_delete_only_in_draft trigger still
-- guards everything after the draft). As in remove_draft_participant, a
-- check-in request that pointed at a removed row becomes `withdrawn`.
--
-- Access (docs/decisions/0002-server-only-writes.md): service_role only; the
-- server verifies the user first and passes their id as p_actor_user_id.

-- Locks the actor's open draft for the rest of the transaction, or raises
-- DRAFT_NOT_OPEN (not theirs, not a draft any more, or no such session).
create function private.lock_own_open_draft(p_actor_user_id uuid, p_session_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform private.require_host(p_actor_user_id);
  perform 1 from public.sessions
  where id = p_session_id
    and host_id = p_actor_user_id
    and status = 'draft'
  for update;
  if not found then
    raise exception 'DRAFT_NOT_OPEN' using errcode = 'P0002',
      detail = format('Session %s is not an open draft of host %s.', p_session_id, p_actor_user_id);
  end if;
end;
$$;

-- Marks members as attending (true) or not (false). Attending snapshots each
-- ACTIVE member's name and level; inactive or unknown ids are skipped, and
-- members already attending keep their row. Not attending removes only
-- member rows, never guests.
create function public.set_draft_member_attendance(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_member_ids uuid[],
  p_attending boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_own_open_draft(p_actor_user_id, p_session_id);
  if p_member_ids is null or p_attending is null then
    raise exception 'INVALID_ATTENDANCE' using errcode = '22023',
      detail = 'p_member_ids and p_attending are required.';
  end if;

  if p_attending then
    insert into public.session_participants (session_id, member_id, is_guest, first_name, last_name, skill_level)
    select p_session_id, member.id, false, member.first_name, member.last_name, member.skill_level
    from public.members as member
    where member.id = any(p_member_ids)
      and member.is_active
    on conflict (session_id, member_id) do nothing;
  else
    update public.checkin_requests
    set status = 'withdrawn', session_participant_id = null
    where session_participant_id in (
      select id from public.session_participants
      where session_id = p_session_id
        and not is_guest
        and member_id = any(p_member_ids)
    );
    delete from public.session_participants
    where session_id = p_session_id
      and not is_guest
      and member_id = any(p_member_ids);
  end if;
  return jsonb_build_object('status', 'saved');
end;
$$;

-- Adds a guest (not a club member) to the draft. The server generates the
-- participant id, so a retry of the same add (e.g. after a lost response)
-- finds the row it already made instead of adding the guest twice. An id that
-- belongs to anything but a guest of this draft is refused. Names are trimmed
-- and checked like members' names. Guests with the same name are fine:
-- participants are told apart by id.
create function public.add_draft_guest(
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
begin
  perform private.lock_own_open_draft(p_actor_user_id, p_session_id);
  if p_session_participant_id is null then
    raise exception 'INVALID_PARTICIPANT_ID' using errcode = '22023',
      detail = 'p_session_participant_id is required.';
  end if;
  insert into public.session_participants (id, session_id, member_id, is_guest, first_name, last_name, skill_level)
  values (
    p_session_participant_id, p_session_id, null, true,
    private.normalise_person_name(p_first_name), private.normalise_person_name(p_last_name), p_skill_level
  )
  on conflict (id) do nothing;
  if not found and not exists (
    select 1 from public.session_participants
    where id = p_session_participant_id
      and session_id = p_session_id
      and is_guest
  ) then
    raise exception 'PARTICIPANT_ID_TAKEN' using errcode = '23505',
      detail = format('Participant %s is not a guest of session %s.', p_session_participant_id, p_session_id);
  end if;
  return p_session_participant_id;
end;
$$;

-- Removes a guest from the draft. Only guest rows of this draft are touched;
-- a guest that is already gone (e.g. removed in another tab) is `not_found`.
create function public.remove_draft_guest(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_session_participant_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_own_open_draft(p_actor_user_id, p_session_id);
  update public.checkin_requests
  set status = 'withdrawn', session_participant_id = null
  where session_participant_id in (
    select id from public.session_participants
    where id = p_session_participant_id
      and session_id = p_session_id
      and is_guest
  );
  delete from public.session_participants
  where id = p_session_participant_id
    and session_id = p_session_id
    and is_guest;
  return jsonb_build_object('status', case when found then 'removed' else 'not_found' end);
end;
$$;

revoke all on function private.lock_own_open_draft(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.set_draft_member_attendance(uuid, uuid, uuid[], boolean)
  from public, anon, authenticated;
revoke all on function public.add_draft_guest(uuid, uuid, uuid, text, text, public.skill_level)
  from public, anon, authenticated;
revoke all on function public.remove_draft_guest(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.set_draft_member_attendance(uuid, uuid, uuid[], boolean) to service_role;
grant execute on function public.add_draft_guest(uuid, uuid, uuid, text, text, public.skill_level) to service_role;
grant execute on function public.remove_draft_guest(uuid, uuid, uuid) to service_role;
