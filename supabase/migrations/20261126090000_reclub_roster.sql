-- Reclub roster and self check-in (docs/plans/reclub-to-court-v1.md, Phase 1).
--
-- The host pastes the Reclub list; each line becomes a roster entry with its
-- own UUID (names are never identifiers). A player finds their name on the
-- public check-in page and claims it with no host approval: the claim creates
-- the session participant at once (and, in a live session, its PlayerJoined
-- event, recorded as the player's own action). One phone holds at most one
-- entry. "That's my name" on a taken entry asks the host, who moves the claim
-- to the new phone or keeps it. A host can check in a listed player who has
-- no phone. Walk-ins (not on the list) still need one host tap, and the host
-- can close walk-ins.
--
-- Additive: existing rows, events and functions keep working. Changes to
-- existing objects:
--   * session_participants.last_name may be empty (one-word Reclub names).
--     Every existing function still refuses an empty last name; only roster
--     check-ins write one.
--   * session_events records a player as the actor of their own action
--     (actor_session_participant_id), instead of borrowing a host's id.
--   * sessions.walk_ins_open; submit_checkin refuses walk-ins when closed.
--   * get_checkin_page also returns the roster state for this phone.
-- Rollback: revert the app first; then drop the new functions and tables,
-- restore submit_checkin and get_checkin_page from 20261115100000 and
-- 20261115120000, drop sessions.walk_ins_open, and (only if no player event or
-- empty last name exists) restore the two not-null/domain rules.

-- ---------------------------------------------------------------------------
-- Existing tables
-- ---------------------------------------------------------------------------

alter table public.session_participants alter column last_name type text;
alter table public.session_participants add constraint session_participants_last_name_check
  check (last_name = btrim(last_name) and char_length(last_name) <= 50 and last_name !~ '[[:cntrl:]]');

alter table public.session_events alter column actor_user_id drop not null;
alter table public.session_events add column actor_session_participant_id uuid;
alter table public.session_events add constraint session_events_one_actor
  check ((actor_user_id is null) <> (actor_session_participant_id is null));

alter table public.sessions add column walk_ins_open boolean not null default true;

alter type public.checkin_attempt_kind add value if not exists 'claim';

-- ---------------------------------------------------------------------------
-- Roster
-- ---------------------------------------------------------------------------

create table public.session_roster_entries (
  id uuid primary key,
  session_id uuid not null,
  social_id uuid not null,
  -- The Reclub name; null for a guest, shown as "Guest of <player>".
  display_name text
    check (display_name = btrim(display_name) and char_length(display_name) between 1 and 50
      and display_name !~ '[[:cntrl:]]'),
  guest_of_entry_id uuid references public.session_roster_entries (id),
  -- Tells two people of the same name apart ("red paddle").
  host_note text
    check (host_note = btrim(host_note) and char_length(host_note) between 1 and 40
      and host_note !~ '[[:cntrl:]]'),
  position integer not null check (position >= 1),
  session_participant_id uuid unique references public.session_participants (id),
  -- The phone holding the entry; null when a host checked in someone with no phone.
  claimed_device_token_hash public.sha256_hex,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint session_roster_entries_session_social_fkey
    foreign key (session_id, social_id) references public.sessions (id, social_id),
  constraint session_roster_entries_player_or_guest
    check ((display_name is null) = (guest_of_entry_id is not null)),
  constraint session_roster_entries_claim_complete
    check ((claimed_at is null) = (session_participant_id is null)),
  constraint session_roster_entries_phone_needs_claim
    check (claimed_device_token_hash is null or session_participant_id is not null)
);
-- One phone, one entry per session.
create unique index session_roster_entries_one_per_phone_idx
  on public.session_roster_entries (session_id, claimed_device_token_hash)
  where claimed_device_token_hash is not null;
create unique index session_roster_entries_position_idx
  on public.session_roster_entries (session_id, position);
create index session_roster_entries_guest_of_idx
  on public.session_roster_entries (guest_of_entry_id);
create index session_roster_entries_social_id_idx
  on public.session_roster_entries (social_id);

create trigger session_roster_entries_reject_social_id_change
  before update of social_id on public.session_roster_entries
  for each row
  when (old.social_id is distinct from new.social_id)
  execute function private.reject_social_id_change();

create type public.roster_transfer_status as enum ('pending', 'moved', 'kept', 'withdrawn');

-- "That's my name": a phone asking for an entry another phone holds.
create table public.roster_transfer_requests (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  social_id uuid not null,
  roster_entry_id uuid not null references public.session_roster_entries (id),
  device_token_hash public.sha256_hex not null,
  status public.roster_transfer_status not null default 'pending',
  created_at timestamptz not null default now(),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  constraint roster_transfer_requests_session_social_fkey
    foreign key (session_id, social_id) references public.sessions (id, social_id),
  constraint roster_transfer_requests_decided_when_final
    check ((status in ('pending', 'withdrawn')) = (decided_at is null))
);
-- One open request per phone.
create unique index roster_transfer_requests_one_pending_per_phone_idx
  on public.roster_transfer_requests (session_id, device_token_hash)
  where status = 'pending';
create index roster_transfer_requests_entry_idx on public.roster_transfer_requests (roster_entry_id);
create index roster_transfer_requests_social_id_idx on public.roster_transfer_requests (social_id);
create index roster_transfer_requests_decided_by_idx on public.roster_transfer_requests (decided_by);

create trigger roster_transfer_requests_reject_social_id_change
  before update of social_id on public.roster_transfer_requests
  for each row
  when (old.social_id is distinct from new.social_id)
  execute function private.reject_social_id_change();

alter table public.session_roster_entries enable row level security;
alter table public.roster_transfer_requests enable row level security;
create policy session_roster_entries_select_own_social on public.session_roster_entries
  for select to authenticated using (social_id = (select private.current_social_id()));
create policy roster_transfer_requests_select_own_social on public.roster_transfer_requests
  for select to authenticated using (social_id = (select private.current_social_id()));
grant select on public.session_roster_entries, public.roster_transfer_requests to authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- How each entry is shown: same-name players are numbered ("Minh Nguyen (1)"),
-- and a player's guests are numbered when there is more than one.
create function private.roster_entry_labels(p_session_id uuid)
returns table (
  entry_id uuid,
  display_name text,
  guest_of_entry_id uuid,
  guest_of_name text,
  twin_number integer,
  twin_count integer,
  guest_number integer,
  guest_count integer,
  host_note text,
  entry_position integer,
  search_name text
)
language sql
stable
set search_path = ''
as $$
  with players as (
    select entry.id, entry.display_name, entry.host_note, entry.position,
      private.normalise_name_for_search(entry.display_name) as folded,
      row_number() over (
        partition by private.normalise_name_for_search(entry.display_name) order by entry.position
      )::integer as twin_number,
      count(*) over (partition by private.normalise_name_for_search(entry.display_name))::integer as twin_count
    from public.session_roster_entries as entry
    where entry.session_id = p_session_id and entry.guest_of_entry_id is null
  ),
  guests as (
    select entry.id, entry.guest_of_entry_id, entry.host_note, entry.position,
      row_number() over (partition by entry.guest_of_entry_id order by entry.position)::integer as guest_number,
      count(*) over (partition by entry.guest_of_entry_id)::integer as guest_count
    from public.session_roster_entries as entry
    where entry.session_id = p_session_id and entry.guest_of_entry_id is not null
  )
  select players.id, players.display_name, null::uuid, null::text,
    players.twin_number, players.twin_count, null::integer, null::integer,
    players.host_note, players.position, players.folded
  from players
  union all
  select guests.id, null::text, guests.guest_of_entry_id, host_player.display_name,
    host_player.twin_number, host_player.twin_count, guests.guest_number, guests.guest_count,
    guests.host_note, guests.position, host_player.folded
  from guests
  join players as host_player on host_player.id = guests.guest_of_entry_id;
$$;

-- Locks the open session the check-in page rendered, and its tag's social, as
-- submit_checkin does. Raises SESSION_CHANGED otherwise.
create function private.lock_checkin_session(p_checkin_tag text, p_expected_session_id uuid)
returns public.sessions
language plpgsql
set search_path = ''
as $$
declare
  v_session public.sessions;
begin
  if p_expected_session_id is null then
    raise exception 'SESSION_CHANGED' using errcode = 'P0001';
  end if;
  select * into v_session from public.sessions where id = p_expected_session_id for update;
  if not found or v_session.status not in ('draft', 'live') or not v_session.checkin_open then
    raise exception 'SESSION_CHANGED' using errcode = 'P0001';
  end if;
  perform 1 from public.socials
  where id = v_session.social_id and checkin_tag = p_checkin_tag
  for share;
  if not found then
    raise exception 'SESSION_CHANGED' using errcode = 'P0001';
  end if;
  return v_session;
end;
$$;

-- Appends a player's own action to the log. The player is the actor; the
-- sequence and time are the database's (no client clock is involved).
create function private.insert_player_session_event(
  p_session public.sessions,
  p_type public.session_event_type,
  p_payload jsonb,
  p_actor_session_participant_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_seq integer := p_session.last_seq + 1;
  v_occurred_at timestamptz;
begin
  select greatest(now(), max(occurred_at)) into v_occurred_at
  from public.session_events where session_id = p_session.id;
  insert into public.session_events (
    session_id, seq, event_id, type, payload, occurred_at, actor_user_id, actor_session_participant_id
  )
  values (
    p_session.id, v_seq, gen_random_uuid(), p_type, p_payload, coalesce(v_occurred_at, now()), null,
    p_actor_session_participant_id
  );
  update public.sessions set last_seq = v_seq where id = p_session.id;
  return jsonb_build_object('status', 'appended', 'seq', v_seq, 'occurred_at', v_occurred_at);
end;
$$;

-- The participant a roster check-in creates. A listed player's name comes from
-- the roster (first word, then the rest; one-word names have an empty last
-- name); a guest types their own. Same names are allowed: the entry and the
-- UUID identify the person, never the name.
create function private.insert_roster_participant(
  p_session public.sessions,
  p_entry public.session_roster_entries,
  p_session_participant_id uuid,
  p_first_name text,
  p_last_name text,
  p_skill_level public.skill_level,
  p_gender text
)
returns public.session_participants
language plpgsql
set search_path = ''
as $$
declare
  v_first_name text;
  v_last_name text;
  v_participant public.session_participants;
begin
  if p_skill_level is null then
    raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'Choose a playing level.';
  end if;
  if p_gender is null or p_gender not in ('male', 'female') then
    raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'Choose male or female.';
  end if;
  if p_entry.guest_of_entry_id is null then
    v_first_name := split_part(p_entry.display_name, ' ', 1);
    v_last_name := btrim(substr(p_entry.display_name, char_length(v_first_name) + 1));
  else
    v_first_name := private.normalise_person_name(p_first_name);
    v_last_name := private.normalise_person_name(p_last_name);
  end if;
  insert into public.session_participants (
    id, session_id, social_id, first_name, last_name, skill_level, gender, allows_same_name
  )
  values (
    p_session_participant_id, p_session.id, p_session.social_id, v_first_name, v_last_name,
    p_skill_level, p_gender, true
  )
  returning * into v_participant;
  return v_participant;
end;
$$;

-- ---------------------------------------------------------------------------
-- Host: import and manage the roster (any host of the session's social)
-- ---------------------------------------------------------------------------

-- Adds pasted names in order. p_entries: [{id, displayName} | {id, guestOfEntryId}],
-- a guest naming an entry already imported or earlier in this batch.
-- p_expected_entry_count guards against two hosts importing at once
-- (ROSTER_CHANGED); a retry of an import that landed returns already_imported.
create function public.import_roster_entries(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_expected_entry_count integer,
  p_entries jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_session public.sessions := private.lock_social_session(v_social_id, p_session_id);
  v_entry jsonb;
  v_position integer;
  v_added integer := 0;
  v_entry_id uuid;
  v_guest_of uuid;
begin
  if v_session.status not in ('draft', 'live') then
    raise exception 'SESSION_CLOSED' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_entries) is distinct from 'array'
    or jsonb_array_length(p_entries) not between 1 and 200 then
    raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'Add 1 to 200 names at a time.';
  end if;
  if exists (
    select 1 from public.session_roster_entries
    where session_id = p_session_id and id = (p_entries -> 0 ->> 'id')::uuid
  ) then
    return jsonb_build_object('status', 'already_imported');
  end if;
  if (select count(*) from public.session_roster_entries where session_id = p_session_id)
    <> p_expected_entry_count then
    raise exception 'ROSTER_CHANGED' using errcode = 'P0409';
  end if;

  select coalesce(max(position), 0) into v_position
  from public.session_roster_entries where session_id = p_session_id;
  for v_entry in select * from jsonb_array_elements(p_entries) loop
    v_entry_id := (v_entry ->> 'id')::uuid;
    v_guest_of := (v_entry ->> 'guestOfEntryId')::uuid;
    if v_entry_id is null then
      raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'Every entry needs an id.';
    end if;
    if v_guest_of is not null and not exists (
      select 1 from public.session_roster_entries
      where id = v_guest_of and session_id = p_session_id and guest_of_entry_id is null
    ) then
      raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'A guest must name a listed player.';
    end if;
    v_position := v_position + 1;
    insert into public.session_roster_entries (id, session_id, social_id, display_name, guest_of_entry_id, position)
    values (
      v_entry_id, p_session_id, v_social_id,
      case when v_guest_of is null
        then btrim(regexp_replace(v_entry ->> 'displayName', '\s+', ' ', 'g')) end,
      v_guest_of, v_position
    );
    v_added := v_added + 1;
  end loop;
  return jsonb_build_object('status', 'imported', 'added', v_added);
end;
$$;

-- Removes a name nobody has checked in as (with any unclaimed guests of it).
create function public.remove_roster_entry(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_roster_entry_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_session public.sessions := private.lock_social_session(v_social_id, p_session_id);
  v_entry public.session_roster_entries;
begin
  select * into v_entry from public.session_roster_entries
  where id = p_roster_entry_id and session_id = v_session.id;
  if not found then
    return jsonb_build_object('status', 'already_removed');
  end if;
  if v_entry.session_participant_id is not null or exists (
    select 1 from public.session_roster_entries
    where guest_of_entry_id = v_entry.id and session_participant_id is not null
  ) then
    raise exception 'ROSTER_ENTRY_CHECKED_IN' using errcode = 'P0001',
      detail = 'Someone has already checked in with this name or its guest.';
  end if;
  delete from public.roster_transfer_requests
  where roster_entry_id in (
    select id from public.session_roster_entries where id = v_entry.id or guest_of_entry_id = v_entry.id
  );
  delete from public.session_roster_entries where guest_of_entry_id = v_entry.id;
  delete from public.session_roster_entries where id = v_entry.id;
  return jsonb_build_object('status', 'removed');
end;
$$;

-- Sets or clears the short note that tells two same-name entries apart.
create function public.set_roster_entry_note(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_roster_entry_id uuid,
  p_host_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_session public.sessions := private.lock_social_session(v_social_id, p_session_id);
  v_note text := nullif(btrim(regexp_replace(coalesce(p_host_note, ''), '\s+', ' ', 'g')), '');
begin
  update public.session_roster_entries set host_note = v_note
  where id = p_roster_entry_id and session_id = v_session.id;
  if not found then
    raise exception 'ROSTER_ENTRY_NOT_FOUND' using errcode = 'P0002';
  end if;
  return jsonb_build_object('status', 'saved');
end;
$$;

create function public.set_walk_ins_open(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_walk_ins_open boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_session public.sessions := private.lock_social_session(v_social_id, p_session_id);
begin
  if v_session.status not in ('draft', 'live') or p_walk_ins_open is null then
    raise exception 'SESSION_CLOSED' using errcode = 'P0001';
  end if;
  update public.sessions set walk_ins_open = p_walk_ins_open where id = v_session.id;
  return jsonb_build_object('status', 'saved', 'walk_ins_open', p_walk_ins_open);
end;
$$;

-- The open session's roster for the host: every entry with how it is shown,
-- who checked in as it and when, and the pending "That's my name" requests.
create function public.list_roster_for_open_session(p_actor_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_session public.sessions;
begin
  select * into v_session from public.sessions
  where social_id = v_social_id and status in ('draft', 'live');
  if not found then
    return jsonb_build_object('status', 'no_open_session');
  end if;
  return jsonb_build_object(
    'status', 'open',
    'session_id', v_session.id,
    'session_status', v_session.status,
    'last_seq', v_session.last_seq,
    'walk_ins_open', v_session.walk_ins_open,
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', label.entry_id,
        'display_name', label.display_name,
        'guest_of_entry_id', label.guest_of_entry_id,
        'guest_of_name', label.guest_of_name,
        'twin_number', label.twin_number,
        'twin_count', label.twin_count,
        'guest_number', label.guest_number,
        'guest_count', label.guest_count,
        'host_note', label.host_note,
        'claimed_at', entry.claimed_at,
        'has_phone', entry.claimed_device_token_hash is not null,
        'participant', case when participant.id is null then null else jsonb_build_object(
          'id', participant.id,
          'first_name', participant.first_name,
          'last_name', participant.last_name
        ) end
      ) order by label.entry_position)
      from private.roster_entry_labels(v_session.id) as label
      join public.session_roster_entries as entry on entry.id = label.entry_id
      left join public.session_participants as participant on participant.id = entry.session_participant_id
    ), '[]'::jsonb),
    'transfer_requests', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', request.id,
        'roster_entry_id', request.roster_entry_id,
        'created_at', request.created_at
      ) order by request.created_at, request.id)
      from public.roster_transfer_requests as request
      where request.session_id = v_session.id and request.status = 'pending'
    ), '[]'::jsonb)
  );
end;
$$;

-- Moves a taken entry to the phone that asked for it (the old phone loses it
-- at once) or keeps it where it is. Deciding twice returns the first decision.
create function public.decide_roster_transfer(
  p_actor_user_id uuid,
  p_transfer_request_id uuid,
  p_should_move boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_request public.roster_transfer_requests;
  v_session public.sessions;
begin
  select * into v_request from public.roster_transfer_requests
  where id = p_transfer_request_id and social_id = v_social_id;
  if not found then
    raise exception 'TRANSFER_REQUEST_NOT_FOUND' using errcode = 'P0002';
  end if;
  v_session := private.lock_social_session(v_social_id, v_request.session_id);
  select * into v_request from public.roster_transfer_requests where id = p_transfer_request_id for update;
  if v_request.status <> 'pending' then
    return jsonb_build_object('status', v_request.status, 'was_already_decided', true);
  end if;
  if p_should_move then
    if exists (
      select 1 from public.session_roster_entries
      where session_id = v_session.id and claimed_device_token_hash = v_request.device_token_hash
    ) then
      raise exception 'PHONE_HAS_OTHER_NAME' using errcode = 'P0001',
        detail = 'That phone has checked in with another name since asking.';
    end if;
    update public.session_roster_entries
    set claimed_device_token_hash = v_request.device_token_hash
    where id = v_request.roster_entry_id and session_participant_id is not null;
    if not found then
      raise exception 'ROSTER_ENTRY_NOT_CLAIMED' using errcode = 'P0001';
    end if;
  end if;
  update public.roster_transfer_requests
  set status = case when p_should_move then 'moved' else 'kept' end::public.roster_transfer_status,
      decided_by = p_actor_user_id,
      decided_at = now()
  where id = v_request.id;
  return jsonb_build_object('status', case when p_should_move then 'moved' else 'kept' end, 'was_already_decided', false);
end;
$$;

-- A host checks in a listed player in person (no phone). Draft: the
-- participant only. Live: also PlayerJoined, with the host's event id and
-- sequence check, like add_participant_mid_session.
create function public.host_check_in_roster_entry(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_roster_entry_id uuid,
  p_session_participant_id uuid,
  p_skill_level public.skill_level,
  p_gender text,
  p_first_name text default null,
  p_last_name text default null,
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
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_session public.sessions := private.lock_social_session(v_social_id, p_session_id);
  v_entry public.session_roster_entries;
  v_participant public.session_participants;
  v_event_result jsonb;
begin
  select * into v_entry from public.session_roster_entries
  where id = p_roster_entry_id and session_id = v_session.id
  for update;
  if not found then
    raise exception 'ROSTER_ENTRY_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_entry.session_participant_id is not null then
    if v_entry.session_participant_id = p_session_participant_id then
      return jsonb_build_object('status', 'already_checked_in_by_this_action');
    end if;
    raise exception 'ROSTER_ENTRY_CHECKED_IN' using errcode = 'P0001';
  end if;
  if v_session.status not in ('draft', 'live') then
    raise exception 'SESSION_CLOSED' using errcode = 'P0001';
  end if;
  if v_session.status = 'live' and (p_event_id is null or p_expected_last_seq is null or p_occurred_at is null) then
    raise exception 'EVENT_REQUIRED' using errcode = '22023';
  end if;
  if v_session.status = 'live' and exists (select 1 from public.session_events where event_id = p_event_id) then
    raise exception 'EVENT_ID_REUSED' using errcode = '22023';
  end if;

  v_participant := private.insert_roster_participant(
    v_session, v_entry, p_session_participant_id, p_first_name, p_last_name, p_skill_level, p_gender
  );
  update public.session_roster_entries
  set session_participant_id = v_participant.id, claimed_at = now()
  where id = v_entry.id;
  if v_session.status = 'live' then
    v_event_result := private.insert_session_event(
      v_session, p_event_id, p_expected_last_seq, 'PlayerJoined',
      private.player_joined_payload(v_participant), p_occurred_at, p_actor_user_id
    );
  end if;
  return jsonb_build_object('status', 'checked_in', 'session_participant_id', v_participant.id, 'event', v_event_result);
end;
$$;

-- ---------------------------------------------------------------------------
-- Public check-in page: find a name, claim it, ask for a taken one
-- ---------------------------------------------------------------------------

-- At most 5 roster names matching a word start; nothing under 2 characters.
-- Names only: whether someone has arrived is never shown, except that a
-- numbered same-name entry already taken is marked in use (so each twin taps
-- their own; approved by Ryan, 2026-11-26).
create function public.search_roster_entries(
  p_checkin_tag text,
  p_expected_session_id uuid,
  p_name_query text,
  p_device_token_hash text,
  p_ip_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_session public.sessions;
  v_query text := private.normalise_name_for_search(p_name_query);
begin
  perform private.require_valid_client_identity(p_device_token_hash, p_ip_hash);
  v_session := private.lock_checkin_session(p_checkin_tag, p_expected_session_id);
  if char_length(v_query) < 2 or char_length(v_query) > 50 then
    return '[]'::jsonb;
  end if;
  perform private.record_checkin_attempt('search', v_session.id, p_device_token_hash, p_ip_hash, 120, 1000, 3000);
  return coalesce((
    select jsonb_agg(found_entry.result order by found_entry.search_name, found_entry.entry_position)
    from (
      select jsonb_build_object(
          'id', label.entry_id,
          'display_name', label.display_name,
          'guest_of_name', label.guest_of_name,
          'twin_number', label.twin_number,
          'twin_count', label.twin_count,
          'guest_number', label.guest_number,
          'guest_count', label.guest_count,
          'host_note', label.host_note,
          'is_in_use', label.twin_count > 1 and label.guest_of_entry_id is null
            and entry.session_participant_id is not null
        ) as result,
        label.search_name,
        label.entry_position
      from private.roster_entry_labels(v_session.id) as label
      join public.session_roster_entries as entry on entry.id = label.entry_id
      where ' ' || label.search_name like '% ' || replace(replace(v_query, '%', ''), '_', '') || '%'
      order by label.search_name, label.entry_position
      limit 5
    ) as found_entry
  ), '[]'::jsonb);
end;
$$;

-- Claims a roster entry for this phone: no host approval. Outcomes:
-- claimed / already_yours / in_use / phone_has_other_name / already_checked_in.
create function public.claim_roster_entry(
  p_checkin_tag text,
  p_expected_session_id uuid,
  p_roster_entry_id uuid,
  p_device_token_hash text,
  p_ip_hash text,
  p_skill_level public.skill_level,
  p_gender text,
  p_first_name text default null,
  p_last_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.sessions;
  v_entry public.session_roster_entries;
  v_other public.session_roster_entries;
  v_participant public.session_participants;
begin
  perform private.require_valid_client_identity(p_device_token_hash, p_ip_hash);
  v_session := private.lock_checkin_session(p_checkin_tag, p_expected_session_id);
  -- One venue Wi-Fi serves everyone arriving: the network limit is high.
  perform private.record_checkin_attempt('claim', v_session.id, p_device_token_hash, p_ip_hash, 20, 400, 800);

  select * into v_entry from public.session_roster_entries
  where id = p_roster_entry_id and session_id = v_session.id
  for update;
  if not found then
    raise exception 'ROSTER_ENTRY_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_entry.claimed_device_token_hash = p_device_token_hash then
    return jsonb_build_object('status', 'already_yours');
  end if;
  select * into v_other from public.session_roster_entries
  where session_id = v_session.id and claimed_device_token_hash = p_device_token_hash;
  if found then
    return jsonb_build_object('status', 'phone_has_other_name');
  end if;
  if exists (
    select 1 from public.checkin_requests
    where session_id = v_session.id and device_token_hash = p_device_token_hash and status = 'approved'
  ) then
    return jsonb_build_object('status', 'already_checked_in');
  end if;
  if v_entry.session_participant_id is not null then
    return jsonb_build_object('status', 'in_use');
  end if;

  v_participant := private.insert_roster_participant(
    v_session, v_entry, gen_random_uuid(), p_first_name, p_last_name, p_skill_level, p_gender
  );
  update public.session_roster_entries
  set session_participant_id = v_participant.id,
      claimed_device_token_hash = p_device_token_hash,
      claimed_at = now()
  where id = v_entry.id;
  -- This phone no longer needs any earlier "That's my name" request.
  update public.roster_transfer_requests set status = 'withdrawn'
  where session_id = v_session.id and device_token_hash = p_device_token_hash and status = 'pending';
  if v_session.status = 'live' then
    perform private.insert_player_session_event(
      v_session, 'PlayerJoined', private.player_joined_payload(v_participant), v_participant.id
    );
  end if;
  return jsonb_build_object('status', 'claimed');
end;
$$;

-- "That's my name" on a taken entry: asks the host. One open request per phone.
-- Outcomes: requested / already_yours / not_in_use / phone_has_other_name.
create function public.request_roster_transfer(
  p_checkin_tag text,
  p_expected_session_id uuid,
  p_roster_entry_id uuid,
  p_device_token_hash text,
  p_ip_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.sessions;
  v_entry public.session_roster_entries;
begin
  perform private.require_valid_client_identity(p_device_token_hash, p_ip_hash);
  v_session := private.lock_checkin_session(p_checkin_tag, p_expected_session_id);
  perform private.record_checkin_attempt('claim', v_session.id, p_device_token_hash, p_ip_hash, 20, 400, 800);

  select * into v_entry from public.session_roster_entries
  where id = p_roster_entry_id and session_id = v_session.id;
  if not found then
    raise exception 'ROSTER_ENTRY_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_entry.claimed_device_token_hash = p_device_token_hash then
    return jsonb_build_object('status', 'already_yours');
  end if;
  if v_entry.session_participant_id is null then
    return jsonb_build_object('status', 'not_in_use');
  end if;
  if exists (
    select 1 from public.session_roster_entries
    where session_id = v_session.id and claimed_device_token_hash = p_device_token_hash
  ) then
    return jsonb_build_object('status', 'phone_has_other_name');
  end if;
  if exists (
    select 1 from public.roster_transfer_requests
    where session_id = v_session.id and device_token_hash = p_device_token_hash
      and roster_entry_id = v_entry.id and status = 'pending'
  ) then
    return jsonb_build_object('status', 'requested');
  end if;
  update public.roster_transfer_requests set status = 'withdrawn'
  where session_id = v_session.id and device_token_hash = p_device_token_hash and status = 'pending';
  insert into public.roster_transfer_requests (session_id, social_id, roster_entry_id, device_token_hash)
  values (v_session.id, v_session.social_id, v_entry.id, p_device_token_hash);
  return jsonb_build_object('status', 'requested');
end;
$$;

-- Walk-ins (not on the list) can be closed by the host. Otherwise unchanged
-- from 20261115100000.
create or replace function public.submit_checkin(
  p_checkin_tag text,
  p_expected_session_id uuid,
  p_device_token_hash text,
  p_ip_hash text,
  p_first_name text,
  p_last_name text,
  p_skill_level public.skill_level,
  p_gender text
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
  if p_gender is null or p_gender not in ('male', 'female') then
    raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'Choose male or female.';
  end if;
  v_session := private.lock_checkin_session(p_checkin_tag, p_expected_session_id);

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

  if not v_session.walk_ins_open then
    raise exception 'WALK_INS_CLOSED' using errcode = 'P0001';
  end if;

  begin
    insert into public.checkin_requests (
      session_id, social_id, first_name, last_name, skill_level, gender, device_token_hash, ip_hash
    )
    values (
      v_session.id, v_session.social_id, v_first_name, v_last_name, p_skill_level, p_gender, p_device_token_hash, p_ip_hash
    )
    returning id into v_request_id;
  exception when unique_violation then
    select id into strict v_request_id
    from public.checkin_requests
    where session_id = v_session.id and device_token_hash = p_device_token_hash and status = 'pending';
    return jsonb_build_object('status', 'pending', 'checkin_request_id', v_request_id, 'was_already_pending', true);
  end;

  return jsonb_build_object('status', 'pending', 'checkin_request_id', v_request_id, 'was_already_pending', false);
end;
$$;

-- Adds the roster state to the page read (from 20261115120000):
-- has_roster, walk_ins_open, and for this phone its claimed name or its
-- latest "That's my name" request.
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
  v_roster_claim jsonb;
  v_transfer_request jsonb;
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

  select * into v_session
  from public.sessions
  where social_id = v_social.id
    and status in ('draft', 'live')
    and checkin_open;
  if v_session.id is null then
    return jsonb_build_object('status', 'no_open_session', 'social_name', v_social.name);
  end if;

  v_duration_minutes := extract(epoch from (v_session.planned_end - v_session.planned_start)) / 60;
  if v_session.status = 'live'
     and jsonb_typeof(v_session.config_snapshot -> 'plannedDurationMinutes') = 'number' then
    v_duration_minutes := (v_session.config_snapshot ->> 'plannedDurationMinutes')::numeric;
  end if;
  if v_duration_minutes < 1 or v_duration_minutes > 720 then
    v_duration_minutes := null;
  end if;
  if v_session.status = 'live' and v_session.started_at is not null
     and v_duration_minutes is not null then
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

    select jsonb_build_object(
      'roster_entry_id', entry.id,
      'first_name', participant.first_name,
      'last_name', participant.last_name
    ) into v_roster_claim
    from public.session_roster_entries as entry
    join public.session_participants as participant on participant.id = entry.session_participant_id
    where entry.session_id = v_session.id and entry.claimed_device_token_hash = p_device_token_hash;

    select jsonb_build_object(
      'id', request.id,
      'status', request.status,
      'roster_entry_id', request.roster_entry_id,
      'display_name', label.display_name,
      'guest_of_name', label.guest_of_name,
      'twin_number', label.twin_number,
      'twin_count', label.twin_count,
      'guest_number', label.guest_number,
      'guest_count', label.guest_count
    ) into v_transfer_request
    from public.roster_transfer_requests as request
    join private.roster_entry_labels(v_session.id) as label on label.entry_id = request.roster_entry_id
    where request.session_id = v_session.id
      and request.device_token_hash = p_device_token_hash
      and request.status <> 'withdrawn'
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
      'courts_count', case
        when jsonb_typeof(v_session.config_snapshot -> 'courts') = 'array'
          then jsonb_array_length(v_session.config_snapshot -> 'courts')
        else 0
      end,
      'checked_in_count', (
        select count(*) from public.session_participants where session_id = v_session.id
      ),
      'has_roster', exists (select 1 from public.session_roster_entries where session_id = v_session.id),
      'walk_ins_open', v_session.walk_ins_open
    ),
    'current_request', v_current_request,
    'roster_claim', v_roster_claim,
    'roster_transfer_request', v_transfer_request,
    'now', now()
  );
end;
$$;

-- Removing a draft participant who checked in from the roster frees the name
-- again (the entry stays on the list). Otherwise unchanged from 20261110150000.
create or replace function public.remove_draft_participant(p_actor_user_id uuid, p_session_participant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_session_id uuid;
  v_session public.sessions;
begin
  select session_id into v_session_id
  from public.session_participants
  where id = p_session_participant_id and social_id = v_social_id;
  if not found then
    raise exception 'PARTICIPANT_NOT_FOUND' using errcode = 'P0002',
      detail = format('No session participant %s.', p_session_participant_id);
  end if;
  v_session := private.lock_social_session(v_social_id, v_session_id);
  if v_session.status <> 'draft' then
    raise exception 'SESSION_NOT_DRAFT' using errcode = 'P0001',
      detail = format('Participants can only be removed from a draft; session %s is %s.', v_session_id, v_session.status);
  end if;

  update public.checkin_requests
  set status = 'withdrawn', session_participant_id = null
  where session_participant_id = p_session_participant_id;
  update public.roster_transfer_requests set status = 'withdrawn'
  where status = 'pending' and roster_entry_id in (
    select id from public.session_roster_entries where session_participant_id = p_session_participant_id
  );
  update public.session_roster_entries
  set session_participant_id = null, claimed_device_token_hash = null, claimed_at = null
  where session_participant_id = p_session_participant_id;
  delete from public.session_participants where id = p_session_participant_id;
  return jsonb_build_object('status', 'removed');
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: service_role only (decision 0002); helpers for nobody.
-- ---------------------------------------------------------------------------

revoke all on function public.import_roster_entries(uuid, uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.import_roster_entries(uuid, uuid, integer, jsonb) to service_role;
revoke all on function public.remove_roster_entry(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.remove_roster_entry(uuid, uuid, uuid) to service_role;
revoke all on function public.set_roster_entry_note(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.set_roster_entry_note(uuid, uuid, uuid, text) to service_role;
revoke all on function public.set_walk_ins_open(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_walk_ins_open(uuid, uuid, boolean) to service_role;
revoke all on function public.list_roster_for_open_session(uuid) from public, anon, authenticated;
grant execute on function public.list_roster_for_open_session(uuid) to service_role;
revoke all on function public.decide_roster_transfer(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.decide_roster_transfer(uuid, uuid, boolean) to service_role;
revoke all on function public.host_check_in_roster_entry(uuid, uuid, uuid, uuid, public.skill_level, text, text, text, uuid, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.host_check_in_roster_entry(uuid, uuid, uuid, uuid, public.skill_level, text, text, text, uuid, integer, timestamptz) to service_role;
revoke all on function public.search_roster_entries(text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.search_roster_entries(text, uuid, text, text, text) to service_role;
revoke all on function public.claim_roster_entry(text, uuid, uuid, text, text, public.skill_level, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_roster_entry(text, uuid, uuid, text, text, public.skill_level, text, text, text) to service_role;
revoke all on function public.request_roster_transfer(text, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.request_roster_transfer(text, uuid, uuid, text, text) to service_role;

revoke all on function private.roster_entry_labels(uuid) from public, anon, authenticated, service_role;
revoke all on function private.lock_checkin_session(text, uuid) from public, anon, authenticated, service_role;
revoke all on function private.insert_player_session_event(public.sessions, public.session_event_type, jsonb, uuid) from public, anon, authenticated, service_role;
revoke all on function private.insert_roster_participant(public.sessions, public.session_roster_entries, uuid, text, text, public.skill_level, text) from public, anon, authenticated, service_role;
