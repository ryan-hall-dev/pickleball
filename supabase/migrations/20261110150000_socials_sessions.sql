-- M4.5 increment A3: sessions belong to one social. Plan: docs/plans/socials.md
-- §1-§3, §8 A3. Decision: docs/decisions/0003-socials-and-data-isolation.md.
--
-- This increment:
--   * adds `social_id` (not null, immutable) to sessions, session_participants,
--     checkin_requests and saved_setups, backfilled into the default social;
--   * sessions get `unique (id, social_id)`, the target of composite foreign
--     keys. session_participants and checkin_requests point at
--     `(session_id, social_id)` and `(member_id, social_id)`, which REPLACE
--     the single-column FKs (keeping both would make PostgREST embeds such as
--     setupDraft's `members(is_active)` ambiguous, PGRST201). The database
--     then refuses any participant or request that links two socials;
--   * at most one open (draft or live) session per social
--     (`sessions_one_open_per_social_idx`) replaces one per host. Every host of
--     the social edits, runs and approves check-ins for it (co-editing: the
--     M4.4 draft_revision check protects concurrent settings writes);
--   * saved setups are the social's: names unique per social, `host_id` is
--     only "saved by" and becomes null when that host is removed;
--   * RLS: the caller's own social only; session_events and matches through
--     their session. private.is_host() is dropped (no policy uses it now);
--   * write functions derive the actor's social from p_actor_user_id (never
--     from an argument) and only touch that social's rows. New helpers
--     lock_social_session / lock_social_open_draft replace lock_session,
--     lock_own_open_draft and require_host (dropped), and sessions.social_id
--     replaces private.session_social_id (dropped).
--
-- Backfill (plan §1), only when sessions or saved setups exist, and only
-- into the single default social (refuses with several socials or none):
--   1. The surviving open session is chosen FIRST, before any update:
--      one created by a manager of the social first, then live, then one
--      whose creating host still exists, then the most recently updated,
--      then id. Managers first (Ryan, 2026-11-09): leftover open sessions
--      on local/dev come from test hosts, while a manager's session is real
--      work worth keeping, even a draft over a test's live session. The
--      updated_at triggers are disabled for the backfill so untouched rows
--      keep their real updated_at.
--   2. social_id is set on every row.
--   3. Every other open session is closed: drafts become `cancelled`; live
--      sessions are ended THROUGH THE LOG so `state = replay(events)` stays
--      true. A paused session first gets `Resumed` (the engine refuses to
--      abandon a match while paused); matches still in progress get a
--      `MatchAbandoned` event and their `abandoned` matches row (the engine
--      refuses SessionEnded while a match is in progress); then
--      `SessionEnded` (payload {}), exactly as
--      end_session would: seq = last_seq + 1, occurred_at =
--      greatest(last event time, now()), last_seq bumped, status `ended`.
--      The appended events carry the migration actor id
--      00000000-0000-0000-0000-000000000000 (no such user; the log has no FK
--      on actor_user_id). A live session with no log at all (last_seq 0,
--      only ever made by tests writing rows directly) has nothing to replay:
--      it just becomes `ended`. Every closed id is raised as a NOTICE.
--   4. Saved setups whose names clash within the social: the most recently
--      used keeps its name, the others become `left(name, 74) || ' (n)'`
--      with the first free n from 2 (stays within short_label's 80).

-- ---------------------------------------------------------------------------
-- Columns, with the backfill in between nullable and not null
-- ---------------------------------------------------------------------------

alter table public.sessions add column social_id uuid;
alter table public.session_participants add column social_id uuid;
alter table public.checkin_requests add column social_id uuid;
alter table public.saved_setups add column social_id uuid;

-- Replays a live session's log far enough to know its matches in progress
-- (lineup, start, court) and its pauses, then resumes if paused, abandons
-- those matches and ends the session, appending the events the engine would. Mirrors
-- src/engine/session (matchHandlers.ts, sessionHandlers.ts, metrics.ts
-- matchRecords). Backfill only: dropped at the end of this migration.
-- Returns the number of matches it abandoned.
create function pg_temp.end_live_session_through_log(p_session_id uuid, p_actor_user_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_session public.sessions;
  v_event public.session_events;
  v_target_payload jsonb;
  v_assignment jsonb;
  -- matchId -> { courtId, startedAt, startedAtMs, startedBySeq, status, segments[] }
  v_matches jsonb := '{}'::jsonb;
  -- courtId -> name
  v_court_names jsonb := '{}'::jsonb;
  -- [{ fromMs, toMs }] (toMs null while the pause is in effect)
  v_pauses jsonb := '[]'::jsonb;
  v_match_id text;
  v_match jsonb;
  v_out_team text;
  v_closed_at timestamptz;
  v_closed_at_ms numeric;
  v_event_ms numeric;
  v_started_ms numeric;
  v_paused_ms numeric;
  v_seq integer;
  v_abandoned_count integer := 0;
  v_written_count integer;
begin
  select * into strict v_session from public.sessions where id = p_session_id for update;
  if v_session.status <> 'live' then
    raise exception 'BACKFILL_SESSION_NOT_LIVE' using detail = format('Session %s is %s.', p_session_id, v_session.status);
  end if;

  for v_event in
    select * from public.session_events where session_id = p_session_id order by seq
  loop
    v_event_ms := floor(extract(epoch from v_event.occurred_at) * 1000);
    if v_event.payload ? 'targetSeq' then
      select payload into v_target_payload
      from public.session_events
      where session_id = p_session_id and seq = (v_event.payload ->> 'targetSeq')::integer;
    else
      v_target_payload := null;
    end if;

    case v_event.type
      when 'SessionStarted', 'MatchStarted' then
        if v_event.type = 'SessionStarted' then
          select coalesce(jsonb_object_agg(court ->> 'courtId', court ->> 'name'), '{}'::jsonb)
          into v_court_names
          from jsonb_array_elements(coalesce(v_event.payload #> '{config,courts}', '[]'::jsonb)) as court;
        end if;
        for v_assignment in
          select assignment
          from jsonb_array_elements(
            case when v_event.type = 'SessionStarted'
              then coalesce(v_event.payload -> 'initialMatches', '[]'::jsonb)
              else jsonb_build_array(v_event.payload)
            end
          ) as assignment
        loop
          v_matches := v_matches || jsonb_build_object(
            v_assignment ->> 'matchId',
            jsonb_build_object(
              'courtId', v_assignment ->> 'courtId',
              'startedAt', v_event.occurred_at,
              'startedAtMs', v_event_ms,
              'startedBySeq', v_event.seq,
              'status', 'active',
              'segments', (
                select coalesce(jsonb_agg(
                  jsonb_build_object(
                    'participantId', seat.participant_id,
                    'team', seat.team,
                    'startedByReplacementSeq', null,
                    'endedMidMatchBySeq', null
                  ) order by seat.team, seat.position
                ), '[]'::jsonb)
                from (
                  select 'A' as team, position, participant_id
                  from jsonb_array_elements_text(v_assignment -> 'teamA') with ordinality as team_a (participant_id, position)
                  union all
                  select 'B', position, participant_id
                  from jsonb_array_elements_text(v_assignment -> 'teamB') with ordinality as team_b (participant_id, position)
                ) as seat
              )
            )
          );
        end loop;

      when 'CourtAdded' then
        v_court_names := v_court_names
          || jsonb_build_object(v_event.payload #>> '{court,courtId}', v_event.payload #>> '{court,name}');

      when 'MatchStartReverted' then
        v_matches := v_matches - coalesce(v_event.payload ->> 'matchId', v_target_payload ->> 'matchId');

      when 'MatchCompleted', 'MatchAbandoned' then
        v_matches := jsonb_set(
          v_matches, array[v_event.payload ->> 'matchId', 'status'],
          to_jsonb(case when v_event.type = 'MatchCompleted' then 'completed' else 'abandoned' end)
        );

      when 'MatchCompletionReverted', 'MatchAbandonReverted' then
        v_matches := jsonb_set(v_matches, array[v_target_payload ->> 'matchId', 'status'], '"active"');

      when 'PlayerReplaced', 'PlayerRemovedMidMatch' then
        v_match_id := v_event.payload ->> 'matchId';
        v_match := v_matches -> v_match_id;
        -- The seat being vacated: the player's segment still on court.
        select segment ->> 'team' into v_out_team
        from jsonb_array_elements(v_match -> 'segments') as segment
        where segment ->> 'participantId' = coalesce(v_event.payload ->> 'outId', v_event.payload ->> 'participantId')
          and jsonb_typeof(segment -> 'endedMidMatchBySeq') = 'null';
        select jsonb_agg(
          case when segment ->> 'participantId' = coalesce(v_event.payload ->> 'outId', v_event.payload ->> 'participantId')
              and jsonb_typeof(segment -> 'endedMidMatchBySeq') = 'null'
            then jsonb_set(segment, '{endedMidMatchBySeq}', to_jsonb(v_event.seq))
            else segment
          end order by position
        ) into v_match
        from jsonb_array_elements(v_match -> 'segments') with ordinality as segments (segment, position);
        if v_event.type = 'PlayerReplaced' then
          v_match := v_match || jsonb_build_array(jsonb_build_object(
            'participantId', v_event.payload ->> 'inId',
            'team', v_out_team,
            'startedByReplacementSeq', v_event.seq,
            'endedMidMatchBySeq', null
          ));
        end if;
        v_matches := jsonb_set(v_matches, array[v_match_id, 'segments'], v_match);

      when 'PlayerReplacementReverted', 'PlayerRemovalReverted' then
        v_match_id := v_target_payload ->> 'matchId';
        -- The player taken off goes back in their seat; a replacement's
        -- incoming segment is dropped.
        select coalesce(jsonb_agg(
          case when (segment ->> 'endedMidMatchBySeq')::integer = (v_event.payload ->> 'targetSeq')::integer
            then jsonb_set(segment, '{endedMidMatchBySeq}', 'null')
            else segment
          end order by position
        ), '[]'::jsonb) into v_match
        from jsonb_array_elements(v_matches #> array[v_match_id, 'segments']) with ordinality as segments (segment, position)
        where (segment ->> 'startedByReplacementSeq') is distinct from (v_event.payload ->> 'targetSeq');
        v_matches := jsonb_set(v_matches, array[v_match_id, 'segments'], v_match);

      when 'Paused' then
        v_pauses := v_pauses || jsonb_build_array(jsonb_build_object('fromMs', v_event_ms, 'toMs', null));

      when 'Resumed' then
        v_pauses := jsonb_set(v_pauses, array[(jsonb_array_length(v_pauses) - 1)::text, 'toMs'], to_jsonb(v_event_ms));

      when 'SessionEnded' then
        raise exception 'BACKFILL_LOG_ALREADY_ENDED' using detail = format('Session %s is live but its log has ended.', p_session_id);

      else
        -- Player presence, skips, locks, court closures, queue order and
        -- shuffles don't change which matches are in progress or their lineups.
        null;
    end case;
  end loop;

  -- The same time rule as insert_session_event: never before the last event.
  -- Millisecond precision, like every event the server writes (JS dates).
  v_closed_at := greatest(
    (select max(occurred_at) from public.session_events where session_id = p_session_id),
    date_trunc('milliseconds', now())
  );
  v_closed_at_ms := floor(extract(epoch from v_closed_at) * 1000);
  v_seq := v_session.last_seq;

  -- The engine refuses to abandon a match while paused: resume first, as a
  -- host would. The pause then ends at the closing time.
  if jsonb_array_length(v_pauses) > 0 and jsonb_typeof(v_pauses -> -1 -> 'toMs') = 'null' then
    v_seq := v_seq + 1;
    insert into public.session_events (session_id, seq, event_id, type, payload, occurred_at, actor_user_id)
    values (p_session_id, v_seq, gen_random_uuid(), 'Resumed', '{}'::jsonb, v_closed_at, p_actor_user_id);
  end if;

  for v_match_id, v_match in
    select match_id, match_state
    from jsonb_each(v_matches) as each_match (match_id, match_state)
    where match_state ->> 'status' = 'active'
    order by (match_state ->> 'startedBySeq')::integer, match_id
  loop
    v_seq := v_seq + 1;
    insert into public.session_events (session_id, seq, event_id, type, payload, occurred_at, actor_user_id)
    values (
      p_session_id, v_seq, gen_random_uuid(), 'MatchAbandoned',
      jsonb_build_object('matchId', v_match_id), v_closed_at, p_actor_user_id
    );

    -- Active (unpaused) play time, as matchRecords' activeDurationMs: the
    -- match's span minus its overlap with pauses (open ones run to the end).
    v_started_ms := (v_match ->> 'startedAtMs')::numeric;
    select coalesce(sum(greatest(
      0,
      least(v_closed_at_ms, coalesce((pause ->> 'toMs')::numeric, v_closed_at_ms))
        - greatest(v_started_ms, (pause ->> 'fromMs')::numeric)
    )), 0) into v_paused_ms
    from jsonb_array_elements(v_pauses) as pause;

    insert into public.matches as existing (
      id, session_id, court_id, court_name, team_a, team_b,
      started_at, ended_at, duration_seconds, status
    )
    select
      v_match_id::uuid,
      p_session_id,
      (v_match ->> 'courtId')::uuid,
      coalesce(v_court_names ->> (v_match ->> 'courtId'), ''),
      array(
        select segment ->> 'participantId'
        from jsonb_array_elements(v_match -> 'segments') with ordinality as segments (segment, position)
        where segment ->> 'team' = 'A' and jsonb_typeof(segment -> 'endedMidMatchBySeq') = 'null'
        order by position
      )::uuid[],
      array(
        select segment ->> 'participantId'
        from jsonb_array_elements(v_match -> 'segments') with ordinality as segments (segment, position)
        where segment ->> 'team' = 'B' and jsonb_typeof(segment -> 'endedMidMatchBySeq') = 'null'
        order by position
      )::uuid[],
      date_trunc('milliseconds', (v_match ->> 'startedAt')::timestamptz),
      v_closed_at,
      round((v_closed_at_ms - v_started_ms - v_paused_ms) / 1000)::integer,
      'abandoned'
    on conflict (id) do update set
      court_id = excluded.court_id,
      court_name = excluded.court_name,
      team_a = excluded.team_a,
      team_b = excluded.team_b,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      duration_seconds = excluded.duration_seconds,
      status = excluded.status
    where existing.session_id = excluded.session_id;
    get diagnostics v_written_count = row_count;
    if v_written_count = 0 then
      raise exception 'BACKFILL_MATCH_ROW_CONFLICT' using detail = format('Match %s belongs to another session.', v_match_id);
    end if;
    v_abandoned_count := v_abandoned_count + 1;
  end loop;

  v_seq := v_seq + 1;
  insert into public.session_events (session_id, seq, event_id, type, payload, occurred_at, actor_user_id)
  values (p_session_id, v_seq, gen_random_uuid(), 'SessionEnded', '{}'::jsonb, v_closed_at, p_actor_user_id);
  update public.sessions
  set status = 'ended', ended_at = v_closed_at, last_seq = v_seq, updated_at = now()
  where id = p_session_id;
  return v_abandoned_count;
end;
$$;

do $$
declare
  c_migration_actor_user_id constant uuid := '00000000-0000-0000-0000-000000000000';
  v_social_count integer;
  v_default_social_id uuid;
  v_surviving_session_id uuid;
  v_closing public.sessions;
  v_abandoned_count integer;
  v_setup record;
  v_suffix integer;
  v_new_name text;
begin
  if not (
    exists (select 1 from public.sessions)
    or exists (select 1 from public.saved_setups)
  ) then
    return;
  end if;

  select count(*) into v_social_count from public.socials;
  if v_social_count <> 1 then
    raise exception 'SESSIONS_BACKFILL_AMBIGUOUS' using errcode = 'P0001',
      detail = format(
        'Sessions or saved setups exist but there are %s socials; expected exactly the default one. '
        'Remove the extra (empty) socials, or assign social_id by hand, then rerun.',
        v_social_count
      );
  end if;
  select id into v_default_social_id from public.socials;

  -- 1. The survivor, chosen before any update touches updated_at.
  select open_session.id into v_surviving_session_id
  from public.sessions as open_session
  left join public.hosts as creator on creator.user_id = open_session.host_id
  where open_session.status in ('draft', 'live')
  order by
    (creator.role = 'manager') is true desc,
    (open_session.status = 'live') desc,
    (open_session.host_id is not null) desc,
    open_session.updated_at desc,
    open_session.id
  limit 1;

  -- Keep each untouched row's real updated_at; rows this backfill closes or
  -- renames set it explicitly.
  alter table public.sessions disable trigger sessions_set_updated_at;
  alter table public.saved_setups disable trigger saved_setups_set_updated_at;

  -- 2. Everything moves into the default social.
  update public.sessions set social_id = v_default_social_id;
  update public.session_participants set social_id = v_default_social_id;
  update public.checkin_requests set social_id = v_default_social_id;
  update public.saved_setups set social_id = v_default_social_id;

  -- 3. One open session per social: close the others.
  if v_surviving_session_id is not null then
    raise notice 'Open session % survives.', v_surviving_session_id;
  end if;
  for v_closing in
    select * from public.sessions
    where status in ('draft', 'live') and id is distinct from v_surviving_session_id
    order by created_at, id
  loop
    if v_closing.status = 'draft' then
      update public.sessions set status = 'cancelled', updated_at = now() where id = v_closing.id;
      raise notice 'Draft session % cancelled.', v_closing.id;
    elsif v_closing.last_seq = 0 then
      update public.sessions
      set status = 'ended', ended_at = greatest(started_at, now()), updated_at = now()
      where id = v_closing.id;
      raise notice 'Live session % (no log) ended.', v_closing.id;
    else
      v_abandoned_count := pg_temp.end_live_session_through_log(v_closing.id, c_migration_actor_user_id);
      raise notice 'Live session % ended through its log (% match(es) abandoned).', v_closing.id, v_abandoned_count;
    end if;
  end loop;

  -- 4. Saved setup names unique per social: the most recently used keeps it.
  for v_setup in
    select id, name
    from (
      select id, name,
        row_number() over (
          partition by social_id, lower(btrim(name))
          order by last_used_at desc, id
        ) as name_rank
      from public.saved_setups
    ) as ranked
    where name_rank > 1
    order by lower(btrim(name)), name_rank
  loop
    v_suffix := 2;
    loop
      v_new_name := left(v_setup.name, 74) || ' (' || v_suffix || ')';
      exit when not exists (
        select 1 from public.saved_setups
        where social_id = v_default_social_id and lower(btrim(name)) = lower(btrim(v_new_name))
      );
      v_suffix := v_suffix + 1;
    end loop;
    update public.saved_setups set name = v_new_name, updated_at = now() where id = v_setup.id;
    raise notice 'Saved setup % renamed from "%" to "%".', v_setup.id, v_setup.name, v_new_name;
  end loop;

  alter table public.sessions enable trigger sessions_set_updated_at;
  alter table public.saved_setups enable trigger saved_setups_set_updated_at;
end;
$$;

drop function pg_temp.end_live_session_through_log(uuid, uuid);

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------

alter table public.sessions
  alter column social_id set not null,
  add constraint sessions_social_id_fkey foreign key (social_id) references public.socials (id) on delete restrict,
  -- Composite FK target: a row pointing at (session, social) can only name a
  -- session of that social.
  add constraint sessions_id_social_id_key unique (id, social_id);

-- One open (draft or live) session per social, so `/t/<tag>` is never
-- ambiguous and the social's hosts all work on the same one.
drop index public.sessions_one_open_per_host_idx;
create unique index sessions_one_open_per_social_idx
  on public.sessions (social_id)
  where status in ('draft', 'live');
create index sessions_social_status_planned_start_idx on public.sessions (social_id, status, planned_start desc);
-- Serves `on delete set null` when a host is removed (the open-per-host index did before).
create index sessions_host_id_idx on public.sessions (host_id);

-- ---------------------------------------------------------------------------
-- Participants and check-in requests: their session and member are the same social's
-- ---------------------------------------------------------------------------

-- Guests (member_id null) skip the member check (MATCH SIMPLE).
alter table public.session_participants
  alter column social_id set not null,
  drop constraint session_participants_session_id_fkey,
  drop constraint session_participants_member_id_fkey,
  add constraint session_participants_session_id_social_id_fkey
    foreign key (session_id, social_id) references public.sessions (id, social_id),
  add constraint session_participants_member_id_social_id_fkey
    foreign key (member_id, social_id) references public.members (id, social_id);

-- First-timers (member_id null until approval) skip the member check.
alter table public.checkin_requests
  alter column social_id set not null,
  drop constraint checkin_requests_session_id_fkey,
  drop constraint checkin_requests_member_id_fkey,
  add constraint checkin_requests_session_id_social_id_fkey
    foreign key (session_id, social_id) references public.sessions (id, social_id),
  add constraint checkin_requests_member_id_social_id_fkey
    foreign key (member_id, social_id) references public.members (id, social_id);

-- ---------------------------------------------------------------------------
-- Saved setups: the social's, any of its hosts saves and applies them
-- ---------------------------------------------------------------------------

alter table public.saved_setups
  alter column social_id set not null,
  add constraint saved_setups_social_id_fkey foreign key (social_id) references public.socials (id) on delete restrict,
  -- "Saved by": a removed host's setups stay with the social.
  alter column host_id drop not null,
  drop constraint saved_setups_host_id_fkey,
  add constraint saved_setups_host_id_fkey
    foreign key (host_id) references public.hosts (user_id) on delete set null;

-- "Saturday Social" and "saturday social " are the same setup within a social.
drop index public.saved_setups_host_name_unique_idx;
create unique index saved_setups_social_name_unique_idx
  on public.saved_setups (social_id, lower(btrim(name)));
-- "Reuse last" = the social's most recently used setup.
drop index public.saved_setups_host_recent_idx;
create index saved_setups_social_recent_idx on public.saved_setups (social_id, last_used_at desc);
create index saved_setups_host_id_idx on public.saved_setups (host_id);

-- ---------------------------------------------------------------------------
-- A row never moves to another social
-- ---------------------------------------------------------------------------

create trigger sessions_reject_social_id_change
  before update of social_id on public.sessions
  for each row
  when (old.social_id is distinct from new.social_id)
  execute function private.reject_social_id_change();

create trigger session_participants_reject_social_id_change
  before update of social_id on public.session_participants
  for each row
  when (old.social_id is distinct from new.social_id)
  execute function private.reject_social_id_change();

create trigger checkin_requests_reject_social_id_change
  before update of social_id on public.checkin_requests
  for each row
  when (old.social_id is distinct from new.social_id)
  execute function private.reject_social_id_change();

create trigger saved_setups_reject_social_id_change
  before update of social_id on public.saved_setups
  for each row
  when (old.social_id is distinct from new.social_id)
  execute function private.reject_social_id_change();

-- ---------------------------------------------------------------------------
-- RLS: a host reads only their own social's sessions and everything under them
-- ---------------------------------------------------------------------------

drop policy sessions_select_hosts on public.sessions;
create policy sessions_select_own_social on public.sessions
  for select to authenticated using (social_id = (select private.current_social_id()));

drop policy session_participants_select_hosts on public.session_participants;
create policy session_participants_select_own_social on public.session_participants
  for select to authenticated using (social_id = (select private.current_social_id()));

drop policy checkin_requests_select_hosts on public.checkin_requests;
create policy checkin_requests_select_own_social on public.checkin_requests
  for select to authenticated using (social_id = (select private.current_social_id()));

drop policy saved_setups_select_own on public.saved_setups;
create policy saved_setups_select_own_social on public.saved_setups
  for select to authenticated using (social_id = (select private.current_social_id()));

-- The log and match rows have no social_id (the append-only log is never
-- rewritten): they belong to their session's social.
drop policy session_events_select_hosts on public.session_events;
create policy session_events_select_own_social on public.session_events
  for select to authenticated using (
    exists (
      select 1 from public.sessions as session
      where session.id = session_events.session_id
        and session.social_id = (select private.current_social_id())
    )
  );

drop policy matches_select_hosts on public.matches;
create policy matches_select_own_social on public.matches
  for select to authenticated using (
    exists (
      select 1 from public.sessions as session
      where session.id = matches.session_id
        and session.social_id = (select private.current_social_id())
    )
  );

-- No policy uses it any more.
revoke all on function private.is_host() from authenticated;
drop function private.is_host();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Locks a session of the social for the rest of the transaction (serialises
-- every write to its log and attendance). Another social's session is
-- SESSION_NOT_FOUND, like a missing one: its existence isn't revealed.
create function private.lock_social_session(p_social_id uuid, p_session_id uuid)
returns public.sessions
language plpgsql
set search_path = ''
as $$
declare
  v_session public.sessions;
begin
  select * into v_session
  from public.sessions
  where id = p_session_id and social_id = p_social_id
  for update;
  if not found then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'P0002', detail = format('No session %s.', p_session_id);
  end if;
  return v_session;
end;
$$;

-- Locks the social's open draft, or raises DRAFT_NOT_OPEN (another social's,
-- not a draft any more, or no such session). Any host of the social may edit
-- it: no host_id check (co-editing; draft_revision guards settings writes).
create function private.lock_social_open_draft(p_social_id uuid, p_session_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform 1 from public.sessions
  where id = p_session_id
    and social_id = p_social_id
    and status = 'draft'
  for update;
  if not found then
    raise exception 'DRAFT_NOT_OPEN' using errcode = 'P0002',
      detail = format('Session %s is not an open draft of this social.', p_session_id);
  end if;
end;
$$;

-- The social's open session with check-in open, by the social's sticker tag.
-- At most one exists (sessions_one_open_per_social_idx). An unknown tag and a
-- social with nothing open give the same error, so the tag space can't be probed.
create or replace function private.find_open_session_by_checkin_tag(p_checkin_tag text)
returns public.sessions
language plpgsql
stable
set search_path = ''
as $$
declare
  v_session public.sessions;
begin
  if p_checkin_tag is not null and p_checkin_tag ~ '^[a-z0-9_-]{16,64}$' then
    select open_session.* into v_session
    from public.sessions as open_session
    join public.socials as social on social.id = open_session.social_id
    where social.checkin_tag = p_checkin_tag
      and open_session.status in ('draft', 'live')
      and open_session.checkin_open;
  end if;
  if v_session.id is null then
    raise exception 'NO_OPEN_SESSION' using errcode = 'P0002', detail = 'No social is open here right now.';
  end if;
  return v_session;
end;
$$;

-- ---------------------------------------------------------------------------
-- Live session log: any host of the session's social
-- ---------------------------------------------------------------------------

create or replace function public.append_session_event(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_event_id uuid,
  p_expected_last_seq integer,
  p_type public.session_event_type,
  p_payload jsonb,
  p_occurred_at timestamptz,
  p_match_row jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_session public.sessions := private.lock_social_session(v_social_id, p_session_id);
  v_duplicate jsonb;
  v_result jsonb;
begin
  v_duplicate := private.find_duplicate_session_event(p_session_id, p_event_id, p_type);
  if v_duplicate is not null then
    return v_duplicate;
  end if;

  if p_type in ('SessionStarted', 'SessionEnded') then
    raise exception 'USE_DEDICATED_FUNCTION' using errcode = '22023',
      detail = 'Use start_session or end_session.';
  end if;
  if v_session.status <> 'live' then
    raise exception 'SESSION_NOT_LIVE' using errcode = 'P0001',
      detail = format('Session %s is %s.', p_session_id, v_session.status);
  end if;
  if p_type = 'PlayerJoined' and not exists (
    select 1 from public.session_participants
    where session_id = p_session_id
      and id::text = p_payload #>> '{participant,participantId}'
  ) then
    raise exception 'UNKNOWN_PARTICIPANT' using errcode = '22023',
      detail = 'PlayerJoined must name a session_participants row of this session.';
  end if;

  v_result := private.insert_session_event(
    v_session, p_event_id, p_expected_last_seq, p_type, p_payload, p_occurred_at, p_actor_user_id
  );
  perform private.write_match_row(p_session_id, p_type, p_payload, p_match_row);
  return v_result;
end;
$$;

create or replace function public.start_session(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_event_id uuid,
  p_occurred_at timestamptz,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_session public.sessions := private.lock_social_session(v_social_id, p_session_id);
  v_duplicate jsonb;
begin
  v_duplicate := private.find_duplicate_session_event(p_session_id, p_event_id, 'SessionStarted');
  if v_duplicate is not null then
    return v_duplicate;
  end if;

  if v_session.status <> 'draft' then
    raise exception 'SESSION_NOT_DRAFT' using errcode = 'P0001',
      detail = format('Session %s is already %s.', p_session_id, v_session.status);
  end if;
  if jsonb_typeof(p_payload -> 'config') is distinct from 'object'
    or jsonb_typeof(p_payload #> '{config,participants}') is distinct from 'array'
    or jsonb_typeof(p_payload -> 'initialAttendeeIds') is distinct from 'array' then
    raise exception 'INVALID_PAYLOAD' using errcode = '22023',
      detail = 'SessionStarted needs config, config.participants and initialAttendeeIds.';
  end if;
  if exists (
    select 1
    from (
      select jsonb_array_elements_text(p_payload -> 'initialAttendeeIds') as participant_id
      union all
      select roster_entry ->> 'participantId'
      from jsonb_array_elements(p_payload #> '{config,participants}') as roster_entry
    ) as named
    where not exists (
      select 1 from public.session_participants as participant
      where participant.session_id = p_session_id and participant.id::text = named.participant_id
    )
  ) then
    raise exception 'UNKNOWN_PARTICIPANT' using errcode = '22023',
      detail = 'Every participant in SessionStarted must be a session_participants row of this session.';
  end if;

  -- Status first: the draft constraint requires last_seq = 0, which the insert bumps.
  update public.sessions
  set status = 'live', started_at = p_occurred_at, config_snapshot = p_payload -> 'config'
  where id = p_session_id;

  return private.insert_session_event(
    v_session, p_event_id, 0, 'SessionStarted', p_payload, p_occurred_at, p_actor_user_id
  );
end;
$$;

create or replace function public.end_session(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_event_id uuid,
  p_expected_last_seq integer,
  p_occurred_at timestamptz,
  p_final_stats jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_session public.sessions := private.lock_social_session(v_social_id, p_session_id);
  v_duplicate jsonb;
  v_result jsonb;
begin
  v_duplicate := private.find_duplicate_session_event(p_session_id, p_event_id, 'SessionEnded');
  if v_duplicate is not null then
    return v_duplicate;
  end if;

  if v_session.status <> 'live' then
    raise exception 'SESSION_NOT_LIVE' using errcode = 'P0001',
      detail = format('Session %s is %s.', p_session_id, v_session.status);
  end if;

  v_result := private.insert_session_event(
    v_session, p_event_id, p_expected_last_seq, 'SessionEnded', '{}'::jsonb, p_occurred_at, p_actor_user_id
  );
  update public.sessions
  set status = 'ended', ended_at = p_occurred_at, final_stats = p_final_stats
  where id = p_session_id;
  return v_result;
end;
$$;

create or replace function public.add_guest_mid_session(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_session_participant_id uuid,
  p_first_name text,
  p_last_name text,
  p_skill_level public.skill_level,
  p_event_id uuid,
  p_expected_last_seq integer,
  p_occurred_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_session public.sessions := private.lock_social_session(v_social_id, p_session_id);
  v_duplicate jsonb;
  v_participant public.session_participants;
  v_result jsonb;
begin
  v_duplicate := private.find_duplicate_session_event(p_session_id, p_event_id, 'PlayerJoined');
  if v_duplicate is not null then
    return v_duplicate || jsonb_build_object(
      'session_participant_id',
      (select payload #>> '{participant,participantId}' from public.session_events where event_id = p_event_id)
    );
  end if;

  if v_session.status <> 'live' then
    raise exception 'SESSION_NOT_LIVE' using errcode = 'P0001',
      detail = format('Session %s is %s.', p_session_id, v_session.status);
  end if;

  insert into public.session_participants (
    id, session_id, social_id, member_id, is_guest, first_name, last_name, skill_level
  )
  values (
    p_session_participant_id, p_session_id, v_social_id, null, true,
    private.normalise_person_name(p_first_name), private.normalise_person_name(p_last_name), p_skill_level
  )
  returning * into v_participant;

  v_result := private.insert_session_event(
    v_session, p_event_id, p_expected_last_seq, 'PlayerJoined',
    private.player_joined_payload(v_participant), p_occurred_at, p_actor_user_id
  );
  return v_result || jsonb_build_object('session_participant_id', v_participant.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Draft setup: any host of the social (co-editing)
-- ---------------------------------------------------------------------------

-- Abandons the social's draft, freeing its one open-session slot. Its rows stay for history.
create or replace function public.cancel_draft_session(p_actor_user_id uuid, p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_session public.sessions := private.lock_social_session(v_social_id, p_session_id);
begin
  if v_session.status = 'cancelled' then
    return jsonb_build_object('status', 'already_cancelled');
  end if;
  if v_session.status <> 'draft' then
    raise exception 'SESSION_NOT_DRAFT' using errcode = 'P0001',
      detail = format('Session %s is %s; only a draft can be cancelled.', p_session_id, v_session.status);
  end if;
  update public.sessions set status = 'cancelled' where id = p_session_id;
  return jsonb_build_object('status', 'cancelled');
end;
$$;

-- Removes a participant from one of the social's drafts. Another social's
-- participant is PARTICIPANT_NOT_FOUND, like a missing one.
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
  delete from public.session_participants where id = p_session_participant_id;
  return jsonb_build_object('status', 'removed');
end;
$$;

create or replace function public.save_session_draft(
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
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_draft_revision integer;
begin
  perform private.lock_social_open_draft(v_social_id, p_session_id);
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

-- Attending snapshots each ACTIVE member of the social; inactive, unknown or
-- another social's ids are skipped. Not attending removes only member rows.
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
  v_social_id uuid := private.require_host_social(p_actor_user_id);
begin
  perform private.lock_social_open_draft(v_social_id, p_session_id);
  if p_member_ids is null or p_attending is null then
    raise exception 'INVALID_ATTENDANCE' using errcode = '22023',
      detail = 'p_member_ids and p_attending are required.';
  end if;

  if p_attending then
    insert into public.session_participants (
      session_id, social_id, member_id, is_guest, first_name, last_name, skill_level
    )
    select p_session_id, v_social_id, member.id, false, member.first_name, member.last_name, member.skill_level
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

create or replace function public.add_draft_guest(
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
declare
  v_social_id uuid := private.require_host_social(p_actor_user_id);
begin
  perform private.lock_social_open_draft(v_social_id, p_session_id);
  if p_session_participant_id is null then
    raise exception 'INVALID_PARTICIPANT_ID' using errcode = '22023',
      detail = 'p_session_participant_id is required.';
  end if;
  insert into public.session_participants (
    id, session_id, social_id, member_id, is_guest, first_name, last_name, skill_level
  )
  values (
    p_session_participant_id, p_session_id, v_social_id, null, true,
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

create or replace function public.remove_draft_guest(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_session_participant_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_social_id uuid := private.require_host_social(p_actor_user_id);
begin
  perform private.lock_social_open_draft(v_social_id, p_session_id);
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

-- ---------------------------------------------------------------------------
-- Saved setups: shared by the social's hosts
-- ---------------------------------------------------------------------------

-- Upserts by (social, name ignoring case): saving under an existing name
-- replaces that setup, whoever saved it; host_id records the latest saver.
create or replace function public.save_setup(
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
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_setup_id uuid;
begin
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

  insert into public.saved_setups (social_id, host_id, name, config, last_used_at)
  values (v_social_id, p_actor_user_id, p_name, p_config, now())
  on conflict (social_id, lower(btrim(name))) do update
    set name = excluded.name,
        host_id = excluded.host_id,
        config = excluded.config,
        last_used_at = excluded.last_used_at
  returning id into v_setup_id;
  return v_setup_id;
end;
$$;

-- Applies one of the social's setups to the social's draft. Another social's
-- setup is SAVED_SETUP_NOT_FOUND.
create or replace function public.apply_saved_setup(
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
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_draft_revision integer;
begin
  perform private.lock_social_open_draft(v_social_id, p_session_id);
  perform 1 from public.saved_setups
  where id = p_setup_id
    and social_id = v_social_id
  for update;
  if not found then
    raise exception 'SAVED_SETUP_NOT_FOUND' using errcode = 'P0002',
      detail = format('Setup %s is not a saved setup of this social.', p_setup_id);
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

-- ---------------------------------------------------------------------------
-- Check-in
-- ---------------------------------------------------------------------------

-- Check-in search: active members of the session's social only.
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
  v_query text := lower(btrim(regexp_replace(coalesce(p_name_query, ''), '\s+', ' ', 'g')));
begin
  perform private.require_valid_client_identity(p_device_token_hash, p_ip_hash);
  v_session := private.find_open_session_by_checkin_tag(p_checkin_tag);

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
    where member.social_id = v_session.social_id
      and member.is_active
      and (
        lower(member.first_name || ' ' || member.last_name) like v_query || '%'
        or lower(member.last_name) like v_query || '%'
      )
    order by member.first_name, member.last_name, member.id
    limit c_max_results;
end;
$$;

-- Check-in submit: a returning player must be an active member of the
-- session's social; another social's member answers `member_not_found`.
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
  v_first_name := private.normalise_person_name(p_first_name);
  v_last_name := private.normalise_person_name(p_last_name);
  if p_member_id is null and p_skill_level is null then
    raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'First-time players must choose a skill level.';
  end if;
  v_session := private.find_open_session_by_checkin_tag(p_checkin_tag);

  perform private.record_checkin_attempt('submit', v_session.id, p_device_token_hash, p_ip_hash, 10, 30, 300);

  if p_member_id is not null and not exists (
    select 1 from public.members where id = p_member_id and social_id = v_session.social_id and is_active
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

-- Approve: the request must be the actor's social's (CHECKIN_REQUEST_NOT_FOUND
-- otherwise, as if it didn't exist). The member (new or returning), the phone
-- and the participant all belong to that social.
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
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_session_id uuid;
  v_session public.sessions;
  v_request public.checkin_requests;
  v_member_id uuid;
  v_member_skill_level public.skill_level;
  v_participant public.session_participants;
  v_event_result jsonb;
begin
  select session_id into v_session_id
  from public.checkin_requests
  where id = p_checkin_request_id and social_id = v_social_id;
  if not found then
    raise exception 'CHECKIN_REQUEST_NOT_FOUND' using errcode = 'P0002',
      detail = format('No check-in request %s.', p_checkin_request_id);
  end if;
  -- Session first, the same lock order as every other log write.
  v_session := private.lock_social_session(v_social_id, v_session_id);
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
    insert into public.session_participants (
      id, session_id, social_id, member_id, is_guest, first_name, last_name, skill_level
    )
    values (
      p_session_participant_id, v_session.id, v_social_id, v_member_id, false,
      v_request.first_name, v_request.last_name, v_member_skill_level
    )
    returning * into v_participant;
  end if;

  if v_session.status = 'live' then
    v_event_result := private.insert_session_event(
      v_session, p_event_id, p_expected_last_seq, 'PlayerJoined',
      private.player_joined_payload(v_participant), p_occurred_at, p_actor_user_id
    );
  end if;

  update public.checkin_requests
  set status = 'approved',
      decided_by = p_actor_user_id,
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
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_request public.checkin_requests;
begin
  select * into v_request
  from public.checkin_requests
  where id = p_checkin_request_id and social_id = v_social_id
  for update;
  if not found then
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
  set status = 'rejected', decided_by = p_actor_user_id, decided_at = now()
  where id = p_checkin_request_id;
  return jsonb_build_object('status', 'rejected');
end;
$$;

-- ---------------------------------------------------------------------------
-- Old helpers: nothing calls them any more
-- ---------------------------------------------------------------------------

drop function private.lock_session(uuid);
drop function private.lock_own_open_draft(uuid, uuid);
drop function private.require_host(uuid);
drop function private.session_social_id(public.sessions);

-- ---------------------------------------------------------------------------
-- Grants (create or replace keeps grants; restated so this file is the record)
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema private from public;
revoke all on function private.lock_social_session(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.lock_social_open_draft(uuid, uuid) from public, anon, authenticated, service_role;

revoke all on function public.append_session_event(uuid, uuid, uuid, integer, public.session_event_type, jsonb, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.start_session(uuid, uuid, uuid, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.end_session(uuid, uuid, uuid, integer, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.add_guest_mid_session(uuid, uuid, uuid, text, text, public.skill_level, uuid, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.cancel_draft_session(uuid, uuid) from public, anon, authenticated;
revoke all on function public.remove_draft_participant(uuid, uuid) from public, anon, authenticated;
revoke all on function public.save_session_draft(uuid, uuid, integer, text, text, text, timestamptz, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.set_draft_member_attendance(uuid, uuid, uuid[], boolean) from public, anon, authenticated;
revoke all on function public.add_draft_guest(uuid, uuid, uuid, text, text, public.skill_level) from public, anon, authenticated;
revoke all on function public.remove_draft_guest(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.save_setup(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.apply_saved_setup(uuid, uuid, uuid, integer, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.search_checkin_names(text, text, text, text) from public, anon, authenticated;
revoke all on function public.submit_checkin(text, text, text, text, text, public.skill_level, uuid) from public, anon, authenticated;
revoke all on function public.approve_checkin(uuid, uuid, uuid, uuid, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.reject_checkin(uuid, uuid) from public, anon, authenticated;

grant execute on function public.append_session_event(uuid, uuid, uuid, integer, public.session_event_type, jsonb, timestamptz, jsonb) to service_role;
grant execute on function public.start_session(uuid, uuid, uuid, timestamptz, jsonb) to service_role;
grant execute on function public.end_session(uuid, uuid, uuid, integer, timestamptz, jsonb) to service_role;
grant execute on function public.add_guest_mid_session(uuid, uuid, uuid, text, text, public.skill_level, uuid, integer, timestamptz) to service_role;
grant execute on function public.cancel_draft_session(uuid, uuid) to service_role;
grant execute on function public.remove_draft_participant(uuid, uuid) to service_role;
grant execute on function public.save_session_draft(uuid, uuid, integer, text, text, text, timestamptz, timestamptz, jsonb) to service_role;
grant execute on function public.set_draft_member_attendance(uuid, uuid, uuid[], boolean) to service_role;
grant execute on function public.add_draft_guest(uuid, uuid, uuid, text, text, public.skill_level) to service_role;
grant execute on function public.remove_draft_guest(uuid, uuid, uuid) to service_role;
grant execute on function public.save_setup(uuid, text, jsonb) to service_role;
grant execute on function public.apply_saved_setup(uuid, uuid, uuid, integer, text, integer, jsonb) to service_role;
grant execute on function public.search_checkin_names(text, text, text, text) to service_role;
grant execute on function public.submit_checkin(text, text, text, text, text, public.skill_level, uuid) to service_role;
grant execute on function public.approve_checkin(uuid, uuid, uuid, uuid, integer, timestamptz) to service_role;
grant execute on function public.reject_checkin(uuid, uuid) to service_role;
