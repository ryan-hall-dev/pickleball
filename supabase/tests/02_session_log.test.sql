-- The session log write path: host check, idempotent event_id (checked before
-- the sequence), stale expected_last_seq, atomic start / end / mid-session
-- participant add, and the matches row side effects.
begin;
create extension if not exists pgtap with schema extensions;
select plan(49);

insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-000000000002', 'pgtap-host@example.test'),
  ('a0000000-0000-4000-8000-000000000003', 'pgtap-outsider@example.test');
insert into public.socials (id, name) values ('50000000-0000-4000-8000-000000000002', 'pgTAP Social');
insert into public.hosts (user_id, display_name, social_id) values ('a0000000-0000-4000-8000-000000000002', 'Hal Host', '50000000-0000-4000-8000-000000000002');
insert into public.sessions (id, social_id, host_id, name, host_name, planned_start, planned_end) values
  ('d0000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', 'Tuesday social', 'Hal Host', now(), now() + interval '2 hours');
insert into public.session_participants (id, session_id, social_id, first_name, last_name, skill_level) values
  ('e0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002', 'Grace', 'Kim', 'advanced'),
  ('e0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002', 'Kofi', 'Mensah', 'intermediate'),
  ('e0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002', 'Zoe', 'Park', 'beginner'),
  ('e0000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002', 'Ravi', 'Patel', 'intermediate');

-- Test-only shorthands for the payloads used below.
create function pg_temp.started_payload(p_attendee_ids text[]) returns jsonb language sql as $$
  select jsonb_build_object(
    'config', jsonb_build_object(
      'courts', jsonb_build_array(jsonb_build_object('courtId', 'c0000000-0000-4000-8000-000000000001', 'name', 'Court 1', 'format', 'doubles')),
      'participants', (select coalesce(jsonb_agg(jsonb_build_object('participantId', id)), '[]') from unnest(p_attendee_ids) as id)
    ),
    'initialAttendeeIds', to_jsonb(p_attendee_ids)
  );
$$;
create function pg_temp.match_row(p_status text, p_ended boolean) returns jsonb language sql as $$
  select jsonb_build_object(
    'id', 'f1000000-0000-4000-8000-000000000001',
    'court_id', 'c0000000-0000-4000-8000-000000000001',
    'court_name', 'Court 1',
    'team_a', jsonb_build_array('e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002'),
    'team_b', jsonb_build_array('e0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000004'),
    'started_at', now(),
    'ended_at', case when p_ended then now() end,
    'duration_seconds', 0,
    'status', p_status
  );
$$;
grant execute on all functions in schema pg_temp to service_role;

-- Not a host -------------------------------------------------------------------
-- Functions run only as service_role; the server passes the verified actor.
set local role service_role;
select throws_ok(
  $$select public.start_session('a0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000001', gen_random_uuid(), now(), pg_temp.started_payload('{}'))$$,
  '42501', 'NOT_A_HOST', 'a non-host cannot start a session'
);
select throws_ok(
  $$select public.append_session_event('a0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000001', gen_random_uuid(), 0, 'Paused', '{}', now())$$,
  '42501', 'NOT_A_HOST', 'a non-host cannot append events'
);
select throws_ok(
  $$select public.append_session_event(null, 'd0000000-0000-4000-8000-000000000001', gen_random_uuid(), 0, 'Paused', '{}', now())$$,
  '42501', 'NOT_A_HOST', 'a missing actor is refused'
);

-- Start --------------------------------------------------------------------------
select throws_ok(
  $$select public.append_session_event('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', gen_random_uuid(), 0, 'Paused', '{}', now())$$,
  'P0001', 'SESSION_NOT_LIVE', 'nothing can be appended to a draft'
);
select throws_ok(
  $$select public.start_session('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', gen_random_uuid(), now(),
      pg_temp.started_payload('{e0000000-0000-4000-8000-000000000001,e0000000-0000-4000-8000-0000000000ff}'))$$,
  '22023', 'UNKNOWN_PARTICIPANT', 'start refuses participants that are not in the session'
);
select throws_ok(
  $$select public.start_session('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', gen_random_uuid(), now(), '{"initialAttendeeIds":[]}')$$,
  '22023', 'INVALID_PAYLOAD', 'start refuses a payload without a config'
);
select throws_ok(
  $$select public.start_session('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', gen_random_uuid(), now() - interval '1 hour', pg_temp.started_payload('{}'))$$,
  '22023', 'INVALID_OCCURRED_AT', 'start refuses an event time far from the database clock'
);
select is(
  (select status::text from public.sessions where id = 'd0000000-0000-4000-8000-000000000001'),
  'draft',
  'a failed start leaves the session a draft (atomic)'
);
select is_empty($$select 1 from public.session_events where session_id = 'd0000000-0000-4000-8000-000000000001'$$, 'a failed start writes no event (atomic)');

select is(
  public.start_session('a0000000-0000-4000-8000-000000000002', 
    'd0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', now(),
    pg_temp.started_payload('{e0000000-0000-4000-8000-000000000001,e0000000-0000-4000-8000-000000000002,e0000000-0000-4000-8000-000000000003,e0000000-0000-4000-8000-000000000004}')
  ) ->> 'status',
  'appended',
  'a host starts the session'
);
select results_eq(
  $$select status::text, last_seq, started_at = now(), config_snapshot -> 'courts' -> 0 ->> 'name'
    from public.sessions where id = 'd0000000-0000-4000-8000-000000000001'$$,
  $$values ('live', 1, true, 'Court 1')$$,
  'start makes the session live at seq 1 with the config snapshot'
);
select results_eq(
  $$select seq, type::text, actor_user_id from public.session_events where event_id = 'f0000000-0000-4000-8000-000000000001'$$,
  $$values (1, 'SessionStarted', 'a0000000-0000-4000-8000-000000000002'::uuid)$$,
  'the SessionStarted event is seq 1, stamped with the acting host'
);
select is(
  public.start_session('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', now(), pg_temp.started_payload('{}')),
  jsonb_build_object('status', 'duplicate', 'seq', 1, 'occurred_at', now()),
  'retrying the start with the same event_id returns the original result'
);
select throws_ok(
  $$select public.start_session('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', gen_random_uuid(), now(), pg_temp.started_payload('{}'))$$,
  'P0001', 'SESSION_NOT_DRAFT', 'a live session cannot start again'
);

-- Sequence check and idempotency ----------------------------------------------------
select throws_ok(
  $$select public.append_session_event('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', gen_random_uuid(), 0, 'Paused', '{}', now())$$,
  'P0001', 'STALE_EXPECTED_SEQ', 'a stale expected_last_seq is rejected'
);
select throws_ok(
  $$select public.append_session_event('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', gen_random_uuid(), 5, 'Paused', '{}', now())$$,
  'P0001', 'STALE_EXPECTED_SEQ', 'an expected_last_seq from the future is rejected'
);
select is(
  (select last_seq from public.sessions where id = 'd0000000-0000-4000-8000-000000000001'),
  1,
  'a rejected append leaves last_seq unchanged'
);

select is(
  public.append_session_event('a0000000-0000-4000-8000-000000000002', 
    'd0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002', 1, 'MatchStarted',
    '{"matchId":"f1000000-0000-4000-8000-000000000001","courtId":"c0000000-0000-4000-8000-000000000001","teamA":["e0000000-0000-4000-8000-000000000001","e0000000-0000-4000-8000-000000000002"],"teamB":["e0000000-0000-4000-8000-000000000003","e0000000-0000-4000-8000-000000000004"]}',
    now()
  ),
  jsonb_build_object('status', 'appended', 'seq', 2, 'occurred_at', now()),
  'an action appends at last_seq + 1'
);
select is(
  public.append_session_event('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002', 1, 'MatchStarted', '{}', now()),
  jsonb_build_object('status', 'duplicate', 'seq', 2, 'occurred_at', now()),
  'a retry with the same event_id returns the original result even though its expected_last_seq is now stale'
);
select is(
  (select count(*) from public.session_events where event_id = 'f0000000-0000-4000-8000-000000000002'),
  1::bigint,
  'the retry did not append a second event'
);
select throws_ok(
  $$select public.append_session_event('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002', 2, 'Paused', '{}', now())$$,
  '22023', 'EVENT_ID_REUSED', 'an event_id reused for a different action is refused'
);
select throws_ok(
  $$select public.append_session_event('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', gen_random_uuid(), 2, 'SessionEnded', '{}', now())$$,
  '22023', 'USE_DEDICATED_FUNCTION', 'SessionEnded must go through end_session'
);
select throws_ok(
  $$select public.append_session_event('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', gen_random_uuid(), 2, 'Paused', '{}', now() + interval '1 hour')$$,
  '22023', 'INVALID_OCCURRED_AT', 'an event time far from the database clock is refused'
);
select throws_ok(
  $$select public.append_session_event('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', gen_random_uuid(), 2, 'PlayerJoined',
      '{"participant":{"participantId":"e0000000-0000-4000-8000-0000000000ff"}}', now())$$,
  '22023', 'UNKNOWN_PARTICIPANT', 'PlayerJoined must name a participant row of the session'
);

-- matches row side effects ------------------------------------------------------------
select throws_ok(
  $$select public.append_session_event('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', gen_random_uuid(), 2, 'MatchCompleted',
      '{"matchId":"f1000000-0000-4000-8000-000000000001"}', now())$$,
  '22023', 'MATCH_ROW_REQUIRED', 'a completion must write its matches row'
);
select throws_ok(
  $$select public.append_session_event('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', gen_random_uuid(), 2, 'MatchCompleted',
      '{"matchId":"f1000000-0000-4000-8000-000000000001"}', now(), pg_temp.match_row('abandoned', true))$$,
  '22023', 'MATCH_ROW_MISMATCH', 'a completion cannot write an abandoned row'
);
select throws_ok(
  $$select public.append_session_event('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', gen_random_uuid(), 2, 'Paused', '{}', now(), pg_temp.match_row('completed', true))$$,
  '22023', 'MATCH_ROW_NOT_EXPECTED', 'other actions cannot write a matches row'
);
select is(
  (select last_seq from public.sessions where id = 'd0000000-0000-4000-8000-000000000001'),
  2,
  'a refused side effect rolls back its event too'
);

select is(
  public.append_session_event('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000003', 2, 'MatchCompleted',
    '{"matchId":"f1000000-0000-4000-8000-000000000001"}', now(), pg_temp.match_row('completed', true)) ->> 'seq',
  '3',
  'a completion appends'
);
select results_eq(
  $$select status::text, ended_at is not null, cardinality(team_a), session_id from public.matches where id = 'f1000000-0000-4000-8000-000000000001'$$,
  $$values ('completed', true, 2, 'd0000000-0000-4000-8000-000000000001'::uuid)$$,
  'the completion wrote a completed matches row in the same transaction'
);
select is(
  public.append_session_event('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000004', 3, 'MatchCompletionReverted',
    '{"targetSeq":3}', now(), pg_temp.match_row('reverted', false)) ->> 'seq',
  '4',
  'undoing the completion appends'
);
select results_eq(
  $$select status::text, ended_at is null, (select count(*) from public.matches where session_id = 'd0000000-0000-4000-8000-000000000001') from public.matches where id = 'f1000000-0000-4000-8000-000000000001'$$,
  $$values ('reverted', true, 1::bigint)$$,
  'the undo marks the same row reverted (never deleted)'
);
select is(
  public.append_session_event('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000005', 4, 'MatchCompleted',
    '{"matchId":"f1000000-0000-4000-8000-000000000001"}', now(), pg_temp.match_row('completed', true)) ->> 'seq',
  '5',
  'the match completes again'
);
select is(
  (select status::text from public.matches where id = 'f1000000-0000-4000-8000-000000000001'),
  'completed',
  'the row is completed again'
);

-- Mid-session participant ------------------------------------------------------------------
select throws_ok(
  $$select public.add_participant_mid_session('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001',
      'Gus', 'Guest', 'beginner', gen_random_uuid(), 4, now(), 'male')$$,
  'P0001', 'STALE_EXPECTED_SEQ', 'a mid-session add with a stale seq is refused'
);
select is_empty(
  $$select 1 from public.session_participants where id = 'e1000000-0000-4000-8000-000000000001'$$,
  'the refused add left no participant row (atomic)'
);
select throws_ok(
  $$select public.add_participant_mid_session('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', gen_random_uuid(),
      '   ', 'Guest', 'beginner', gen_random_uuid(), 5, now(), 'male')$$,
  '22023', 'INVALID_NAME', 'a blank name is refused'
);
select throws_ok(
  $$select public.add_participant_mid_session('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', gen_random_uuid(),
      'Nina', 'New', null, gen_random_uuid(), 5, now(), 'male')$$,
  '22023', 'INVALID_INPUT', 'a mid-session add needs a level'
);
select is(
  public.add_participant_mid_session('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001',
    '  Gus ', 'Guest', 'beginner', 'f0000000-0000-4000-8000-000000000006', 5, now(), 'male'),
  jsonb_build_object('status', 'appended', 'seq', 6, 'occurred_at', now(), 'session_participant_id', 'e1000000-0000-4000-8000-000000000001'),
  'a host adds a participant mid-session'
);
select results_eq(
  $$select type::text, payload from public.session_events where event_id = 'f0000000-0000-4000-8000-000000000006'$$,
  $$values ('PlayerJoined', '{"participant":{"participantId":"e1000000-0000-4000-8000-000000000001","firstName":"Gus","lastName":"Guest","skill":"beginner","gender":"male"}}'::jsonb)$$,
  'the PlayerJoined carries the engine participant snapshot (no isGuest)'
);
select throws_ok(
  $$select public.add_participant_mid_session('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', gen_random_uuid(),
      'grace', ' KIM ', 'beginner', gen_random_uuid(), 6, now(), 'male')$$,
  'P0001', 'NAME_ALREADY_IN_SESSION', 'a name already in the session is refused mid-session (case and spacing ignored)'
);
select is(
  (select last_seq from public.sessions where id = 'd0000000-0000-4000-8000-000000000001'),
  6,
  'the refused add appended nothing'
);
select is(
  public.add_participant_mid_session('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001',
    'Gus', 'Guest', 'beginner', 'f0000000-0000-4000-8000-000000000006', 5, now(), 'male') ->> 'status',
  'duplicate',
  'retrying the add is idempotent'
);

-- End ---------------------------------------------------------------------------------------
select throws_ok(
  $$select public.end_session('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', gen_random_uuid(), 5, now())$$,
  'P0001', 'STALE_EXPECTED_SEQ', 'end with a stale seq is refused'
);
select is(
  (select status::text from public.sessions where id = 'd0000000-0000-4000-8000-000000000001'),
  'live',
  'a refused end leaves the session live (atomic)'
);
select is(
  public.end_session('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000007', 6, now(), '{"games":1}') ->> 'seq',
  '7',
  'a host ends the session'
);
select results_eq(
  $$select status::text, ended_at = now(), last_seq, final_stats from public.sessions where id = 'd0000000-0000-4000-8000-000000000001'$$,
  $$values ('ended', true, 7, '{"games":1}'::jsonb)$$,
  'end marks the session ended with its final stats'
);
select throws_ok(
  $$select public.append_session_event('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', gen_random_uuid(), 7, 'Paused', '{}', now())$$,
  'P0001', 'SESSION_NOT_LIVE', 'nothing can be appended after the end'
);
select is(
  public.end_session('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000007', 6, now()) ->> 'status',
  'duplicate',
  'retrying the end is idempotent'
);
reset role;

select * from finish();
rollback;
