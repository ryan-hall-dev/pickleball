-- M5 check-in, database (docs/plans/m5-player-checkin.md, increment 1):
-- privileges of the new functions; submit's privacy rule (already_checked_in
-- only for the member's own linked phone); accent-insensitive search on
-- search_name; the public page read (inactive / no open session / open,
-- phone recognition, the phone's current request, nothing from other
-- socials); approve refusing an attending member; closing a request as
-- already checked in; the host tray's flags; manager-only tag reissue.
-- Functions run as service_role, as the server does.
begin;
create extension if not exists pgtap with schema extensions;
select plan(79);

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
insert into public.members (social_id, id, first_name, last_name, skill_level, is_active) values
  ('51200000-0000-4000-8000-000000000001', 'b1200000-0000-4000-8000-000000000001', 'Élodie', 'Durand', 'advanced', true),
  ('51200000-0000-4000-8000-000000000001', 'b1200000-0000-4000-8000-000000000002', 'Zoë', 'Núñez', 'beginner', true),
  ('51200000-0000-4000-8000-000000000001', 'b1200000-0000-4000-8000-000000000003', 'Ina', 'Inactive', 'beginner', false),
  ('51200000-0000-4000-8000-000000000001', 'b1200000-0000-4000-8000-000000000004', 'Eloise', 'Abbott', 'beginner', true),
  ('51200000-0000-4000-8000-000000000001', 'b1200000-0000-4000-8000-000000000005', 'Elora', 'Bell', 'beginner', true),
  ('51200000-0000-4000-8000-000000000001', 'b1200000-0000-4000-8000-000000000006', 'Elon', 'Cole', 'beginner', true),
  ('51200000-0000-4000-8000-000000000001', 'b1200000-0000-4000-8000-000000000007', 'Elowen', 'Dale', 'beginner', true),
  ('51200000-0000-4000-8000-000000000001', 'b1200000-0000-4000-8000-000000000008', 'Elodie', 'Evans', 'beginner', true),
  ('51200000-0000-4000-8000-000000000001', 'b1200000-0000-4000-8000-000000000009', 'Sam', 'Smith', 'intermediate', true),
  ('51200000-0000-4000-8000-000000000002', 'b1200000-0000-4000-8000-000000000010', 'Élodie', 'Other', 'beginner', true);

-- Test-only shorthands (the hashes the server passes).
create function pg_temp.device(p_number integer) returns text language sql as $$
  select encode(sha256(convert_to('m5-device-token-' || p_number, 'UTF8')), 'hex')
$$;
create function pg_temp.ip(p_number integer) returns text language sql as $$
  select encode(sha256(convert_to('m5-ip-' || p_number, 'UTF8')), 'hex')
$$;
grant execute on all functions in schema pg_temp to service_role;

-- Phones in M5 Social: 1 = Élodie, 2 = Zoë, 3 = the deactivated Ina.
insert into public.member_devices (social_id, token_hash, member_id) values
  ('51200000-0000-4000-8000-000000000001', pg_temp.device(1), 'b1200000-0000-4000-8000-000000000001'),
  ('51200000-0000-4000-8000-000000000001', pg_temp.device(2), 'b1200000-0000-4000-8000-000000000002'),
  ('51200000-0000-4000-8000-000000000001', pg_temp.device(3), 'b1200000-0000-4000-8000-000000000003');
-- Attending the draft: Élodie and Sam (members), and two host-added guests.
insert into public.session_participants (id, session_id, social_id, member_id, is_guest, first_name, last_name) values
  ('e1200000-0000-4000-8000-000000000001', 'd1200000-0000-4000-8000-000000000001', '51200000-0000-4000-8000-000000000001', 'b1200000-0000-4000-8000-000000000001', false, 'Élodie', 'Durand'),
  ('e1200000-0000-4000-8000-000000000002', 'd1200000-0000-4000-8000-000000000001', '51200000-0000-4000-8000-000000000001', 'b1200000-0000-4000-8000-000000000009', false, 'Sam', 'Smith'),
  ('e1200000-0000-4000-8000-000000000003', 'd1200000-0000-4000-8000-000000000001', '51200000-0000-4000-8000-000000000001', null, true, 'Gus', 'Guest'),
  ('e1200000-0000-4000-8000-000000000004', 'd1200000-0000-4000-8000-000000000001', '51200000-0000-4000-8000-000000000001', null, true, 'Mary', 'Ann Lee');

-- Privileges --------------------------------------------------------------------
select is(
  (select count(*) from pg_proc
   where oid in (
     'public.get_checkin_page(text, text)'::regprocedure,
     'public.close_checkin_already_checked_in(uuid, uuid)'::regprocedure,
     'public.list_checkin_requests_for_open_session(uuid)'::regprocedure,
     'public.reissue_checkin_tag(uuid)'::regprocedure,
     'public.search_checkin_names(text, text, text, text)'::regprocedure,
     'public.submit_checkin(text, text, text, text, text, public.skill_level, uuid)'::regprocedure,
     'public.approve_checkin(uuid, uuid, uuid, uuid, integer, timestamptz)'::regprocedure
   )
   and prosecdef
   and proconfig = array['search_path=""']
   and has_function_privilege('service_role', oid, 'execute')
   and not has_function_privilege('anon', oid, 'execute')
   and not has_function_privilege('authenticated', oid, 'execute')),
  7::bigint,
  'the new and changed check-in functions are security definer with an empty search_path, service_role only'
);
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
  $$select public.close_checkin_already_checked_in('a1200000-0000-4000-8000-000000000002', gen_random_uuid())$$,
  '42501', null, 'a signed-in host cannot close a request with their own session'
);
select throws_ok(
  $$select public.get_checkin_page('tagm5social000001', null)$$,
  '42501', null, 'a signed-in host cannot call the page read with their own session'
);
reset role;

-- Search: accent-insensitive on search_name, capped, this social only -------------
set local role service_role;
select set_eq(
  $$select member_id from public.search_checkin_names('tagm5social000001', 'ELODIE', pg_temp.device(50), pg_temp.ip(50))$$,
  array['b1200000-0000-4000-8000-000000000001', 'b1200000-0000-4000-8000-000000000008']::uuid[],
  'a plain query finds accented and unaccented first names'
);
select results_eq(
  $$select * from public.search_checkin_names('tagm5social000001', 'nunez', pg_temp.device(50), pg_temp.ip(50))$$,
  $$values ('b1200000-0000-4000-8000-000000000002'::uuid, 'Zoë'::text, 'Núñez'::text)$$,
  'a last-name prefix matches without accents and returns the names as saved'
);
select results_eq(
  $$select member_id from public.search_checkin_names('tagm5social000001', '  zoë   n ', pg_temp.device(50), pg_temp.ip(50))$$,
  $$values ('b1200000-0000-4000-8000-000000000002'::uuid)$$,
  'an accented full-name query with extra spaces is folded the same way'
);
select is(
  (select count(*) from public.search_checkin_names('tagm5social000001', 'Élo', pg_temp.device(50), pg_temp.ip(50))),
  5::bigint,
  'six names match "Élo" but at most 5 are returned'
);
select is_empty(
  $$select * from public.search_checkin_names('tagm5social000001', 'ina', pg_temp.device(50), pg_temp.ip(50))$$,
  'search never returns deactivated members'
);
select is_empty(
  $$select * from public.search_checkin_names('tagm5social000001', 'elodie o', pg_temp.device(50), pg_temp.ip(50))$$,
  'another social''s member is not found through this social''s tag'
);
select results_eq(
  $$select member_id from public.search_checkin_names('tagm5other0000001', 'elodie', pg_temp.device(50), pg_temp.ip(50))$$,
  $$values ('b1200000-0000-4000-8000-000000000010'::uuid)$$,
  'the other social''s tag finds only its own member'
);
select is_empty(
  $$select * from public.search_checkin_names('tagm5social000001', 'É', pg_temp.device(50), pg_temp.ip(50))$$,
  'one (accented) letter still returns nothing'
);
select throws_ok(
  $$select * from public.search_checkin_names('tagm5social000001', 'el_', pg_temp.device(50), pg_temp.ip(50))$$,
  '22023', 'INVALID_INPUT', 'search still refuses LIKE wildcards'
);
select is(
  (select count(*) from public.checkin_attempts where kind = 'search' and device_token_hash = pg_temp.device(50)),
  7::bigint,
  'every valid search of 2+ characters is still rate-limited (recorded)'
);

-- Submit privacy rule -------------------------------------------------------------
select is(
  public.submit_checkin('tagm5social000001', pg_temp.device(1), pg_temp.ip(1), 'Élodie', 'Durand', null, 'b1200000-0000-4000-8000-000000000001'),
  '{"status":"already_checked_in"}'::jsonb,
  'the attending member''s own linked phone is told they are already checked in'
);
select is(
  public.submit_checkin('tagm5social000001', pg_temp.device(9), pg_temp.ip(9), 'Élodie', 'Durand', null, 'b1200000-0000-4000-8000-000000000001') - 'checkin_request_id',
  '{"status":"pending","was_already_pending":false}'::jsonb,
  'any other phone naming the attending member gets an ordinary pending request'
);
select is(
  public.submit_checkin('tagm5social000001', pg_temp.device(9), pg_temp.ip(9), 'Élodie', 'Durand', null, 'b1200000-0000-4000-8000-000000000001') ->> 'was_already_pending',
  'true',
  'and a repeat from that phone returns its existing request'
);
select is(
  public.submit_checkin('tagm5social000001', pg_temp.device(2), pg_temp.ip(2), 'Sam', 'Smith', 'intermediate', 'b1200000-0000-4000-8000-000000000002') ->> 'status',
  'pending',
  'a linked phone whose member is not attending gets a pending request'
);
reset role;
-- 20261111120000: a member's request stores the member's names, not the phone's.
select is(
  (select first_name || ' ' || last_name from public.checkin_requests where device_token_hash = pg_temp.device(2)),
  'Zoë Núñez',
  'a member request sent with someone else''s name stores the member''s own name'
);
set local role service_role;
select is(
  public.submit_checkin('tagm5social000001', pg_temp.device(3), pg_temp.ip(3), null, null, null, 'b1200000-0000-4000-8000-000000000004') ->> 'status',
  'pending',
  'a member request needs no names from the phone at all'
);
select throws_ok(
  $$select public.submit_checkin('tagm5social000001', pg_temp.device(4), pg_temp.ip(4), '  ', 'Guest', 'beginner')$$,
  '22023', 'INVALID_NAME', 'a guest''s names are still validated'
);
reset role;
select is(
  (select first_name || ' ' || last_name from public.checkin_requests where device_token_hash = pg_temp.device(3)),
  'Eloise Abbott',
  'and stores the member''s names'
);
delete from public.checkin_requests where device_token_hash = pg_temp.device(3);
select is(
  (select count(*) from public.checkin_requests where device_token_hash in (pg_temp.device(1), pg_temp.device(9), pg_temp.device(2))),
  2::bigint,
  'one request each for phones 9 and 2; none for the linked phone told it is checked in'
);

-- Tray fixtures: new-player requests (explicit times give a stable order),
-- plus requests the tray must leave out.
update public.checkin_requests set created_at = now() - interval '10 minutes' where device_token_hash = pg_temp.device(9);
update public.checkin_requests set created_at = now() - interval '9 minutes' where device_token_hash = pg_temp.device(2);
insert into public.checkin_requests (id, session_id, social_id, member_id, first_name, last_name, skill_level, device_token_hash, ip_hash, created_at, status, decided_at) values
  ('c1200000-0000-4000-8000-000000000003', 'd1200000-0000-4000-8000-000000000001', '51200000-0000-4000-8000-000000000001', null, 'SÁM', 'smith', 'beginner', pg_temp.device(23), pg_temp.ip(20), now() - interval '8 minutes', 'pending', null),
  ('c1200000-0000-4000-8000-000000000004', 'd1200000-0000-4000-8000-000000000001', '51200000-0000-4000-8000-000000000001', null, 'gus', 'GUEST', 'beginner', pg_temp.device(24), pg_temp.ip(20), now() - interval '7 minutes', 'pending', null),
  ('c1200000-0000-4000-8000-000000000005', 'd1200000-0000-4000-8000-000000000001', '51200000-0000-4000-8000-000000000001', null, 'Mary  Ann', 'Lee', 'advanced', pg_temp.device(25), pg_temp.ip(20), now() - interval '6 minutes', 'pending', null),
  ('c1200000-0000-4000-8000-000000000006', 'd1200000-0000-4000-8000-000000000001', '51200000-0000-4000-8000-000000000001', null, 'Nora', 'New', 'beginner', pg_temp.device(26), pg_temp.ip(20), now() - interval '5 minutes', 'pending', null),
  ('c1200000-0000-4000-8000-000000000007', 'd1200000-0000-4000-8000-000000000001', '51200000-0000-4000-8000-000000000001', null, 'Rex', 'Rejected', 'beginner', pg_temp.device(27), pg_temp.ip(20), now() - interval '4 minutes', 'rejected', now()),
  ('c1200000-0000-4000-8000-000000000008', 'd1200000-0000-4000-8000-000000000009', '51200000-0000-4000-8000-000000000001', null, 'Olga', 'Old', 'beginner', pg_temp.device(28), pg_temp.ip(20), now() - interval '20 minutes', 'pending', null),
  ('c1200000-0000-4000-8000-000000000009', 'd1200000-0000-4000-8000-000000000002', '51200000-0000-4000-8000-000000000002', null, 'Sam', 'Smith', 'beginner', pg_temp.device(29), pg_temp.ip(20), now() - interval '3 minutes', 'pending', null);

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
  array['status', 'social_name', 'session', 'recognised_member', 'current_request', 'now'],
  'an open page has exactly the documented keys'
);
select is(
  public.get_checkin_page('tagm5social000001', pg_temp.device(1)) ->> 'status',
  'open',
  'a draft with check-in open is open'
);
select is(
  public.get_checkin_page('tagm5social000001', pg_temp.device(1)) -> 'session',
  jsonb_build_object(
    'name', 'M5 draft', 'status', 'draft',
    'planned_start', '2026-11-11 18:00+00'::timestamptz, 'planned_end', '2026-11-11 20:00+00'::timestamptz,
    'courts_count', 2, 'checked_in_count', 4
  ),
  'the header carries the session name, status, planned times, selected courts and attendance count'
);
select is(
  (public.get_checkin_page('tagm5social000001', pg_temp.device(1)) ->> 'now')::timestamptz,
  now(),
  'the page carries the database time'
);
select is(
  public.get_checkin_page('tagm5social000001', pg_temp.device(1)) -> 'recognised_member',
  '{"member_id":"b1200000-0000-4000-8000-000000000001","first_name":"Élodie","last_name":"Durand","skill_level":"advanced"}'::jsonb,
  'a linked phone is recognised as its member'
);
select is(
  public.get_checkin_page('tagm5social000001', pg_temp.device(1)) -> 'current_request',
  'null'::jsonb,
  'a phone with no request in this session has no current request'
);
select is(
  public.get_checkin_page('tagm5social000001', pg_temp.device(3)) -> 'recognised_member',
  'null'::jsonb,
  'a phone linked to a deactivated member is not recognised'
);
select is(
  public.get_checkin_page('tagm5social000001', null) - 'now' - 'session',
  '{"status":"open","social_name":"M5 Social","recognised_member":null,"current_request":null}'::jsonb,
  'no device hash: no recognition and no request'
);
select is(
  public.get_checkin_page('tagm5social000001', pg_temp.device(9)) -> 'current_request',
  jsonb_build_object(
    'id', (select id from public.checkin_requests where device_token_hash = pg_temp.device(9)),
    'status', 'pending', 'first_name', 'Élodie', 'member_id', 'b1200000-0000-4000-8000-000000000001'
  ),
  'the phone''s own request in this session is its current request'
);
select is(
  public.get_checkin_page('tagm5social000001', pg_temp.device(9)) -> 'recognised_member',
  'null'::jsonb,
  'a request alone does not make the phone recognised'
);
select is(
  public.get_checkin_page('tagm5other0000001', pg_temp.device(9)) - 'now' - 'session',
  '{"status":"open","social_name":"Other Social","recognised_member":null,"current_request":null}'::jsonb,
  'another social''s page knows nothing of this phone''s member or request'
);
select is(
  public.get_checkin_page('tagm5other0000001', pg_temp.device(1)) -> 'recognised_member',
  'null'::jsonb,
  'a phone linked in one social is not recognised in another'
);
select is(
  public.get_checkin_page('tagm5other0000001', null) -> 'session',
  jsonb_build_object(
    'name', 'Other live', 'status', 'live',
    'planned_start', '2026-11-11 18:00+00'::timestamptz, 'planned_end', '2026-11-11 20:00+00'::timestamptz,
    'courts_count', 1, 'checked_in_count', 0
  ),
  'a live session shows status live and the courts enabled at the start'
);
select throws_ok(
  $$select public.get_checkin_page('tagm5social000001', 'raw-device-token')$$,
  '22023', 'INVALID_INPUT', 'the page read refuses anything but a device token hash'
);
select is(
  (select count(*) from public.checkin_attempts where device_token_hash = pg_temp.device(1)),
  1::bigint,
  'phone 1''s many page reads recorded no rate-limit attempt (only its one submit)'
);

-- Host tray ----------------------------------------------------------------------
select results_eq(
  $$select first_name, member_id, skill_level::text, saved_skill_level::text, is_already_attending, is_possible_duplicate
    from public.list_checkin_requests_for_open_session('a1200000-0000-4000-8000-000000000002')$$,
  $$values
    ('Élodie'::text, 'b1200000-0000-4000-8000-000000000001'::uuid, null::text, 'advanced'::text, true, false),
    ('Zoë', 'b1200000-0000-4000-8000-000000000002'::uuid, 'intermediate', 'beginner', false, false),
    ('SÁM', null::uuid, 'beginner', null::text, false, true),
    ('gus', null::uuid, 'beginner', null::text, false, true),
    ('Mary  Ann', null::uuid, 'advanced', null::text, false, true),
    ('Nora', null::uuid, 'beginner', null::text, false, false)$$,
  'the tray lists the open session''s pending requests oldest first, with the attending and possible-duplicate flags'
);
select is(
  (select count(*) from public.list_checkin_requests_for_open_session('a1200000-0000-4000-8000-000000000001')),
  6::bigint,
  'every host of the social (the manager too) sees the same tray'
);
select results_eq(
  $$select id from public.list_checkin_requests_for_open_session('a1200000-0000-4000-8000-000000000003')$$,
  $$values ('c1200000-0000-4000-8000-000000000009'::uuid)$$,
  'another social''s host sees only their own social''s request, never this one''s'
);
select is_empty(
  $$select * from public.list_checkin_requests_for_open_session('a1200000-0000-4000-8000-000000000004')$$,
  'a social with no open session has an empty tray'
);
select throws_ok(
  $$select * from public.list_checkin_requests_for_open_session('a1200000-0000-4000-8000-000000000005')$$,
  '42501', 'NOT_A_HOST', 'a non-host cannot read any tray'
);
reset role;
select is(
  (select count(*) from public.members where social_id = '51200000-0000-4000-8000-000000000001'),
  9::bigint,
  'the duplicate check created no members'
);

-- Approve refuses an attending member ---------------------------------------------
set local role service_role;
select throws_ok(
  $$select public.approve_checkin('a1200000-0000-4000-8000-000000000002',
      (select id from public.checkin_requests where device_token_hash = pg_temp.device(9)), gen_random_uuid())$$,
  'P0001', 'ALREADY_IN_SESSION', 'approving a request for a member already attending is refused'
);
reset role;
select results_eq(
  $$select request.status::text, request.decided_by, member.last_checked_in_at,
           (select count(*) from public.member_devices where token_hash = pg_temp.device(9)),
           (select count(*) from public.session_participants where member_id = 'b1200000-0000-4000-8000-000000000001')
    from public.checkin_requests as request
    join public.members as member on member.id = request.member_id
    where request.device_token_hash = pg_temp.device(9)$$,
  $$values ('pending'::text, null::uuid, null::timestamptz, 0::bigint, 1::bigint)$$,
  'the refusal linked no phone, touched no member and added no participant'
);

-- Close as already checked in -----------------------------------------------------
set local role service_role;
select throws_ok(
  $$select public.close_checkin_already_checked_in('a1200000-0000-4000-8000-000000000005',
      (select id from public.checkin_requests where device_token_hash = pg_temp.device(9)))$$,
  '42501', 'NOT_A_HOST', 'a non-host cannot close a request'
);
select throws_ok(
  $$select public.close_checkin_already_checked_in('a1200000-0000-4000-8000-000000000003',
      (select id from public.checkin_requests where device_token_hash = pg_temp.device(9)))$$,
  'P0002', 'CHECKIN_REQUEST_NOT_FOUND', 'another social''s host cannot close it (it looks missing)'
);
select throws_ok(
  $$select public.close_checkin_already_checked_in('a1200000-0000-4000-8000-000000000002', gen_random_uuid())$$,
  'P0002', 'CHECKIN_REQUEST_NOT_FOUND', 'closing an unknown request fails'
);
select throws_ok(
  $$select public.close_checkin_already_checked_in('a1200000-0000-4000-8000-000000000002',
      (select id from public.checkin_requests where device_token_hash = pg_temp.device(2)))$$,
  'P0001', 'NOT_ALREADY_IN_SESSION', 'a member who is not attending cannot be closed as already checked in'
);
select throws_ok(
  $$select public.close_checkin_already_checked_in('a1200000-0000-4000-8000-000000000002', 'c1200000-0000-4000-8000-000000000003')$$,
  'P0001', 'NOT_ALREADY_IN_SESSION', 'a new player (even a possible duplicate) cannot be closed as already checked in'
);
select is(
  public.close_checkin_already_checked_in('a1200000-0000-4000-8000-000000000002',
    (select id from public.checkin_requests where device_token_hash = pg_temp.device(9))),
  '{"status":"closed"}'::jsonb,
  'a host closes a request for an attending member'
);
reset role;
select results_eq(
  $$select status::text, decided_by, decided_at is not null, member_id, session_participant_id
    from public.checkin_requests where device_token_hash = pg_temp.device(9)$$,
  $$values ('already_checked_in'::text, 'a1200000-0000-4000-8000-000000000002'::uuid, true,
            'b1200000-0000-4000-8000-000000000001'::uuid, null::uuid)$$,
  'closing records the already_checked_in outcome and who decided it'
);
select results_eq(
  $$select (select count(*) from public.member_devices where token_hash = pg_temp.device(9)),
           (select count(*) from public.member_devices where member_id = 'b1200000-0000-4000-8000-000000000001'),
           (select count(*) from public.session_participants where session_id = 'd1200000-0000-4000-8000-000000000001')$$,
  $$values (0::bigint, 1::bigint, 4::bigint)$$,
  'closing linked no phone, kept the member''s own phone and changed no attendance'
);
set local role service_role;
select is(
  public.close_checkin_already_checked_in('a1200000-0000-4000-8000-000000000001',
    (select id from public.checkin_requests where device_token_hash = pg_temp.device(9))),
  '{"status":"already_closed"}'::jsonb,
  'closing twice is idempotent (another host of the social)'
);
select throws_ok(
  $$select public.approve_checkin('a1200000-0000-4000-8000-000000000002',
      (select id from public.checkin_requests where device_token_hash = pg_temp.device(9)), gen_random_uuid())$$,
  'P0001', 'CHECKIN_REQUEST_NOT_PENDING', 'a closed request cannot be approved'
);
select throws_ok(
  $$select public.reject_checkin('a1200000-0000-4000-8000-000000000002',
      (select id from public.checkin_requests where device_token_hash = pg_temp.device(9)))$$,
  'P0001', 'CHECKIN_REQUEST_NOT_PENDING', 'a closed request cannot be rejected'
);
select throws_ok(
  $$select public.close_checkin_already_checked_in('a1200000-0000-4000-8000-000000000002', 'c1200000-0000-4000-8000-000000000007')$$,
  'P0001', 'CHECKIN_REQUEST_NOT_PENDING', 'a rejected request cannot be closed'
);
select is(
  public.get_checkin_page('tagm5social000001', pg_temp.device(9)) -> 'current_request' ->> 'status',
  'already_checked_in',
  'the requesting phone sees the closed outcome'
);
select is(
  (select count(*) from public.list_checkin_requests_for_open_session('a1200000-0000-4000-8000-000000000002')),
  5::bigint,
  'the closed request leaves the tray'
);

-- A member becoming attending flips their row (the 5 s poll's race).
select lives_ok(
  $$select public.set_draft_member_attendance('a1200000-0000-4000-8000-000000000002', 'd1200000-0000-4000-8000-000000000001',
      array['b1200000-0000-4000-8000-000000000002']::uuid[], true)$$,
  'another host adds Zoë through Who''s playing'
);
select results_eq(
  $$select is_already_attending, is_possible_duplicate
    from public.list_checkin_requests_for_open_session('a1200000-0000-4000-8000-000000000002')
    where member_id = 'b1200000-0000-4000-8000-000000000002'$$,
  $$values (true, false)$$,
  'her pending request now shows as already attending'
);
select throws_ok(
  $$select public.approve_checkin('a1200000-0000-4000-8000-000000000002',
      (select id from public.checkin_requests where device_token_hash = pg_temp.device(2)), gen_random_uuid())$$,
  'P0001', 'ALREADY_IN_SESSION', 'an approve pressed after that is refused'
);
select is(
  public.close_checkin_already_checked_in('a1200000-0000-4000-8000-000000000002',
    (select id from public.checkin_requests where device_token_hash = pg_temp.device(2))) ->> 'status',
  'closed',
  'and the host can close it instead'
);
reset role;
select results_eq(
  $$select skill_level::text, last_checked_in_at from public.members where id = 'b1200000-0000-4000-8000-000000000002'$$,
  $$values ('beginner'::text, null::timestamptz)$$,
  'closing kept the member''s saved level (the requested level change is not applied)'
);

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
  public.get_checkin_page((select checkin_tag from public.socials where id = '51200000-0000-4000-8000-000000000001'), pg_temp.device(9)) -> 'current_request' ->> 'status',
  'already_checked_in',
  'the new tag opens the same session; requests already sent are untouched'
);
select throws_ok(
  $$select public.submit_checkin('tagm5social000001', pg_temp.device(40), pg_temp.ip(40), 'Late', 'Comer', 'beginner')$$,
  'P0002', 'NO_OPEN_SESSION', 'submitting through the old tag fails like an unknown tag'
);
reset role;

select * from finish();
rollback;
