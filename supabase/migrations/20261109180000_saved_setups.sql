-- Setup screen (M4.4): saved setups ("Save this setup", "Saved setups", the
-- reuse banner).
--
-- RLS: saved setups are private to their host (was: readable by every host).
--
-- A saved setup is a host's own reusable defaults: location, duration,
-- courts, format, timings and rotation. Never attendance, and never anything
-- about a session (id, status, log). Applying one copies its values into the
-- host's draft; later draft edits never change the saved setup.
--
-- save_setup: upserts by (host, name ignoring case), so saving under an
-- existing name replaces that setup. Config keys outside the allowed set are
-- refused, so attendance can't be stored even by mistake.
--
-- apply_saved_setup: one transaction that locks the actor's OWN open draft
-- (private.lock_own_open_draft), checks the setup is theirs and the draft is
-- still at the expected revision (DRAFT_CHANGED_ELSEWHERE otherwise), writes
-- the draft's location, end time (the locked row's start + duration) and
-- config patch, bumps the revision and marks the setup as just used. The server builds the patch from
-- the saved setup after re-reading the courts (dropping ones that are gone).
-- A dedicated function rather than save_session_draft: that one rewrites the
-- name and start too, which the server would have to read first (a race with
-- another tab), and it couldn't touch last_used_at in the same transaction.
--
-- Access (docs/decisions/0002-server-only-writes.md): service_role only; the
-- server verifies the user first and passes their id as p_actor_user_id.

-- Optimistic concurrency for the draft's settings (Ryan, 2026-11-09): every
-- settings write (save_session_draft, apply_saved_setup) names the revision
-- it was based on and bumps it, so a stale tab can't overwrite newer
-- settings. Attendance writes don't touch it (they're set-based and
-- reconciled). An integer rather than updated_at: exact (JS dates drop
-- timestamptz microseconds) and bumped only by settings writes.
alter table public.sessions
  add column draft_revision integer not null default 0 check (draft_revision >= 0);

-- A host reads only their OWN saved setups (other tables stay readable by
-- every host; a setup is personal).
drop policy saved_setups_select_hosts on public.saved_setups;
create policy saved_setups_select_own on public.saved_setups
  for select to authenticated
  using ((select private.is_host()) and host_id = (select auth.uid()));

-- "Saturday Social" and "saturday social " are the same setup for one host.
create unique index saved_setups_host_name_unique_idx
  on public.saved_setups (host_id, lower(btrim(name)));

create function public.save_setup(
  p_actor_user_id uuid,
  p_name text,
  p_config jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_setup_id uuid;
begin
  perform private.require_host(p_actor_user_id);
  if p_config is null or jsonb_typeof(p_config) <> 'object' then
    raise exception 'INVALID_SETUP_CONFIG' using errcode = '22023',
      detail = 'p_config must be a JSON object.';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_config) as config_key
    where config_key not in (
      'location', 'durationMinutes', 'courts', 'matchFormat',
      'targetMatchMinutes', 'changeoverMinutes', 'rotation'
    )
  ) then
    raise exception 'INVALID_SETUP_CONFIG' using errcode = '22023',
      detail = 'A saved setup holds only location, durationMinutes, courts, matchFormat, targetMatchMinutes, changeoverMinutes and rotation.';
  end if;

  insert into public.saved_setups (host_id, name, config, last_used_at)
  values (p_actor_user_id, p_name, p_config, now())
  on conflict (host_id, lower(btrim(name))) do update
    set name = excluded.name,
        config = excluded.config,
        last_used_at = excluded.last_used_at
  returning id into v_setup_id;
  return v_setup_id;
end;
$$;

create function public.apply_saved_setup(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_setup_id uuid,
  p_expected_draft_revision integer,
  p_location text,
  p_duration_minutes integer,
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
  perform 1 from public.saved_setups
  where id = p_setup_id
    and host_id = p_actor_user_id
  for update;
  if not found then
    raise exception 'SAVED_SETUP_NOT_FOUND' using errcode = 'P0002',
      detail = format('Setup %s is not a saved setup of host %s.', p_setup_id, p_actor_user_id);
  end if;
  -- 12 hours at most, as for any draft (setupRules MAX_SESSION_DURATION_MINUTES).
  if p_duration_minutes is null or p_duration_minutes not between 1 and 720 then
    raise exception 'INVALID_DURATION' using errcode = '22023',
      detail = 'p_duration_minutes must be 1 to 720.';
  end if;
  if p_config_patch is null or jsonb_typeof(p_config_patch) <> 'object' then
    raise exception 'INVALID_CONFIG_PATCH' using errcode = '22023',
      detail = 'p_config_patch must be a JSON object.';
  end if;

  update public.sessions
  set location = nullif(p_location, ''),
      planned_end = planned_start + make_interval(mins => p_duration_minutes),
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
  update public.saved_setups
  set last_used_at = now()
  where id = p_setup_id;
  return jsonb_build_object('status', 'applied', 'draftRevision', v_draft_revision);
end;
$$;

revoke all on function public.save_setup(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.apply_saved_setup(uuid, uuid, uuid, integer, text, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.save_setup(uuid, text, jsonb) to service_role;
grant execute on function public.apply_saved_setup(uuid, uuid, uuid, integer, text, integer, jsonb) to service_role;
