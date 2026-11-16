-- Truthful draft duration and actual live clocks; no session rows are changed.
-- Rollback: restore get_checkin_page from migration 20261112100000 after reverting app code.

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
  v_duration_minutes numeric;
  v_ends_at timestamptz;
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

  -- Draft timestamps are placeholders for duration only. Live clocks use the
  -- actual recorded start, including historical sessions with a saved duration.
  v_duration_minutes := extract(epoch from (v_session.planned_end - v_session.planned_start)) / 60;
  if v_session.status = 'live'
     and jsonb_typeof(v_session.config_snapshot -> 'plannedDurationMinutes') = 'number' then
    v_duration_minutes := (v_session.config_snapshot ->> 'plannedDurationMinutes')::numeric;
  end if;
  if v_duration_minutes <= 0 or v_duration_minutes > 720 then
    raise exception 'INVALID_SESSION_DURATION' using errcode = '22023';
  end if;
  if v_session.status = 'live' and v_session.started_at is not null then
    v_ends_at := v_session.started_at + v_duration_minutes * interval '1 minute';
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
      'duration_minutes', v_duration_minutes,
      'started_at', case when v_session.status = 'live' then v_session.started_at else null end,
      'ends_at', v_ends_at,
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

revoke all on function public.get_checkin_page(text, text) from public, anon, authenticated;
grant execute on function public.get_checkin_page(text, text) to service_role;
