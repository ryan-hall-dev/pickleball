-- Setup screen (M4): save a draft atomically, and keep court names unique
-- regardless of case.
--
-- save_session_draft: one UPDATE writes the draft's scalar columns and merges
-- a patch into config_snapshot (`coalesce(config_snapshot, '{}') || patch`).
-- The UPDATE takes the session's row lock, and under READ COMMITTED a
-- concurrent save re-reads the newest row before merging, so keys owned by
-- other setup steps (e.g. rotation) are never lost to a read-merge-write
-- race. It only touches the actor's OWN session while it is a draft;
-- anything else raises DRAFT_NOT_OPEN. Column domains and checks
-- (short_label, location length, planned_end > planned_start) still apply.
--
-- Access (docs/decisions/0002-server-only-writes.md): service_role only; the
-- server verifies the user first and passes their id as p_actor_user_id.

create function public.save_session_draft(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_name text,
  p_location text,
  p_host_name text,
  p_planned_start timestamptz,
  p_planned_end timestamptz,
  p_config_patch jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_host(p_actor_user_id);
  if p_config_patch is null or jsonb_typeof(p_config_patch) <> 'object' then
    raise exception 'INVALID_CONFIG_PATCH' using errcode = '22023',
      detail = 'p_config_patch must be a JSON object.';
  end if;

  update public.sessions
  set name = p_name,
      -- An empty location means none.
      location = nullif(p_location, ''),
      host_name = p_host_name,
      planned_start = p_planned_start,
      planned_end = p_planned_end,
      config_snapshot = coalesce(config_snapshot, '{}'::jsonb) || p_config_patch
  where id = p_session_id
    and host_id = p_actor_user_id
    and status = 'draft';
  if not found then
    raise exception 'DRAFT_NOT_OPEN' using errcode = 'P0002',
      detail = format('Session %s is not an open draft of host %s.', p_session_id, p_actor_user_id);
  end if;
  return jsonb_build_object('status', 'saved');
end;
$$;

revoke all on function public.save_session_draft(uuid, uuid, text, text, text, timestamptz, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.save_session_draft(uuid, uuid, text, text, text, timestamptz, timestamptz, jsonb)
  to service_role;

-- "Court 5" and "court 5" are the same court. Names are already trimmed by
-- the short_label domain.
create unique index courts_name_lower_unique_idx on public.courts (lower(name));
