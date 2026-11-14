-- Bind every submit to the session rendered on the phone. Stale forms and
-- turnover while a submit is in flight fail before rate-limit/request writes.
-- No universal device identity and no data backfill.
drop function public.submit_checkin(text, text, text, text, text, public.skill_level);

create function public.submit_checkin(
  p_checkin_tag text,
  p_expected_session_id uuid,
  p_device_token_hash text,
  p_ip_hash text,
  p_first_name text,
  p_last_name text,
  p_skill_level public.skill_level
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
      session_id, social_id, first_name, last_name, skill_level, device_token_hash, ip_hash
    )
    values (
      v_session.id, v_session.social_id, v_first_name, v_last_name, p_skill_level, p_device_token_hash, p_ip_hash
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

revoke all on function public.submit_checkin(text, uuid, text, text, text, text, public.skill_level) from public, anon, authenticated;
grant execute on function public.submit_checkin(text, uuid, text, text, text, text, public.skill_level) to service_role;
