-- Public check-in functions (guards, privacy, rate limits) and the host's
-- approve / reject (atomic, including the live PlayerJoined event), after
-- session-only participants (20261112090000): no members, no search. Everything
-- runs as service_role, as the server does (anon access is tested in 01).
begin;
create extension if not exists pgtap with schema extensions;
select plan(41);

insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-000000000002', 'pgtap-host@example.test'),
  ('a0000000-0000-4000-8000-000000000003', 'pgtap-outsider@example.test');
-- The sticker tag belongs to the social; its host's open session answers it.
insert into public.socials (id, name, checkin_tag) values
  ('50000000-0000-4000-8000-000000000003', 'pgTAP Social', 'tag0000000000000001');
insert into public.hosts (user_id, display_name, social_id) values
  ('a0000000-0000-4000-8000-000000000002', 'Hal Host', '50000000-0000-4000-8000-000000000003');
insert into public.sessions (id, social_id, host_id, name, host_name, planned_start, planned_end) values
  ('d0000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000002', 'Tuesday social', 'Hal Host', now(), now() + interval '2 hours');

-- Test-only shorthands.
-- The device token hash the server passes (SHA-256 of the cookie token).
create function pg_temp.device(p_number integer) returns text language sql as $$
  select encode(sha256(convert_to('device-token-' || p_number, 'UTF8')), 'hex')
$$;
create function pg_temp.ip(p_number integer) returns text language sql as $$
  select encode(sha256(convert_to('ip-' || p_number, 'UTF8')), 'hex')
$$;
grant execute on all functions in schema pg_temp to service_role;

-- Submit: validation and guards ---------------------------------------------------
set local role service_role;
select throws_ok(
  $$select public.submit_checkin('tag0000000000000001', 'd0000000-0000-4000-8000-000000000001'::uuid, pg_temp.device(10), pg_temp.ip(10), 'Nina', 'New', null, 'male')$$,
  '22023', 'INVALID_INPUT', 'a player must give a level'
);
select throws_ok(
  $$select public.submit_checkin('tag0000000000000001', 'd0000000-0000-4000-8000-000000000001'::uuid, pg_temp.device(10), pg_temp.ip(10), '   ', 'New', 'beginner', 'male')$$,
  '22023', 'INVALID_NAME', 'a blank name is refused'
);
select throws_ok(
  $$select public.submit_checkin('tag0000000000000001', 'd0000000-0000-4000-8000-000000000001'::uuid, pg_temp.device(10), pg_temp.ip(10), repeat('x', 51), 'New', 'beginner', 'male')$$,
  '22023', 'INVALID_NAME', 'an over-long name is refused'
);
select throws_ok(
  $$select public.submit_checkin('tag0000000000000009', 'd0000000-0000-4000-8000-000000000001'::uuid, pg_temp.device(10), pg_temp.ip(10), 'Nina', 'New', 'beginner', 'male')$$,
  'P0001', 'SESSION_CHANGED', 'submit needs a known tag'
);
select throws_ok(
  $$select public.submit_checkin('not a tag!', 'd0000000-0000-4000-8000-000000000001'::uuid, pg_temp.device(10), pg_temp.ip(10), 'Nina', 'New', 'beginner', 'male')$$,
  'P0001', 'SESSION_CHANGED', 'a malformed tag gives the same answer as an unknown one'
);
select throws_ok(
  $$select public.submit_checkin('tag0000000000000001', 'd0000000-0000-4000-8000-000000000001'::uuid, 'raw-device-token', pg_temp.ip(10), 'Nina', 'New', 'beginner', 'male')$$,
  '22023', 'INVALID_INPUT', 'submit refuses anything but a device token hash'
);
select throws_ok(
  $$select public.submit_checkin('tag0000000000000001', 'd0000000-0000-4000-8000-000000000001'::uuid, pg_temp.device(10), 'not-a-hash', 'Nina', 'New', 'beginner', 'male')$$,
  '22023', 'INVALID_INPUT', 'submit refuses a malformed IP hash'
);
reset role;

-- Closed check-in hides the session.
update public.sessions set checkin_open = false where id = 'd0000000-0000-4000-8000-000000000001';
set local role service_role;
select throws_ok(
  $$select public.submit_checkin('tag0000000000000001', 'd0000000-0000-4000-8000-000000000001'::uuid, pg_temp.device(10), pg_temp.ip(10), 'Nina', 'New', 'beginner', 'male')$$,
  'P0001', 'SESSION_CHANGED', 'submit needs the session''s check-in to be open'
);
reset role;
update public.sessions set checkin_open = true where id = 'd0000000-0000-4000-8000-000000000001';

-- A stale page cannot bind its cookie to another session, including a null ID.
set local role service_role;
select throws_ok(
  $$select public.submit_checkin('tag0000000000000001', null, pg_temp.device(40), pg_temp.ip(40), 'Stale', 'Form', 'beginner', 'male')$$,
  'P0001', 'SESSION_CHANGED', 'a session UUID is required'
);
select throws_ok(
  $$select public.submit_checkin('tag0000000000000001', 'd0000000-0000-4000-8000-000000000099', pg_temp.device(40), pg_temp.ip(40), 'Stale', 'Form', 'beginner', 'male')$$,
  'P0001', 'SESSION_CHANGED', 'a different rendered session is refused'
);
reset role;
select is((select count(*) from public.checkin_attempts where device_token_hash = pg_temp.device(40)), 0::bigint, 'session mismatch writes no attempts');
select is((select count(*) from public.checkin_requests where device_token_hash = pg_temp.device(40)), 0::bigint, 'session mismatch writes no requests');
select is((select count(*) from public.session_participants where first_name = 'Stale'), 0::bigint, 'session mismatch creates no participant');

-- Submit ---------------------------------------------------------------------------
set local role service_role;
select is(
  public.submit_checkin('tag0000000000000001', 'd0000000-0000-4000-8000-000000000001'::uuid, pg_temp.device(10), pg_temp.ip(10), '  Nina ', 'New', 'beginner', 'male') ->> 'was_already_pending',
  'false',
  'a player submits a pending request'
);
select is(
  public.submit_checkin('tag0000000000000001', 'd0000000-0000-4000-8000-000000000001'::uuid, pg_temp.device(10), pg_temp.ip(10), 'Nina', 'Again', 'beginner', 'male') ->> 'was_already_pending',
  'true',
  'a second submit from the same phone returns the existing pending request'
);
reset role;
select results_eq(
  $$select first_name::text, last_name::text, skill_level::text, status::text, device_token_hash::text = pg_temp.device(10)
    from public.checkin_requests where session_id = 'd0000000-0000-4000-8000-000000000001'$$,
  $$values ('Nina', 'New', 'beginner', 'pending', true)$$,
  'one trimmed pending request exists, storing only the device token hash'
);
select is(
  (select count(*) from public.checkin_attempts where kind = 'submit' and device_token_hash = pg_temp.device(10)),
  2::bigint,
  'every submit that got past validation was recorded, early returns included'
);

-- Submit rate limits: 10 per device, 30 per IP in the window.
insert into public.checkin_attempts (kind, session_id, device_token_hash, ip_hash)
select 'submit', 'd0000000-0000-4000-8000-000000000001', pg_temp.device(20), pg_temp.ip(200 + n)
from generate_series(1, 10) as n;
insert into public.checkin_attempts (kind, session_id, device_token_hash, ip_hash)
select 'submit', 'd0000000-0000-4000-8000-000000000001', pg_temp.device(300 + n), pg_temp.ip(21)
from generate_series(1, 30) as n;
-- One short of the device limit: the next submit uses the last attempt.
insert into public.checkin_attempts (kind, session_id, device_token_hash, ip_hash)
select 'submit', 'd0000000-0000-4000-8000-000000000001', pg_temp.device(30), pg_temp.ip(400 + n)
from generate_series(1, 9) as n;
set local role service_role;
select throws_ok(
  $$select public.submit_checkin('tag0000000000000001', 'd0000000-0000-4000-8000-000000000001'::uuid, pg_temp.device(20), pg_temp.ip(99), 'Sam', 'Spam', 'beginner', 'male')$$,
  'P0001', 'RATE_LIMITED', 'submit is rate-limited per device'
);
select throws_ok(
  $$select public.submit_checkin('tag0000000000000001', 'd0000000-0000-4000-8000-000000000001'::uuid, pg_temp.device(99), pg_temp.ip(21), 'Sam', 'Spam', 'beginner', 'male')$$,
  'P0001', 'RATE_LIMITED', 'submit is rate-limited per IP'
);
select is(
  public.submit_checkin('tag0000000000000001', 'd0000000-0000-4000-8000-000000000001'::uuid, pg_temp.device(30), pg_temp.ip(30), 'Pat', 'Probe', 'beginner', 'male') ->> 'status',
  'pending',
  'the last allowed submit creates a request...'
);
select throws_ok(
  $$select public.submit_checkin('tag0000000000000001', 'd0000000-0000-4000-8000-000000000001'::uuid, pg_temp.device(30), pg_temp.ip(30), 'Pat', 'Probe', 'beginner', 'male')$$,
  'P0001', 'RATE_LIMITED', '...and a resubmit returning it still counts toward the device limit'
);

select is(
  public.submit_checkin('tag0000000000000001', 'd0000000-0000-4000-8000-000000000001'::uuid, pg_temp.device(11), pg_temp.ip(11), 'Grace', 'Kim', 'advanced', 'male') ->> 'status',
  'pending',
  'another player submits'
);
reset role;

-- Host decisions --------------------------------------------------------------------------
set local role service_role;
select throws_ok(
  $$select public.approve_checkin('a0000000-0000-4000-8000-000000000003', (select gen_random_uuid()), gen_random_uuid(), p_gender => 'male')$$,
  '42501', 'NOT_A_HOST', 'a non-host cannot approve'
);

select throws_ok(
  $$select public.approve_checkin('a0000000-0000-4000-8000-000000000002',
    (select id from public.checkin_requests where first_name = 'Nina'), null, p_gender => 'male')$$,
  '22023', 'INVALID_PARTICIPANT_ID', 'approval rejects a null participant ID without consuming the pending request'
);

-- Draft: approval creates the participant from the request; no event.
select is(
  public.approve_checkin('a0000000-0000-4000-8000-000000000002',
    (select id from public.checkin_requests where first_name = 'Nina'),
    'e0000000-0000-4000-8000-000000000010'
  , p_gender => 'male') ->> 'status',
  'approved',
  'a host approves a request into a draft'
);
reset role;
select results_eq(
  $$select participant.first_name::text, participant.last_name::text, participant.skill_level::text,
           request.status::text, request.decided_by
    from public.checkin_requests as request
    join public.session_participants as participant on participant.id = request.session_participant_id
    where request.first_name = 'Nina'$$,
  $$values ('Nina'::text, 'New'::text, 'beginner'::text, 'approved'::text, 'a0000000-0000-4000-8000-000000000002'::uuid)$$,
  'approval created the participant from the request''s name and level and recorded the decision'
);
select is_empty($$select 1 from public.session_events where session_id = 'd0000000-0000-4000-8000-000000000001'$$, 'approving into a draft appends no event');

set local role service_role;
select is(
  public.approve_checkin('a0000000-0000-4000-8000-000000000002', (select id from public.checkin_requests where first_name = 'Nina'), 'e0000000-0000-4000-8000-000000000010', p_gender => 'male') ->> 'status',
  'already_approved',
  'approving twice is idempotent'
);

-- Reject.
reset role;
insert into public.checkin_requests (id, session_id, social_id, first_name, last_name, skill_level, device_token_hash, ip_hash) values
  ('c1000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000003', 'Rex', 'Reject', 'beginner', repeat('d', 64), repeat('d', 64));
set local role service_role;
select is(public.reject_checkin('a0000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001') ->> 'status', 'rejected', 'a host rejects a request');
select is(public.reject_checkin('a0000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001') ->> 'status', 'already_rejected', 'rejecting twice is idempotent');
select throws_ok(
  $$select public.approve_checkin('a0000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', gen_random_uuid(), p_gender => 'male')$$,
  'P0001', 'CHECKIN_REQUEST_NOT_PENDING', 'a rejected request cannot be approved'
);
select throws_ok(
  $$select public.reject_checkin('a0000000-0000-4000-8000-000000000002', gen_random_uuid())$$,
  'P0002', 'CHECKIN_REQUEST_NOT_FOUND', 'rejecting an unknown request fails'
);

-- Live: approval appends PlayerJoined atomically.
select public.start_session('a0000000-0000-4000-8000-000000000002',
  'd0000000-0000-4000-8000-000000000001', gen_random_uuid(), now(),
  '{"config":{"participants":[{"participantId":"e0000000-0000-4000-8000-000000000010"}]},"initialAttendeeIds":["e0000000-0000-4000-8000-000000000010"]}'
);
select throws_ok(
  $$select public.approve_checkin('a0000000-0000-4000-8000-000000000002', (select id from public.checkin_requests where device_token_hash = pg_temp.device(11)), 'e0000000-0000-4000-8000-000000000011', p_gender => 'male')$$,
  '22023', 'EVENT_REQUIRED', 'approving into a live session needs the event arguments'
);
select throws_ok(
  $$select public.approve_checkin('a0000000-0000-4000-8000-000000000002', (select id from public.checkin_requests where device_token_hash = pg_temp.device(11)), 'e0000000-0000-4000-8000-000000000011',
      gen_random_uuid(), 0, now(), p_gender => 'male')$$,
  'P0001', 'STALE_EXPECTED_SEQ', 'a live approval with a stale seq is refused'
);
reset role;
select results_eq(
  $$select request.status::text,
           (select count(*) from public.session_participants where id = 'e0000000-0000-4000-8000-000000000011')
    from public.checkin_requests as request
    where request.device_token_hash = pg_temp.device(11)$$,
  $$values ('pending'::text, 0::bigint)$$,
  'the refused approval changed nothing (atomic)'
);
set local role service_role;
select is(
  public.approve_checkin('a0000000-0000-4000-8000-000000000002', (select id from public.checkin_requests where device_token_hash = pg_temp.device(11)), 'e0000000-0000-4000-8000-000000000011',
    'f0000000-0000-4000-8000-000000000020', 1, now(), p_gender => 'male') -> 'event' ->> 'seq',
  '2',
  'a live approval appends the PlayerJoined event'
);
reset role;
select results_eq(
  $$select type::text, payload from public.session_events where event_id = 'f0000000-0000-4000-8000-000000000020'$$,
  $$values ('PlayerJoined', '{"participant":{"participantId":"e0000000-0000-4000-8000-000000000011","firstName":"Grace","lastName":"Kim","skill":"advanced","gender":"male"}}'::jsonb)$$,
  'the PlayerJoined snapshot carries the request''s name and level (no isGuest)'
);

-- Already checked in: only this phone's own approved request answers it; any
-- other phone with the same name gets an ordinary pending request (no leak).
set local role service_role;
select is(
  public.submit_checkin('tag0000000000000001', 'd0000000-0000-4000-8000-000000000001'::uuid, pg_temp.device(11), pg_temp.ip(11), 'Someone', 'Else', 'beginner', 'male'),
  '{"status":"already_checked_in"}'::jsonb,
  'the phone whose request was approved is told it is already checked in'
);
select is(
  public.submit_checkin('tag0000000000000001', 'd0000000-0000-4000-8000-000000000001'::uuid, pg_temp.device(12), pg_temp.ip(12), 'Grace', 'Kim', 'advanced', 'male') ->> 'status',
  'pending',
  'another phone naming an attending player gets a pending request (no attendance leak)'
);
select throws_ok(
  $$select public.approve_checkin('a0000000-0000-4000-8000-000000000002', (select id from public.checkin_requests where device_token_hash = pg_temp.device(12)), gen_random_uuid(), gen_random_uuid(), 2, now(), p_gender => 'male')$$,
  'P0001', 'NAME_ALREADY_IN_SESSION', 'a name already in the session cannot be approved'
);
reset role;
select results_eq(
  $$select request.status::text, (select last_seq from public.sessions where id = 'd0000000-0000-4000-8000-000000000001')
    from public.checkin_requests as request where request.device_token_hash = pg_temp.device(12)$$,
  $$values ('pending'::text, 2)$$,
  'the refused approval leaves the request pending and appends nothing'
);

select * from finish();
rollback;
