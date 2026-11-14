-- Random session-specific cookies are created by the server. SQL stores only
-- their SHA-256; there is no persistent device identity or HMAC derivation.
-- Existing hashes remain historical request data. Legacy cookies are ignored.
-- Adds the session UUID to the page header so the server can select its cookie,
-- and rejects null participant IDs before attempting an insert.

create or replace function public.get_checkin_page(p_checkin_tag text, p_device_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_social public.socials;
  v_session public.sessions;
  v_current_request jsonb;
begin
  if p_device_token_hash is not null and p_device_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023',
      detail = 'Device token hash must be lowercase hex SHA-256.';
  end if;

  if p_checkin_tag is not null and p_checkin_tag ~ '^[a-z0-9_-]{16,64}$' then
    select * into v_social from public.socials where checkin_tag = p_checkin_tag;
  end if;
  if v_social.id is null then
    return jsonb_build_object('status', 'inactive');
  end if;

  -- At most one open session per social (sessions_one_open_per_social_idx).
  select * into v_session
  from public.sessions
  where social_id = v_social.id
    and status in ('draft', 'live')
    and checkin_open;
  if v_session.id is null then
    return jsonb_build_object('status', 'no_open_session', 'social_name', v_social.name);
  end if;

  if p_device_token_hash is not null then
    select jsonb_build_object(
      'id', request.id,
      'status', request.status,
      'first_name', request.first_name
    ) into v_current_request
    from public.checkin_requests as request
    where request.session_id = v_session.id
      and request.device_token_hash = p_device_token_hash
    order by request.created_at desc, request.id desc
    limit 1;
  end if;

  return jsonb_build_object(
    'status', 'open',
    'social_name', v_social.name,
    'session', jsonb_build_object(
      'id', v_session.id,
      'name', v_session.name,
      'status', v_session.status,
      'planned_start', v_session.planned_start,
      'planned_end', v_session.planned_end,
      -- The draft's selected courts, or the courts enabled at the start
      -- (the SessionStarted config replaces the draft's snapshot).
      'courts_count', case
        when jsonb_typeof(v_session.config_snapshot -> 'courts') = 'array'
          then jsonb_array_length(v_session.config_snapshot -> 'courts')
        else 0
      end,
      'checked_in_count', (
        select count(*) from public.session_participants where session_id = v_session.id
      )
    ),
    'current_request', v_current_request,
    'now', now()
  );
end;
$$;

create or replace function private.insert_session_participant(
  p_session_participant_id uuid,
  p_session_id uuid,
  p_social_id uuid,
  p_first_name text,
  p_last_name text,
  p_skill_level public.skill_level
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
    insert into public.session_participants (id, session_id, social_id, first_name, last_name, skill_level)
    values (p_session_participant_id, p_session_id, p_social_id, v_first_name, v_last_name, p_skill_level)
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

revoke all on function private.insert_session_participant(uuid, uuid, uuid, text, text, public.skill_level) from public, anon, authenticated, service_role;
revoke all on function public.get_checkin_page(text, text) from public, anon, authenticated;
grant execute on function public.get_checkin_page(text, text) to service_role;
