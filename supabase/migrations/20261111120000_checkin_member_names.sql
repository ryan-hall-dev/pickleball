-- M5 increment 2 review: a member's check-in request stores the member's own
-- names, never the names the phone sent. Before this, a tampered page could
-- submit member_id = Bob with the name "Alice Smith": the host would approve
-- "Alice", Bob would become attending and the phone would be linked to Bob
-- (approve_checkin copies the request's names onto the member).
--
-- submit_checkin keeps its signature (the server still passes names); when
-- p_member_id is set, p_first_name / p_last_name are ignored and the request
-- takes first_name / last_name from public.members (same social, active).
-- Guests' names are validated as before. Everything else is unchanged from
-- 20261111090000_m5_checkin.sql.

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
  if p_member_id is null then
    v_first_name := private.normalise_person_name(p_first_name);
    v_last_name := private.normalise_person_name(p_last_name);
    if p_skill_level is null then
      raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'First-time players must choose a skill level.';
    end if;
  end if;
  v_session := private.find_open_session_by_checkin_tag(p_checkin_tag);

  perform private.record_checkin_attempt('submit', v_session.id, p_device_token_hash, p_ip_hash, 10, 30, 300);

  if p_member_id is not null then
    -- The member's own names (the phone's are ignored).
    select first_name, last_name into v_first_name, v_last_name
    from public.members
    where id = p_member_id and social_id = v_session.social_id and is_active;
    if not found then
      return jsonb_build_object('status', 'member_not_found');
    end if;
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

-- Grants (create or replace keeps them; restated so this file is the record).
revoke all on function public.submit_checkin(text, text, text, text, text, public.skill_level, uuid) from public, anon, authenticated;
grant execute on function public.submit_checkin(text, text, text, text, text, public.skill_level, uuid) to service_role;
