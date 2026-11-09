-- Optimistic concurrency for a draft's settings (Ryan, 2026-11-09).
--
-- save_session_draft now takes the draft_revision its edits were based on
-- (sessions.draft_revision, added in 20261109180000). Under the session's
-- row lock it writes only if the draft is still at that revision, bumps it,
-- and returns the new one. A stale tab or device gets DRAFT_CHANGED_ELSEWHERE
-- instead of silently overwriting newer settings; anything that isn't the
-- actor's open draft is still DRAFT_NOT_OPEN. Attendance writes don't bump
-- the revision.
--
-- Access (docs/decisions/0002-server-only-writes.md): service_role only.

drop function public.save_session_draft(uuid, uuid, text, text, text, timestamptz, timestamptz, jsonb);

create function public.save_session_draft(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_expected_draft_revision integer,
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
declare
  v_draft_revision integer;
begin
  perform private.lock_own_open_draft(p_actor_user_id, p_session_id);
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
      config_snapshot = coalesce(config_snapshot, '{}'::jsonb) || p_config_patch,
      draft_revision = draft_revision + 1
  where id = p_session_id
    and draft_revision = p_expected_draft_revision
  returning draft_revision into v_draft_revision;
  if not found then
    -- Own SQLSTATE: 40001 (serialization_failure) invites automatic retries.
    raise exception 'DRAFT_CHANGED_ELSEWHERE' using errcode = 'P0409',
      detail = format('Session %s settings changed since revision %s.', p_session_id, p_expected_draft_revision);
  end if;
  return jsonb_build_object('status', 'saved', 'draftRevision', v_draft_revision);
end;
$$;

revoke all on function public.save_session_draft(uuid, uuid, integer, text, text, text, timestamptz, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.save_session_draft(uuid, uuid, integer, text, text, text, timestamptz, timestamptz, jsonb)
  to service_role;
