-- M4.5 increment A2: the directory (members, member phones, courts) belongs
-- to one social. Plan: docs/plans/socials.md §1-§3, §8 A2.
-- Decision: docs/decisions/0003-socials-and-data-isolation.md.
--
-- This increment:
--   * adds `social_id` (not null, immutable) to members, member_devices and
--     courts, backfilled into the default social;
--   * members get `unique (id, social_id)`, the target of composite foreign
--     keys, so the database refuses any link to another social's member.
--     member_devices uses it now; session_participants and checkin_requests
--     switch to it in A3;
--   * member_devices: primary key `(social_id, token_hash)` (one phone can be
--     a different member in each social) and a composite FK to members that
--     REPLACES the single-column one (keeping both would make PostgREST
--     embeds ambiguous, PGRST201);
--   * courts: names unique per social (`(social_id, lower(name))`) instead of
--     installation-wide; plain `(social_id, sort_order)` index;
--   * members' prefix search indexes lead with social_id (check-in search is
--     always within one social). The directory's accent-insensitive
--     `search_name` (M4.1) is unchanged;
--   * RLS on members and courts: the caller's own social only. member_devices
--     keeps no read policy;
--   * check-in and attendance functions only touch the social's members and
--     phones. Until A3 gives sessions a social_id, "the session's social" is
--     the social of the host who created it (whose tag routes the check-in;
--     private.session_social_id). Approve/reject refuse a request whose
--     session isn't in the actor's social (or whose creator was removed) as
--     CHECKIN_REQUEST_NOT_FOUND, revealing nothing.
--
-- NOT yet scoped (A3): saved_setups, sessions, session_participants,
-- checkin_requests, session_events and matches keep their private.is_host()
-- policies; session_participants.member_id and checkin_requests.member_id
-- keep their single-column FKs to members.

-- ---------------------------------------------------------------------------
-- Columns, with the backfill in between nullable and not null
-- ---------------------------------------------------------------------------

alter table public.members add column social_id uuid;
alter table public.member_devices add column social_id uuid;
alter table public.courts add column social_id uuid;

-- Existing rows go into the default social: the only social A1 created on a
-- database that had data. With several socials (or none) the owner can't be
-- known, so this refuses rather than guessing (A1 header note).
do $$
declare
  v_social_count integer;
  v_default_social_id uuid;
begin
  if not (
    exists (select 1 from public.members)
    or exists (select 1 from public.member_devices)
    or exists (select 1 from public.courts)
  ) then
    return;
  end if;

  select count(*) into v_social_count from public.socials;
  if v_social_count <> 1 then
    raise exception 'DIRECTORY_BACKFILL_AMBIGUOUS' using errcode = 'P0001',
      detail = format(
        'Members, phones or courts exist but there are %s socials; expected exactly the default one. '
        'Remove the extra (empty) socials, or assign social_id by hand, then rerun.',
        v_social_count
      );
  end if;
  select id into v_default_social_id from public.socials;

  -- Keep each row's real updated_at.
  alter table public.members disable trigger members_set_updated_at;
  alter table public.courts disable trigger courts_set_updated_at;
  update public.members set social_id = v_default_social_id;
  update public.member_devices set social_id = v_default_social_id;
  update public.courts set social_id = v_default_social_id;
  alter table public.members enable trigger members_set_updated_at;
  alter table public.courts enable trigger courts_set_updated_at;

  raise notice 'Directory moved into default social %: % member(s), % phone(s), % court(s).',
    v_default_social_id,
    (select count(*) from public.members),
    (select count(*) from public.member_devices),
    (select count(*) from public.courts);
end;
$$;

-- ---------------------------------------------------------------------------
-- Members
-- ---------------------------------------------------------------------------

alter table public.members
  alter column social_id set not null,
  add constraint members_social_id_fkey foreign key (social_id) references public.socials (id) on delete restrict,
  -- Composite FK target: a row pointing at (member, social) can only name a
  -- member of that social.
  add constraint members_id_social_id_key unique (id, social_id);

-- Prefix search for the check-in page (lower(...) LIKE 'abc%'), within one social.
drop index public.members_full_name_prefix_idx;
drop index public.members_last_name_prefix_idx;
create index members_social_full_name_prefix_idx
  on public.members (social_id, lower(first_name || ' ' || last_name) text_pattern_ops)
  where is_active;
create index members_social_last_name_prefix_idx
  on public.members (social_id, lower(last_name) text_pattern_ops)
  where is_active;

-- ---------------------------------------------------------------------------
-- Member phones: one phone (token hash) per social, linked to that social's member
-- ---------------------------------------------------------------------------

alter table public.member_devices
  alter column social_id set not null,
  drop constraint member_devices_member_id_fkey,
  drop constraint member_devices_pkey,
  add constraint member_devices_pkey primary key (social_id, token_hash),
  add constraint member_devices_member_id_social_id_fkey
    foreign key (member_id, social_id) references public.members (id, social_id) on delete cascade;
-- member_devices_member_id_idx (member_id) stays: it serves the cascade.

-- ---------------------------------------------------------------------------
-- Courts: names unique within a social, nothing shared between socials
-- ---------------------------------------------------------------------------

alter table public.courts
  alter column social_id set not null,
  add constraint courts_social_id_fkey foreign key (social_id) references public.socials (id) on delete restrict,
  drop constraint courts_name_key;
drop index public.courts_name_lower_unique_idx;
-- "Court 5" and "court 5" are the same court within a social (names are
-- already trimmed by the short_label domain); another social may have its own.
create unique index courts_social_name_lower_unique_idx on public.courts (social_id, lower(name));
create index courts_social_sort_order_idx on public.courts (social_id, sort_order);

-- ---------------------------------------------------------------------------
-- A row never moves to another social
-- ---------------------------------------------------------------------------

create trigger members_reject_social_id_change
  before update of social_id on public.members
  for each row
  when (old.social_id is distinct from new.social_id)
  execute function private.reject_social_id_change();

create trigger member_devices_reject_social_id_change
  before update of social_id on public.member_devices
  for each row
  when (old.social_id is distinct from new.social_id)
  execute function private.reject_social_id_change();

create trigger courts_reject_social_id_change
  before update of social_id on public.courts
  for each row
  when (old.social_id is distinct from new.social_id)
  execute function private.reject_social_id_change();

-- ---------------------------------------------------------------------------
-- RLS: a host reads only their own social's members and courts
-- ---------------------------------------------------------------------------

drop policy members_select_hosts on public.members;
create policy members_select_own_social on public.members
  for select to authenticated using (social_id = (select private.current_social_id()));

drop policy courts_select_hosts on public.courts;
create policy courts_select_own_social on public.courts
  for select to authenticated using (social_id = (select private.current_social_id()));

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

-- The actor's social, or NOT_A_HOST. Write functions derive the social from
-- the verified actor (or the session), never from a caller argument.
create function private.require_host_social(p_actor_user_id uuid)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_social_id uuid;
begin
  select social_id into v_social_id from public.hosts where user_id = p_actor_user_id;
  if v_social_id is null then
    raise exception 'NOT_A_HOST' using errcode = '42501', detail = 'Only users on the hosts list can do this.';
  end if;
  return v_social_id;
end;
$$;

-- The session's social until A3 adds sessions.social_id: its creator's
-- social. Null when the creator was removed (host_id set null): such a
-- session belongs to no known social, and callers refuse it.
create function private.session_social_id(p_session public.sessions)
returns uuid
language sql
stable
set search_path = ''
as $$
  select social_id from public.hosts where user_id = p_session.host_id;
$$;

-- Check-in search: active members of the tag's social only.
create or replace function public.search_checkin_names(
  p_checkin_tag text,
  p_name_query text,
  p_device_token_hash text,
  p_ip_hash text
)
returns table (member_id uuid, first_name text, last_name text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  c_max_results constant integer := 5;
  v_session public.sessions;
  v_social_id uuid;
  v_query text := lower(btrim(regexp_replace(coalesce(p_name_query, ''), '\s+', ' ', 'g')));
begin
  perform private.require_valid_client_identity(p_device_token_hash, p_ip_hash);
  v_session := private.find_open_session_by_checkin_tag(p_checkin_tag);
  -- The tag found the session through its creator's social.
  v_social_id := private.session_social_id(v_session);

  if char_length(v_query) < 2 then
    return;
  end if;
  -- Letters, spaces, apostrophes, hyphens and dots only: also keeps LIKE wildcards out.
  if char_length(v_query) > 50 or v_query !~ '^[[:alpha:] .''-]+$' then
    raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'Search with letters only.';
  end if;

  perform private.record_checkin_attempt('search', v_session.id, p_device_token_hash, p_ip_hash, 30, 120, 600);

  return query
    select member.id, member.first_name::text, member.last_name::text
    from public.members as member
    where member.social_id = v_social_id
      and member.is_active
      and (
        lower(member.first_name || ' ' || member.last_name) like v_query || '%'
        or lower(member.last_name) like v_query || '%'
      )
    order by member.first_name, member.last_name, member.id
    limit c_max_results;
end;
$$;

-- Check-in submit: a returning player must be an active member of the tag's
-- social; another social's member answers `member_not_found`, like a missing one.
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
  v_social_id uuid;
  v_first_name text;
  v_last_name text;
  v_request_id uuid;
begin
  perform private.require_valid_client_identity(p_device_token_hash, p_ip_hash);
  v_first_name := private.normalise_person_name(p_first_name);
  v_last_name := private.normalise_person_name(p_last_name);
  if p_member_id is null and p_skill_level is null then
    raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'First-time players must choose a skill level.';
  end if;
  v_session := private.find_open_session_by_checkin_tag(p_checkin_tag);
  v_social_id := private.session_social_id(v_session);

  perform private.record_checkin_attempt('submit', v_session.id, p_device_token_hash, p_ip_hash, 10, 30, 300);

  if p_member_id is not null and not exists (
    select 1 from public.members where id = p_member_id and social_id = v_social_id and is_active
  ) then
    return jsonb_build_object('status', 'member_not_found');
  end if;

  if p_member_id is not null and exists (
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
      session_id, member_id, first_name, last_name, skill_level, device_token_hash, ip_hash
    )
    values (
      v_session.id, p_member_id, v_first_name, v_last_name, p_skill_level, p_device_token_hash, p_ip_hash
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

-- Approve: only a host of the session's social may decide; anyone else (or
-- any request whose session has no known social) gets
-- CHECKIN_REQUEST_NOT_FOUND, as if it didn't exist. The member (new or
-- returning) and the phone belong to that social.
create or replace function public.approve_checkin(
  p_actor_user_id uuid,
  p_checkin_request_id uuid,
  p_session_participant_id uuid,
  p_event_id uuid default null,
  p_expected_last_seq integer default null,
  p_occurred_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := private.require_host(p_actor_user_id);
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_session_id uuid;
  v_session public.sessions;
  v_request public.checkin_requests;
  v_member_id uuid;
  v_member_skill_level public.skill_level;
  v_participant public.session_participants;
  v_event_result jsonb;
begin
  select session_id into v_session_id from public.checkin_requests where id = p_checkin_request_id;
  if not found then
    raise exception 'CHECKIN_REQUEST_NOT_FOUND' using errcode = 'P0002',
      detail = format('No check-in request %s.', p_checkin_request_id);
  end if;
  -- Session first, the same lock order as every other log write.
  v_session := private.lock_session(v_session_id);
  if private.session_social_id(v_session) is distinct from v_social_id then
    raise exception 'CHECKIN_REQUEST_NOT_FOUND' using errcode = 'P0002',
      detail = format('No check-in request %s.', p_checkin_request_id);
  end if;
  select * into v_request from public.checkin_requests where id = p_checkin_request_id for update;

  if v_request.status = 'approved' then
    return jsonb_build_object(
      'status', 'already_approved',
      'member_id', v_request.member_id,
      'session_participant_id', v_request.session_participant_id
    );
  end if;
  if v_request.status <> 'pending' then
    raise exception 'CHECKIN_REQUEST_NOT_PENDING' using errcode = 'P0001',
      detail = format('Check-in request %s is %s.', p_checkin_request_id, v_request.status);
  end if;
  if v_session.status in ('ended', 'cancelled') then
    raise exception 'SESSION_CLOSED' using errcode = 'P0001',
      detail = format('Session %s is %s.', v_session.id, v_session.status);
  end if;
  if v_session.status = 'live' and (p_event_id is null or p_expected_last_seq is null or p_occurred_at is null) then
    raise exception 'EVENT_REQUIRED' using errcode = '22023',
      detail = 'Approving into a live session needs event_id, expected_last_seq and occurred_at.';
  end if;
  if v_session.status = 'live' and exists (select 1 from public.session_events where event_id = p_event_id) then
    raise exception 'EVENT_ID_REUSED' using errcode = '22023',
      detail = format('event_id %s already belongs to a different action; generate a new one.', p_event_id);
  end if;

  if v_request.member_id is null then
    insert into public.members (social_id, first_name, last_name, skill_level, last_checked_in_at)
    values (v_social_id, v_request.first_name, v_request.last_name, v_request.skill_level, now())
    returning id, skill_level into v_member_id, v_member_skill_level;
  else
    update public.members
    set first_name = v_request.first_name,
        last_name = v_request.last_name,
        skill_level = coalesce(v_request.skill_level, skill_level),
        last_checked_in_at = now()
    where id = v_request.member_id
      and social_id = v_social_id
    returning id, skill_level into v_member_id, v_member_skill_level;
    if v_member_id is null then
      raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0002',
        detail = format('Check-in request %s names no member of this social.', p_checkin_request_id);
    end if;
  end if;

  insert into public.member_devices (social_id, token_hash, member_id)
  values (v_social_id, v_request.device_token_hash, v_member_id)
  on conflict (social_id, token_hash) do update set member_id = excluded.member_id, last_seen_at = now();

  select * into v_participant
  from public.session_participants
  where session_id = v_session.id and member_id = v_member_id;
  if found then
    if v_participant.id is distinct from p_session_participant_id then
      raise exception 'PARTICIPANT_ID_MISMATCH' using errcode = '22023',
        detail = format('This member is already participant %s in the session.', v_participant.id);
    end if;
  else
    insert into public.session_participants (id, session_id, member_id, is_guest, first_name, last_name, skill_level)
    values (p_session_participant_id, v_session.id, v_member_id, false, v_request.first_name, v_request.last_name, v_member_skill_level)
    returning * into v_participant;
  end if;

  if v_session.status = 'live' then
    v_event_result := private.insert_session_event(
      v_session, p_event_id, p_expected_last_seq, 'PlayerJoined',
      private.player_joined_payload(v_participant), p_occurred_at, v_actor_user_id
    );
  end if;

  update public.checkin_requests
  set status = 'approved',
      decided_by = v_actor_user_id,
      decided_at = now(),
      member_id = v_member_id,
      session_participant_id = v_participant.id
  where id = p_checkin_request_id;

  return jsonb_build_object(
    'status', 'approved',
    'member_id', v_member_id,
    'session_participant_id', v_participant.id,
    'event', v_event_result
  );
end;
$$;

-- Reject: the same guard as approve.
create or replace function public.reject_checkin(p_actor_user_id uuid, p_checkin_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := private.require_host(p_actor_user_id);
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_request public.checkin_requests;
begin
  select * into v_request from public.checkin_requests where id = p_checkin_request_id for update;
  if not found or private.session_social_id(
    (select session from public.sessions as session where session.id = v_request.session_id)
  ) is distinct from v_social_id then
    raise exception 'CHECKIN_REQUEST_NOT_FOUND' using errcode = 'P0002',
      detail = format('No check-in request %s.', p_checkin_request_id);
  end if;
  if v_request.status = 'rejected' then
    return jsonb_build_object('status', 'already_rejected');
  end if;
  if v_request.status <> 'pending' then
    raise exception 'CHECKIN_REQUEST_NOT_PENDING' using errcode = 'P0001',
      detail = format('Check-in request %s is %s.', p_checkin_request_id, v_request.status);
  end if;

  update public.checkin_requests
  set status = 'rejected', decided_by = v_actor_user_id, decided_at = now()
  where id = p_checkin_request_id;
  return jsonb_build_object('status', 'rejected');
end;
$$;

-- Draft attendance: only active members of the draft's social join. The
-- draft is the actor's own (lock_own_open_draft), so until A3 its social is
-- the actor's; ids of another social's members are skipped like inactive ones.
create or replace function public.set_draft_member_attendance(
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
declare
  v_social_id uuid;
begin
  perform private.lock_own_open_draft(p_actor_user_id, p_session_id);
  v_social_id := private.require_host_social(p_actor_user_id);
  if p_member_ids is null or p_attending is null then
    raise exception 'INVALID_ATTENDANCE' using errcode = '22023',
      detail = 'p_member_ids and p_attending are required.';
  end if;

  if p_attending then
    insert into public.session_participants (session_id, member_id, is_guest, first_name, last_name, skill_level)
    select p_session_id, member.id, false, member.first_name, member.last_name, member.skill_level
    from public.members as member
    where member.id = any(p_member_ids)
      and member.social_id = v_social_id
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

-- ---------------------------------------------------------------------------
-- Grants (create or replace keeps the existing function grants)
-- ---------------------------------------------------------------------------

revoke all on function private.require_host_social(uuid) from public, anon, authenticated;
revoke all on function private.session_social_id(public.sessions) from public, anon, authenticated;
