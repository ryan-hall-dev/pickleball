-- Check-in, database, after session-only participants (20261112090000;
-- docs/plans/session-only-participants.md): privileges; the status type;
-- submit's privacy rule (already_checked_in only for the phone whose own
-- request in this session was approved; never a name lookup) and
-- resubmission after a rejection or withdrawal; the public page read
-- (inactive / no open session / open, the phone's current request, nothing
-- from other socials); the host tray's name-clash flag; approve refusing a
-- name already in the session; manager-only tag reissue. Functions run as
-- service_role, as the server does.
begin;
create extension if not exists pgtap with schema extensions;
select plan(60);

-- Fixtures (as the table owner) -----------------------------------------------
insert into auth.users (id, email) values
  ('a1200000-0000-4000-8000-000000000001', 'pgtap-m5-manager@example.test'),
  ('a1200000-0000-4000-8000-000000000002', 'pgtap-m5-host@example.test'),
  ('a1200000-0000-4000-8000-000000000003', 'pgtap-m5-other-host@example.test'),
  ('a1200000-0000-4000-8000-000000000004', 'pgtap-m5-quiet-manager@example.test'),
  ('a1200000-0000-4000-8000-000000000005', 'pgtap-m5-outsider@example.test');
insert into public.socials (id, name, checkin_tag) values
  ('51200000-0000-4000-8000-000000000001', 'M5 Social', 'tagm5social000001'),
  ('51200000-0000-4000-8000-000000000002', 'Other Social', 'tagm5other0000001'),
  ('51200000-0000-4000-8000-000000000003', 'Quiet Social', 'tagm5quiet0000001');
insert into public.hosts (user_id, display_name, role, social_id) values
  ('a1200000-0000-4000-8000-000000000001', 'Mia Manager', 'manager', '51200000-0000-4000-8000-000000000001'),
  ('a1200000-0000-4000-8000-000000000002', 'Hal Host', 'host', '51200000-0000-4000-8000-000000000001'),
  ('a1200000-0000-4000-8000-000000000003', 'Oli Other', 'manager', '51200000-0000-4000-8000-000000000002'),
  ('a1200000-0000-4000-8000-000000000004', 'Quinn Quiet', 'manager', '51200000-0000-4000-8000-000000000003');
-- M5 Social: an open draft with 2 courts selected, plus an older cancelled
-- draft. Other Social: a live session with 1 court. Quiet Social: nothing open.
insert into public.sessions (id, social_id, host_id, name, host_name, planned_start, planned_end, status, started_at, config_snapshot) values
  ('d1200000-0000-4000-8000-000000000001', '51200000-0000-4000-8000-000000000001', 'a1200000-0000-4000-8000-000000000002',
   'M5 draft', 'Hal Host', '2026-11-11 18:00+00', '2026-11-11 20:00+00', 'draft', null,
   '{"courts":[{"courtId":"c1200000-0000-4000-8000-000000000001","name":"Court 1","format":"doubles"},{"courtId":"c1200000-0000-4000-8000-000000000002","name":"Court 2","format":"doubles"}]}'),
  ('d1200000-0000-4000-8000-000000000009', '51200000-0000-4000-8000-000000000001', 'a1200000-0000-4000-8000-000000000002',
   'Old cancelled', 'Hal Host', '2026-11-01 18:00+00', '2026-11-01 20:00+00', 'cancelled', null, null),
  ('d1200000-0000-4000-8000-000000000002', '51200000-0000-4000-8000-000000000002', 'a1200000-0000-4000-8000-000000000003',
   'Other live', 'Oli Other', '2026-11-11 18:00+00', '2026-11-11 20:00+00', 'live', now(),
   '{"courts":[{"courtId":"c1200000-0000-4000-8000-000000000003","name":"Court A","format":"doubles"}]}');
-- Test-only shorthands (the hashes the server passes).
create function pg_temp.device(p_number integer) returns text language sql as $$
  select encode(sha256(convert_to('m5-device-token-' || p_number, 'UTF8')), 'hex')
$$;
create function pg_temp.ip(p_number integer) returns text language sql as $$
  select encode(sha256(convert_to('m5-ip-' || p_number, 'UTF8')), 'hex')
$$;
grant execute on all functions in schema pg_temp to service_role;

-- Attending the draft: four players (approved check-ins or host-added).
insert into public.session_participants (id, session_id, social_id, first_name, last_name, skill_level) values
  ('e1200000-0000-4000-8000-000000000001', 'd1200000-0000-4000-8000-000000000001', '51200000-0000-4000-8000-000000000001', 'Élodie', 'Durand', 'advanced'),
  ('e1200000-0000-4000-8000-000000000002', 'd1200000-0000-4000-8000-000000000001', '51200000-0000-4000-8000-000000000001', 'Sam', 'Smith', 'intermediate'),
  ('e1200000-0000-4000-8000-000000000003', 'd1200000-0000-4000-8000-000000000001', '51200000-0000-4000-8000-000000000001', 'Gus', 'Guest', 'beginner'),
  ('e1200000-0000-4000-8000-000000000004', 'd1200000-0000-4000-8000-000000000001', '51200000-0000-4000-8000-000000000001', 'Mary', 'Ann Lee', 'advanced');

-- Privileges and schema ----------------------------------------------------------
select is(
  (select count(*) from pg_proc
   where oid in (
     'public.get_checkin_page(text, text)'::regprocedure,
     'public.list_checkin_requests_for_open_session(uuid)'::regprocedure,
     'public.reissue_checkin_tag(uuid)'::regprocedure,
     'public.submit_checkin(text, uuid, text, text, text, text, public.skill_level, text)'::regprocedure,
     'public.approve_checkin(uuid, uuid, uuid, uuid, integer, timestamptz, text)'::regprocedure,
     'public.add_draft_participant(uuid, uuid, uuid, text, text, public.skill_level, text)'::regprocedure,
     'public.add_participant_mid_session(uuid, uuid, uuid, text, text, public.skill_level, uuid, integer, timestamptz, text, boolean)'::regprocedure
   )
   and prosecdef
   and proconfig = array['search_path=""']
   and has_function_privilege('service_role', oid, 'execute')
   and not has_function_privilege('anon', oid, 'execute')
   and not has_function_privilege('authenticated', oid, 'execute')),
  7::bigint,
  'the new and changed functions are security definer with an empty search_path, service_role only'
);
select hasnt_function('public', 'search_checkin_names', 'member search is gone');
select hasnt_function('public', 'close_checkin_already_checked_in', 'closing as already checked in is gone');
select hasnt_function(
  'public', 'submit_checkin', array['text', 'text', 'text', 'text', 'text', 'skill_level', 'uuid'],
  'the member-era submit_checkin is gone'
);
select hasnt_function(
  'public', 'submit_checkin', array['text', 'text', 'text', 'text', 'text', 'skill_level'],
  'the unbound six-argument submit_checkin is gone'
);
select is(
  enum_range(null::public.checkin_request_status)::text[],
  array['pending', 'approved', 'rejected', 'withdrawn'],
  'a request is pending, approved, rejected or withdrawn (no already_checked_in)'
);
select col_not_null('public', 'checkin_requests', 'skill_level', 'every request has a level');
select is(
  (select count(*) from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'anon'),
  0::bigint,
  'anon still has no privilege on any public table'
);
set local role anon;
select throws_ok(
  $$select public.get_checkin_page('tagm5social000001', null)$$,
  '42501', null, 'anon cannot read the check-in page directly'
);
select throws_ok(
  $$select * from public.list_checkin_requests_for_open_session('a1200000-0000-4000-8000-000000000002')$$,
  '42501', null, 'anon cannot read the tray'
);
select throws_ok(
  $$select public.reissue_checkin_tag('a1200000-0000-4000-8000-000000000001')$$,
  '42501', null, 'anon cannot reissue a tag'
);
reset role;
select set_config('request.jwt.claims', '{"sub":"a1200000-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$select public.get_checkin_page('tagm5social000001', null)$$,
  '42501', null, 'a signed-in host cannot call the page read with their own session'
);
select throws_ok(
  $$select public.add_draft_participant('a1200000-0000-4000-8000-000000000002', 'd1200000-0000-4000-8000-000000000001', gen_random_uuid(), 'Kai', 'Lee', 'beginner', 'male')$$,
  '42501', null, 'a signed-in host cannot add a participant with their own session'
);
reset role;

-- Submit: no name lookup, one pending request per phone ---------------------------
set local role service_role;
select is(
  public.submit_checkin('tagm5social000001', 'd1200000-0000-4000-8000-000000000001'::uuid, pg_temp.device(1), pg_temp.ip(1), ' Élodie ', 'Durand', 'advanced', 'male') - 'checkin_request_id',
  '{"status":"pending","was_already_pending":false}'::jsonb,
  'a name that is already attending gets an ordinary pending request (no attendance leak)'
);
select is(
  public.submit_checkin('tagm5social000001', 'd1200000-0000-4000-8000-000000000001'::uuid, pg_temp.device(1), pg_temp.ip(1), 'Someone', 'Else', 'beginner', 'male') ->> 'was_already_pending',
  'true',
  'a repeat from the same phone returns its existing request'
);
select is(
  public.submit_checkin('tagm5social000001', 'd1200000-0000-4000-8000-000000000001'::uuid, pg_temp.device(2), pg_temp.ip(2), 'Zoë', 'Núñez', 'intermediate', 'male') ->> 'status',
  'pending',
  'another phone submits'
);
reset role;
select results_eq(
  $$select first_name::text || ' ' || last_name::text, skill_level::text from public.checkin_requests
    where device_token_hash = pg_temp.device(1)$$,
  $$values ('Élodie Durand'::text, 'advanced'::text)$$,
  'one request for phone 1, with the names it first sent (trimmed)'
);

-- Tray fixtures (explicit times give a stable order), plus requests the tray must leave out.
update public.checkin_requests set created_at = now() - interval '10 minutes' where device_token_hash = pg_temp.device(1);
update public.checkin_requests set created_at = now() - interval '9 minutes' where device_token_hash = pg_temp.device(2);
insert into public.checkin_requests (id, session_id, social_id, first_name, last_name, skill_level, device_token_hash, ip_hash, created_at, status, decided_at) values
  ('c1200000-0000-4000-8000-000000000003', 'd1200000-0000-4000-8000-000000000001', '51200000-0000-4000-8000-000000000001', 'SÁM', 'smith', 'beginner', pg_temp.device(23), pg_temp.ip(20), now() - interval '8 minutes', 'pending', null),
  ('c1200000-0000-4000-8000-000000000004', 'd1200000-0000-4000-8000-000000000001', '51200000-0000-4000-8000-000000000001', 'gus', 'GUEST', 'beginner', pg_temp.device(24), pg_temp.ip(20), now() - interval '7 minutes', 'pending', null),
  ('c1200000-0000-4000-8000-000000000005', 'd1200000-0000-4000-8000-000000000001', '51200000-0000-4000-8000-000000000001', 'Mary  Ann', 'Lee', 'advanced', pg_temp.device(25), pg_temp.ip(20), now() - interval '6 minutes', 'pending', null),
  ('c1200000-0000-4000-8000-000000000006', 'd1200000-0000-4000-8000-000000000001', '51200000-0000-4000-8000-000000000001', 'Nora', 'New', 'beginner', pg_temp.device(26), pg_temp.ip(20), now() - interval '5 minutes', 'pending', null),
  ('c1200000-0000-4000-8000-000000000007', 'd1200000-0000-4000-8000-000000000001', '51200000-0000-4000-8000-000000000001', 'Rex', 'Rejected', 'beginner', pg_temp.device(27), pg_temp.ip(20), now() - interval '4 minutes', 'rejected', now()),
  ('c1200000-0000-4000-8000-000000000008', 'd1200000-0000-4000-8000-000000000009', '51200000-0000-4000-8000-000000000001', 'Olga', 'Old', 'beginner', pg_temp.device(28), pg_temp.ip(20), now() - interval '20 minutes', 'pending', null),
  ('c1200000-0000-4000-8000-000000000009', 'd1200000-0000-4000-8000-000000000002', '51200000-0000-4000-8000-000000000002', 'Sam', 'Smith', 'beginner', pg_temp.device(29), pg_temp.ip(20), now() - interval '3 minutes', 'pending', null);

-- Public page read ---------------------------------------------------------------
set local role service_role;
select is(
  public.get_checkin_page('tagm5unknown00001', pg_temp.device(1)),
  '{"status":"inactive"}'::jsonb,
  'an unknown tag is inactive and reveals nothing else'
);
select is(
  public.get_checkin_page('not a tag!', null),
  '{"status":"inactive"}'::jsonb,
  'a malformed tag is inactive too'
);
select is(
  public.get_checkin_page('tagm5quiet0000001', pg_temp.device(1)),
  '{"status":"no_open_session","social_name":"Quiet Social"}'::jsonb,
  'a social with nothing open shows only its name'
);
reset role;
update public.sessions set checkin_open = false where id = 'd1200000-0000-4000-8000-000000000001';
set local role service_role;
select is(
  public.get_checkin_page('tagm5social000001', pg_temp.device(1)),
  '{"status":"no_open_session","social_name":"M5 Social"}'::jsonb,
  'an open session with check-in closed counts as nothing open'
);
reset role;
update public.sessions set checkin_open = true where id = 'd1200000-0000-4000-8000-000000000001';
set local role service_role;
select set_eq(
  $$select jsonb_object_keys(public.get_checkin_page('tagm5social000001', pg_temp.device(1)))$$,
  array['status', 'social_name', 'session', 'current_request', 'roster_claim', 'roster_transfer_request', 'now'],
  'an open page has exactly the documented keys (no recognised member)'
);
select is(
  public.get_checkin_page('tagm5social000001', pg_temp.device(1)) -> 'session',
  jsonb_build_object(
    'id', 'd1200000-0000-4000-8000-000000000001'::uuid,
    'name', 'M5 draft', 'status', 'draft',
    'planned_start', '2026-11-11 18:00+00'::timestamptz, 'planned_end', '2026-11-11 20:00+00'::timestamptz,
    'duration_minutes', 120, 'started_at', null, 'ends_at', null,
    'courts_count', 2, 'checked_in_count', 4,
    'has_roster', false, 'walk_ins_open', true
  ),
  'the header carries the session name, status, planned times, selected courts and attendance count'
);
select is(
  (public.get_checkin_page('tagm5social000001', pg_temp.device(1)) ->> 'now')::timestamptz,
  now(),
  'the page carries the database time'
);
select is(
  public.get_checkin_page('tagm5social000001', pg_temp.device(1)) -> 'current_request',
  jsonb_build_object(
    'id', (select id from public.checkin_requests where device_token_hash = pg_temp.device(1)),
    'status', 'pending', 'first_name', 'Élodie'
  ),
  'the phone''s own request in this session is its current request'
);
select is(
  public.get_checkin_page('tagm5social000001', pg_temp.device(5)) -> 'current_request',
  'null'::jsonb,
  'a phone with no request in this session has no current request'
);
select is(
  public.get_checkin_page('tagm5social000001', null) - 'now' - 'session',
  '{"status":"open","social_name":"M5 Social","current_request":null,"roster_claim":null,"roster_transfer_request":null}'::jsonb,
  'no device hash: no request'
);
select is(
  public.get_checkin_page('tagm5other0000001', pg_temp.device(1)) - 'now' - 'session',
  '{"status":"open","social_name":"Other Social","current_request":null,"roster_claim":null,"roster_transfer_request":null}'::jsonb,
  'another social''s page knows nothing of this phone''s request'
);
select is(
  public.get_checkin_page('tagm5other0000001', null) -> 'session',
  jsonb_build_object(
    'id', 'd1200000-0000-4000-8000-000000000002'::uuid,
    'name', 'Other live', 'status', 'live',
    'planned_start', '2026-11-11 18:00+00'::timestamptz, 'planned_end', '2026-11-11 20:00+00'::timestamptz,
    'duration_minutes', 120, 'started_at', now(), 'ends_at', now() + interval '120 minutes',
    'courts_count', 1, 'checked_in_count', 0,
    'has_roster', false, 'walk_ins_open', true
  ),
  'a live session shows status live and the courts enabled at the start'
);
select throws_ok(
  $$select public.get_checkin_page('tagm5social000001', 'raw-device-token')$$,
  '22023', 'INVALID_INPUT', 'the page read refuses anything but a device token hash'
);
select is(
  (select count(*) from public.checkin_attempts where device_token_hash = pg_temp.device(1)),
  2::bigint,
  'phone 1''s page reads recorded no rate-limit attempt (only its two submits)'
);

-- Host tray ----------------------------------------------------------------------
select results_eq(
  $$select first_name, last_name, skill_level::text, is_name_already_in_session
    from public.list_checkin_requests_for_open_session('a1200000-0000-4000-8000-000000000002')$$,
  $$values
    ('Élodie'::text, 'Durand'::text, 'advanced'::text, true),
    ('Zoë', 'Núñez', 'intermediate', false),
    ('SÁM', 'smith', 'beginner', true),
    ('gus', 'GUEST', 'beginner', true),
    ('Mary  Ann', 'Lee', 'advanced', true),
    ('Nora', 'New', 'beginner', false)$$,
  'the tray lists the open session''s pending requests oldest first, flagging names already in the session (case, accents, spacing and the first/last split ignored)'
);
select is(
  (select count(*) from public.list_checkin_requests_for_open_session('a1200000-0000-4000-8000-000000000001')),
  6::bigint,
  'every host of the social (the manager too) sees the same tray'
);
select results_eq(
  $$select id, is_name_already_in_session from public.list_checkin_requests_for_open_session('a1200000-0000-4000-8000-000000000003')$$,
  $$values ('c1200000-0000-4000-8000-000000000009'::uuid, false)$$,
  'another social''s host sees only their own request, flagged only against their own session'
);
select is_empty(
  $$select * from public.list_checkin_requests_for_open_session('a1200000-0000-4000-8000-000000000004')$$,
  'a social with no open session has an empty tray'
);
select throws_ok(
  $$select * from public.list_checkin_requests_for_open_session('a1200000-0000-4000-8000-000000000005')$$,
  '42501', 'NOT_A_HOST', 'a non-host cannot read any tray'
);

-- Approve refuses a name already in the session -------------------------------------
select throws_ok(
  $$select public.approve_checkin('a1200000-0000-4000-8000-000000000002',
      (select id from public.checkin_requests where device_token_hash = pg_temp.device(1)), gen_random_uuid(), p_gender => 'male')$$,
  'P0001', 'NAME_ALREADY_IN_SESSION', 'approving a name already in the session is refused'
);
select throws_ok(
  $$select public.approve_checkin('a1200000-0000-4000-8000-000000000002', 'c1200000-0000-4000-8000-000000000003', gen_random_uuid(), p_gender => 'male')$$,
  'P0001', 'NAME_ALREADY_IN_SESSION', 'the clash ignores case and accents'
);
reset role;
select results_eq(
  $$select request.status::text, request.decided_by, request.session_participant_id,
           (select count(*) from public.session_participants where session_id = 'd1200000-0000-4000-8000-000000000001')
    from public.checkin_requests as request where request.device_token_hash = pg_temp.device(1)$$,
  $$values ('pending'::text, null::uuid, null::uuid, 4::bigint)$$,
  'the refused approval leaves the request pending and adds no participant'
);

-- Rejected: the same phone can send a fresh request (with a distinguishing name).
set local role service_role;
select is(
  public.reject_checkin('a1200000-0000-4000-8000-000000000002',
    (select id from public.checkin_requests where device_token_hash = pg_temp.device(1))) ->> 'status',
  'rejected',
  'the host rejects the clashing request'
);
select is(
  public.submit_checkin('tagm5social000001', 'd1200000-0000-4000-8000-000000000001'::uuid, pg_temp.device(1), pg_temp.ip(1), 'Élodie', 'Durand B', 'advanced', 'male') ->> 'was_already_pending',
  'false',
  'after a rejection the same phone sends a new pending request'
);
select is(
  public.get_checkin_page('tagm5social000001', pg_temp.device(1)) -> 'current_request' ->> 'status',
  'pending',
  'the page shows the new request, not the rejected one'
);
select is(
  public.approve_checkin('a1200000-0000-4000-8000-000000000002',
    (select id from public.checkin_requests where device_token_hash = pg_temp.device(1) and status = 'pending'),
    'e1200000-0000-4000-8000-000000000011', p_gender => 'male') ->> 'status',
  'approved',
  'the distinguishing name is approved'
);
select is(
  public.submit_checkin('tagm5social000001', 'd1200000-0000-4000-8000-000000000001'::uuid, pg_temp.device(1), pg_temp.ip(1), 'Élodie', 'Durand B', 'advanced', 'male'),
  '{"status":"already_checked_in"}'::jsonb,
  'the phone whose own request was approved is told it is already checked in'
);
select is(
  public.submit_checkin('tagm5social000001', 'd1200000-0000-4000-8000-000000000001'::uuid, pg_temp.device(6), pg_temp.ip(6), 'Élodie', 'Durand B', 'advanced', 'male') ->> 'status',
  'pending',
  'another phone with that same name still gets a pending request (no leak)'
);
reset role;
select is(
  (select count(*) from public.checkin_requests where device_token_hash = pg_temp.device(1)),
  2::bigint,
  'phone 1 has its rejected request and its approved one; the already-checked-in answer created nothing'
);

-- Withdrawn (host removed the participant): a fresh request again.
set local role service_role;
select is(
  public.remove_draft_participant('a1200000-0000-4000-8000-000000000002', 'e1200000-0000-4000-8000-000000000011') ->> 'status',
  'removed',
  'the host removes the approved participant'
);
-- Every row in this transaction shares now(): age phone 1's earlier requests
-- so "latest" is unambiguous, as it is between real requests.
reset role;
update public.checkin_requests set created_at = created_at - interval '1 minute'
where device_token_hash = pg_temp.device(1);
set local role service_role;
select is(
  public.submit_checkin('tagm5social000001', 'd1200000-0000-4000-8000-000000000001'::uuid, pg_temp.device(1), pg_temp.ip(1), 'Élodie', 'Durand B', 'advanced', 'male') ->> 'was_already_pending',
  'false',
  'after a withdrawal the same phone sends a new pending request'
);

-- Two requests with the same new name: only the first approval succeeds.
reset role;
insert into public.checkin_requests (id, session_id, social_id, first_name, last_name, skill_level, device_token_hash, ip_hash) values
  ('c1200000-0000-4000-8000-000000000031', 'd1200000-0000-4000-8000-000000000001', '51200000-0000-4000-8000-000000000001', 'Pat', 'Twin', 'beginner', pg_temp.device(31), pg_temp.ip(31)),
  ('c1200000-0000-4000-8000-000000000032', 'd1200000-0000-4000-8000-000000000001', '51200000-0000-4000-8000-000000000001', 'PAT', 'twin', 'advanced', pg_temp.device(32), pg_temp.ip(32));
set local role service_role;
select is(
  public.approve_checkin('a1200000-0000-4000-8000-000000000002', 'c1200000-0000-4000-8000-000000000031', gen_random_uuid(), p_gender => 'male') ->> 'status',
  'approved',
  'one host approves the first Pat Twin'
);
select results_eq(
  $$select is_name_already_in_session from public.list_checkin_requests_for_open_session('a1200000-0000-4000-8000-000000000002')
    where id = 'c1200000-0000-4000-8000-000000000032'$$,
  $$values (true)$$,
  'the second Pat Twin is now flagged in the tray'
);
select throws_ok(
  $$select public.approve_checkin('a1200000-0000-4000-8000-000000000001', 'c1200000-0000-4000-8000-000000000032', gen_random_uuid(), p_gender => 'male')$$,
  'P0001', 'NAME_ALREADY_IN_SESSION', 'another host approving the second Pat Twin is refused'
);
reset role;
select is(
  (select count(*) from public.session_participants
   where session_id = 'd1200000-0000-4000-8000-000000000001'
     and private.normalise_name_for_search(first_name || ' ' || last_name) = 'pat twin'),
  1::bigint,
  'exactly one Pat Twin is in the session'
);
set local role service_role;
select throws_ok(
  $$select public.add_draft_participant('a1200000-0000-4000-8000-000000000002', 'd1200000-0000-4000-8000-000000000001', gen_random_uuid(), 'Pat', 'Twin', 'beginner', 'male')$$,
  'P0001', 'NAME_ALREADY_IN_SESSION', 'a host cannot add an approved name by hand either'
);
reset role;

-- Tag reissue (manager only) ------------------------------------------------------
set local role service_role;
select throws_ok(
  $$select public.reissue_checkin_tag('a1200000-0000-4000-8000-000000000002')$$,
  '42501', 'NOT_A_MANAGER', 'an operational host cannot reissue the tag'
);
select throws_ok(
  $$select public.reissue_checkin_tag('a1200000-0000-4000-8000-000000000005')$$,
  '42501', 'NOT_A_HOST', 'a non-host cannot reissue a tag'
);
select matches(
  public.reissue_checkin_tag('a1200000-0000-4000-8000-000000000001'),
  '^[a-z0-9]{32}$',
  'the manager gets a fresh tag in the column default''s format'
);
reset role;
select results_eq(
  $$select (select checkin_tag from public.socials where id = '51200000-0000-4000-8000-000000000001') <> 'tagm5social000001',
           (select checkin_tag from public.socials where id = '51200000-0000-4000-8000-000000000002')$$,
  $$values (true, 'tagm5other0000001'::text)$$,
  'only the manager''s own social got a new tag'
);
set local role service_role;
select is(
  public.get_checkin_page('tagm5social000001', pg_temp.device(9)),
  '{"status":"inactive"}'::jsonb,
  'the old tag is inactive at once'
);
select is(
  public.get_checkin_page((select checkin_tag from public.socials where id = '51200000-0000-4000-8000-000000000001'), pg_temp.device(1)) -> 'current_request' ->> 'status',
  'pending',
  'the new tag opens the same session; requests already sent are untouched'
);
select throws_ok(
  $$select public.submit_checkin('tagm5social000001', 'd1200000-0000-4000-8000-000000000001'::uuid, pg_temp.device(40), pg_temp.ip(40), 'Late', 'Comer', 'beginner', 'male')$$,
  'P0001', 'SESSION_CHANGED', 'submitting through the old tag fails like an unknown tag'
);
reset role;

select * from finish();
rollback;
