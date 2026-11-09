-- Public check-in functions (guards, privacy, rate limits) and the host's
-- approve / reject (atomic, including the live PlayerJoined event). Everything
-- runs as service_role, as the server does (anon access is tested in 01).
begin;
create extension if not exists pgtap with schema extensions;
select plan(46);

insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-000000000002', 'pgtap-host@example.test'),
  ('a0000000-0000-4000-8000-000000000003', 'pgtap-outsider@example.test');
-- The sticker tag belongs to the social; its host's open session answers it.
insert into public.socials (id, name, checkin_tag) values
  ('50000000-0000-4000-8000-000000000003', 'pgTAP Social', 'tag0000000000000001');
insert into public.hosts (user_id, display_name, social_id) values
  ('a0000000-0000-4000-8000-000000000002', 'Hal Host', '50000000-0000-4000-8000-000000000003');
insert into public.sessions (id, host_id, name, host_name, planned_start, planned_end) values
  ('d0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'Tuesday social', 'Hal Host', now(), now() + interval '2 hours');
insert into public.members (social_id, id, first_name, last_name, skill_level, is_active) values
  ('50000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001', 'Grace', 'Kim', 'advanced', true),
  ('50000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000002', 'Grant', 'Lee', null, true),
  ('50000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000003', 'Gregory', 'Hill', 'beginner', true),
  ('50000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000004', 'Greer', 'Moss', 'beginner', true),
  ('50000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000005', 'Gray', 'Ng', 'beginner', true),
  ('50000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000006', 'Gretchen', 'Ode', 'beginner', true),
  ('50000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000007', 'Greta', 'Gone', 'beginner', false),
  ('50000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000008', 'Kofi', 'Grady', 'intermediate', true);

-- Test-only shorthands.
-- The device token hash the server passes (SHA-256 of the cookie token).
create function pg_temp.device(p_number integer) returns text language sql as $$
  select encode(sha256(convert_to('device-token-' || p_number, 'UTF8')), 'hex')
$$;
create function pg_temp.ip(p_number integer) returns text language sql as $$
  select encode(sha256(convert_to('ip-' || p_number, 'UTF8')), 'hex')
$$;
grant execute on all functions in schema pg_temp to service_role;

-- Search ---------------------------------------------------------------------------
set local role service_role;
select is_empty(
  $$select * from public.search_checkin_names('tag0000000000000001', 'g', pg_temp.device(1), pg_temp.ip(1))$$,
  'search returns nothing for fewer than 2 letters'
);
select is(
  (select count(*) from public.search_checkin_names('tag0000000000000001', 'gr', pg_temp.device(1), pg_temp.ip(1))),
  5::bigint,
  'search returns at most 5 names'
);
select is_empty(
  $$select * from public.search_checkin_names('tag0000000000000001', 'Greta', pg_temp.device(1), pg_temp.ip(1))$$,
  'search never returns deactivated members'
);
select results_eq(
  $$select * from public.search_checkin_names('tag0000000000000001', '  GRADY ', pg_temp.device(1), pg_temp.ip(1))$$,
  $$values ('b0000000-0000-4000-8000-000000000008'::uuid, 'Kofi'::text, 'Grady'::text)$$,
  'search matches last names case-insensitively and returns only the id and names'
);
select results_eq(
  $$select first_name from public.search_checkin_names('tag0000000000000001', 'grace k', pg_temp.device(1), pg_temp.ip(1))$$,
  $$values ('Grace'::text)$$,
  'search matches a full-name prefix'
);
select throws_ok(
  $$select * from public.search_checkin_names('tag0000000000000009', 'gr', pg_temp.device(1), pg_temp.ip(1))$$,
  'P0002', 'NO_OPEN_SESSION', 'search needs a known tag'
);
select throws_ok(
  $$select * from public.search_checkin_names('not a tag!', 'gr', pg_temp.device(1), pg_temp.ip(1))$$,
  'P0002', 'NO_OPEN_SESSION', 'a malformed tag gives the same answer as an unknown one'
);
select throws_ok(
  $$select * from public.search_checkin_names('tag0000000000000001', 'gr%', pg_temp.device(1), pg_temp.ip(1))$$,
  '22023', 'INVALID_INPUT', 'search refuses LIKE wildcards and other symbols'
);
select throws_ok(
  $$select * from public.search_checkin_names('tag0000000000000001', 'gr', 'raw-device-token', pg_temp.ip(1))$$,
  '22023', 'INVALID_INPUT', 'search refuses anything but a device token hash'
);
select throws_ok(
  $$select * from public.search_checkin_names('tag0000000000000001', 'gr', pg_temp.device(1), 'not-a-hash')$$,
  '22023', 'INVALID_INPUT', 'search refuses a malformed IP hash'
);
reset role;

-- Closed check-in hides the session.
update public.sessions set checkin_open = false where id = 'd0000000-0000-4000-8000-000000000001';
set local role service_role;
select throws_ok(
  $$select * from public.search_checkin_names('tag0000000000000001', 'gr', pg_temp.device(1), pg_temp.ip(1))$$,
  'P0002', 'NO_OPEN_SESSION', 'search needs the session''s check-in to be open'
);
reset role;
update public.sessions set checkin_open = true where id = 'd0000000-0000-4000-8000-000000000001';

-- Search rate limits.
insert into public.checkin_attempts (kind, session_id, device_token_hash, ip_hash)
select 'search', 'd0000000-0000-4000-8000-000000000001', pg_temp.device(2), pg_temp.ip(2)
from generate_series(1, 30);
insert into public.checkin_attempts (kind, session_id, device_token_hash, ip_hash)
select 'search', 'd0000000-0000-4000-8000-000000000001', pg_temp.device(100 + n), pg_temp.ip(3)
from generate_series(1, 120) as n;
set local role service_role;
select throws_ok(
  $$select * from public.search_checkin_names('tag0000000000000001', 'gr', pg_temp.device(2), pg_temp.ip(9))$$,
  'P0001', 'RATE_LIMITED', 'search is rate-limited per device'
);
select throws_ok(
  $$select * from public.search_checkin_names('tag0000000000000001', 'gr', pg_temp.device(9), pg_temp.ip(3))$$,
  'P0001', 'RATE_LIMITED', 'search is rate-limited per IP'
);

-- Submit ---------------------------------------------------------------------------
select throws_ok(
  $$select public.submit_checkin('tag0000000000000001', pg_temp.device(10), pg_temp.ip(10), 'Nina', 'New')$$,
  '22023', 'INVALID_INPUT', 'a first-timer must give a skill level'
);
select throws_ok(
  $$select public.submit_checkin('tag0000000000000001', pg_temp.device(10), pg_temp.ip(10), '   ', 'New', 'beginner')$$,
  '22023', 'INVALID_NAME', 'a blank name is refused'
);
select throws_ok(
  $$select public.submit_checkin('tag0000000000000001', pg_temp.device(10), pg_temp.ip(10), repeat('x', 51), 'New', 'beginner')$$,
  '22023', 'INVALID_NAME', 'an over-long name is refused'
);
select is(
  public.submit_checkin('tag0000000000000001', pg_temp.device(10), pg_temp.ip(10), 'Greta', 'Gone', null, 'b0000000-0000-4000-8000-000000000007') ->> 'status',
  'member_not_found',
  'a deactivated member cannot check in by id'
);
select throws_ok(
  $$select public.submit_checkin('tag0000000000000009', pg_temp.device(10), pg_temp.ip(10), 'Nina', 'New', 'beginner')$$,
  'P0002', 'NO_OPEN_SESSION', 'submit needs an open session'
);
select is(
  public.submit_checkin('tag0000000000000001', pg_temp.device(10), pg_temp.ip(10), '  Nina ', 'New', 'beginner') ->> 'was_already_pending',
  'false',
  'a first-timer submits a pending request'
);
select is(
  public.submit_checkin('tag0000000000000001', pg_temp.device(10), pg_temp.ip(10), 'Nina', 'Again', 'beginner') ->> 'was_already_pending',
  'true',
  'a second submit from the same phone returns the existing pending request'
);
reset role;
select results_eq(
  $$select first_name::text, status::text, device_token_hash::text = pg_temp.device(10)
    from public.checkin_requests where session_id = 'd0000000-0000-4000-8000-000000000001'$$,
  $$values ('Nina', 'pending', true)$$,
  'one trimmed pending request exists, storing only the device token hash'
);

select is(
  (select count(*) from public.checkin_attempts where kind = 'submit' and device_token_hash = pg_temp.device(10)),
  3::bigint,
  'every submit that got past validation was recorded, early returns included'
);

-- Submit rate limits: 10 per device, 30 per IP in the window.
insert into public.checkin_attempts (kind, session_id, device_token_hash, ip_hash)
select 'submit', 'd0000000-0000-4000-8000-000000000001', pg_temp.device(20), pg_temp.ip(200 + n)
from generate_series(1, 10) as n;
insert into public.checkin_attempts (kind, session_id, device_token_hash, ip_hash)
select 'submit', 'd0000000-0000-4000-8000-000000000001', pg_temp.device(300 + n), pg_temp.ip(21)
from generate_series(1, 30) as n;
-- One short of the device limit: the next early return (unknown member) uses the last attempt.
insert into public.checkin_attempts (kind, session_id, device_token_hash, ip_hash)
select 'submit', 'd0000000-0000-4000-8000-000000000001', pg_temp.device(30), pg_temp.ip(400 + n)
from generate_series(1, 9) as n;
set local role service_role;
select throws_ok(
  $$select public.submit_checkin('tag0000000000000001', pg_temp.device(20), pg_temp.ip(99), 'Sam', 'Spam', 'beginner')$$,
  'P0001', 'RATE_LIMITED', 'submit is rate-limited per device'
);
select throws_ok(
  $$select public.submit_checkin('tag0000000000000001', pg_temp.device(99), pg_temp.ip(21), 'Sam', 'Spam', 'beginner')$$,
  'P0001', 'RATE_LIMITED', 'submit is rate-limited per IP'
);
select is(
  public.submit_checkin('tag0000000000000001', pg_temp.device(30), pg_temp.ip(30), 'Pat', 'Probe', null, gen_random_uuid()) ->> 'status',
  'member_not_found',
  'a probe for an unknown member returns early...'
);
select throws_ok(
  $$select public.submit_checkin('tag0000000000000001', pg_temp.device(30), pg_temp.ip(30), 'Pat', 'Probe', null, gen_random_uuid())$$,
  'P0001', 'RATE_LIMITED', '...but still counts toward the device limit'
);

-- A returning member (by id), without a skill: uses the saved one on approval.
select is(
  public.submit_checkin('tag0000000000000001', pg_temp.device(11), pg_temp.ip(11), 'Grace', 'Kim-Lee', null, 'b0000000-0000-4000-8000-000000000001') ->> 'status',
  'pending',
  'a returning member submits by id'
);
reset role;

-- Host decisions --------------------------------------------------------------------------
set local role service_role;
select throws_ok(
  $$select public.approve_checkin('a0000000-0000-4000-8000-000000000003', (select gen_random_uuid()), gen_random_uuid())$$,
  '42501', 'NOT_A_HOST', 'a non-host cannot approve'
);
reset role;

set local role service_role;

-- Draft: first-timer approval creates member, device link and participant; no event.
select is(
  public.approve_checkin('a0000000-0000-4000-8000-000000000002', 
    (select id from public.checkin_requests where first_name = 'Nina'),
    'e0000000-0000-4000-8000-000000000010'
  ) ->> 'status',
  'approved',
  'a host approves a first-timer into a draft'
);
reset role;
select results_eq(
  $$select member.first_name::text, member.skill_level::text, member.last_checked_in_at is not null,
           participant.is_guest, request.status::text, request.decided_by
    from public.checkin_requests as request
    join public.members as member on member.id = request.member_id
    join public.session_participants as participant on participant.id = request.session_participant_id
    where request.first_name = 'Nina'$$,
  $$values ('Nina'::text, 'beginner'::text, true, false, 'approved'::text, 'a0000000-0000-4000-8000-000000000002'::uuid)$$,
  'approval created the member and participant and recorded the decision'
);
select is(
  (select device.member_id from public.member_devices as device
   where device.token_hash = pg_temp.device(10)),
  (select member_id from public.checkin_requests where first_name = 'Nina'),
  'approval linked the phone (by hash) to the new member'
);
select is_empty($$select 1 from public.session_events where session_id = 'd0000000-0000-4000-8000-000000000001'$$, 'approving into a draft appends no event');

set local role service_role;
select is(
  public.approve_checkin('a0000000-0000-4000-8000-000000000002', (select id from public.checkin_requests where first_name = 'Nina'), 'e0000000-0000-4000-8000-000000000010') ->> 'status',
  'already_approved',
  'approving twice is idempotent'
);

-- Reject.
reset role;
insert into public.checkin_requests (id, session_id, first_name, last_name, skill_level, device_token_hash, ip_hash) values
  ('c1000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'Rex', 'Reject', 'beginner', repeat('d', 64), repeat('d', 64));
set local role service_role;
select is(public.reject_checkin('a0000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001') ->> 'status', 'rejected', 'a host rejects a request');
select is(public.reject_checkin('a0000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001') ->> 'status', 'already_rejected', 'rejecting twice is idempotent');
select throws_ok(
  $$select public.approve_checkin('a0000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', gen_random_uuid())$$,
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
  $$select public.approve_checkin('a0000000-0000-4000-8000-000000000002', (select id from public.checkin_requests where last_name = 'Kim-Lee'), 'e0000000-0000-4000-8000-000000000011')$$,
  '22023', 'EVENT_REQUIRED', 'approving into a live session needs the event arguments'
);
select throws_ok(
  $$select public.approve_checkin('a0000000-0000-4000-8000-000000000002', (select id from public.checkin_requests where last_name = 'Kim-Lee'), 'e0000000-0000-4000-8000-000000000011',
      gen_random_uuid(), 0, now())$$,
  'P0001', 'STALE_EXPECTED_SEQ', 'a live approval with a stale seq is refused'
);
reset role;
select results_eq(
  $$select request.status::text, member.last_name::text,
           (select count(*) from public.session_participants where member_id = 'b0000000-0000-4000-8000-000000000001')
    from public.checkin_requests as request
    join public.members as member on member.id = 'b0000000-0000-4000-8000-000000000001'
    where request.last_name = 'Kim-Lee'$$,
  $$values ('pending'::text, 'Kim'::text, 0::bigint)$$,
  'the refused approval changed nothing (atomic)'
);
set local role service_role;
select is(
  public.approve_checkin('a0000000-0000-4000-8000-000000000002', (select id from public.checkin_requests where last_name = 'Kim-Lee'), 'e0000000-0000-4000-8000-000000000011',
    'f0000000-0000-4000-8000-000000000020', 1, now()) -> 'event' ->> 'seq',
  '2',
  'a live approval appends the PlayerJoined event'
);
reset role;
select results_eq(
  $$select type::text, payload from public.session_events where event_id = 'f0000000-0000-4000-8000-000000000020'$$,
  $$values ('PlayerJoined', '{"participant":{"participantId":"e0000000-0000-4000-8000-000000000011","firstName":"Grace","lastName":"Kim-Lee","skill":"advanced","isGuest":false}}'::jsonb)$$,
  'the PlayerJoined snapshot uses the approved name and the member''s saved skill'
);
select is(
  (select last_name::text from public.members where id = 'b0000000-0000-4000-8000-000000000001'),
  'Kim-Lee',
  'approval saved the returning member''s edited details'
);

-- Already checked in, and a member's existing participant id must be reused.
set local role service_role;
select is(
  public.submit_checkin('tag0000000000000001', pg_temp.device(12), pg_temp.ip(12), 'Grace', 'Kim-Lee', null, 'b0000000-0000-4000-8000-000000000001') ->> 'status',
  'already_checked_in',
  'a member already in the session is told so'
);
select is(
  public.submit_checkin('tag0000000000000001', pg_temp.device(13), pg_temp.ip(13), 'Grant', 'Lee', null, 'b0000000-0000-4000-8000-000000000002') ->> 'status',
  'pending',
  'another member submits'
);
reset role;
-- Grant is already a participant from an earlier hand-add (e.g. left and came back).
insert into public.session_participants (id, session_id, member_id, first_name, last_name) values
  ('e0000000-0000-4000-8000-000000000012', 'd0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002', 'Grant', 'Lee');
set local role service_role;
select throws_ok(
  $$select public.approve_checkin('a0000000-0000-4000-8000-000000000002', (select id from public.checkin_requests where first_name = 'Grant'), gen_random_uuid(), gen_random_uuid(), 2, now())$$,
  '22023', 'PARTICIPANT_ID_MISMATCH', 'approval must reuse the member''s existing participant id'
);
reset role;

select * from finish();
rollback;
