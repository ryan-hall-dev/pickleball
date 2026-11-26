-- Row-level security and grants (docs/decisions/0002-server-only-writes.md):
-- anon reads and executes nothing; a signed-in non-host reads nothing; a host
-- reads their own social and everything in it (hosts, courts, saved setups,
-- sessions and everything under them) but writes nothing with their own
-- session;
-- only service_role executes the public functions; the log is append-only for
-- every role. Isolation between socials: 11_social_isolation.test.sql.
begin;
create extension if not exists pgtap with schema extensions;
select plan(56);

-- Fixtures (as the table owner) -----------------------------------------------
insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-000000000001', 'pgtap-manager@example.test'),
  ('a0000000-0000-4000-8000-000000000002', 'pgtap-host@example.test'),
  ('a0000000-0000-4000-8000-000000000003', 'pgtap-outsider@example.test');
insert into public.socials (id, name) values ('50000000-0000-4000-8000-000000000001', 'pgTAP Social');
insert into public.hosts (user_id, display_name, role, social_id) values
  ('a0000000-0000-4000-8000-000000000001', 'Mia Manager', 'manager', '50000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000002', 'Hal Host', 'host', '50000000-0000-4000-8000-000000000001');
insert into public.courts (id, social_id, name) values
  ('c0000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'pgTAP Court');
insert into public.saved_setups (social_id, host_id, name, config) values
  ('50000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'Tuesday social', '{}');
insert into public.sessions (id, social_id, host_id, name, host_name, planned_start, planned_end) values
  ('d0000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'Tuesday social', 'Hal Host', now(), now() + interval '2 hours');
insert into public.session_participants (id, session_id, social_id, first_name, last_name, skill_level) values
  ('e0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'Grace', 'Kim', 'advanced');
insert into public.checkin_requests (session_id, social_id, first_name, last_name, skill_level, device_token_hash, ip_hash) values
  ('d0000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'Zoe', 'Park', 'beginner', repeat('b', 64), repeat('c', 64));
insert into public.checkin_attempts (kind, session_id, device_token_hash, ip_hash) values
  ('search', 'd0000000-0000-4000-8000-000000000001', repeat('b', 64), repeat('c', 64));
-- The owner may insert (functions run as the owner); used to test update/delete blocking.
insert into public.session_events (session_id, seq, event_id, type, payload, occurred_at, actor_user_id) values
  ('d0000000-0000-4000-8000-000000000001', 1, 'f0000000-0000-4000-8000-000000000001', 'Paused', '{}', now(), 'a0000000-0000-4000-8000-000000000002');
insert into public.matches (id, session_id, court_id, court_name, team_a, team_b, started_at, ended_at, duration_seconds, status) values
  ('f1000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'Court 1',
   '{e0000000-0000-4000-8000-000000000001}', '{}', now(), now(), 0, 'completed');

-- Schema-wide guarantees ------------------------------------------------------
select is(
  (select count(*) from pg_tables where schemaname = 'public' and not rowsecurity),
  0::bigint,
  'RLS is enabled on every public table'
);
select is(
  (select count(*) from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'anon'),
  0::bigint,
  'anon has no privilege on any public table'
);
select is(
  (select count(*) from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'authenticated' and privilege_type <> 'SELECT'),
  0::bigint,
  'authenticated can only SELECT (writes are server-only)'
);
select is(
  (select count(*) from pg_proc
   where pronamespace in ('public'::regnamespace, 'private'::regnamespace)
     and has_function_privilege('anon', oid, 'execute')),
  0::bigint,
  'anon can execute no public or private function'
);
select is(
  (select string_agg(pronamespace::regnamespace::text || '.' || proname::text, ',' order by proname) from pg_proc
   where pronamespace in ('public'::regnamespace, 'private'::regnamespace)
     and has_function_privilege('authenticated', oid, 'execute')),
  'private.current_social_id',
  'authenticated can execute only the RLS helper'
);
select set_eq(
  $$select proname::text from pg_proc
    where pronamespace = 'public'::regnamespace and has_function_privilege('service_role', oid, 'execute')$$,
  array[
    'append_session_event', 'start_session', 'end_session', 'add_participant_mid_session',
    'cancel_draft_session', 'remove_draft_participant', 'save_session_draft',
    'add_draft_participant', 'set_draft_participant_details',
    'save_setup', 'apply_saved_setup',
    'approve_checkin', 'reject_checkin', 'submit_checkin',
    'get_checkin_page',
    'list_checkin_requests_for_open_session', 'reissue_checkin_tag',
    'record_login_attempt', 'create_social_with_manager',
    'import_roster_entries', 'remove_roster_entry', 'set_roster_entry_note',
    'set_walk_ins_open', 'list_roster_for_open_session', 'decide_roster_transfer',
    'host_check_in_roster_entry', 'search_roster_entries', 'claim_roster_entry',
    'request_roster_transfer', 'get_checkin_participant', 'append_session_event_without_host',
    'submit_player_score', 'host_set_match_score'
  ],
  'service_role executes exactly the public functions'
);
-- The one exception: the name normaliser behind the unique participant-name
-- index, which runs with the writing role's privileges (20261112090000).
select is(
  (select string_agg(proname::text, ',') from pg_proc
   where pronamespace = 'private'::regnamespace and has_function_privilege('service_role', oid, 'execute')),
  'normalise_name_for_search',
  'service_role executes no private helper but the name normaliser (needed by the participant-name index)'
);
select ok(
  not has_schema_privilege('service_role', 'private', 'usage'),
  'service_role has no usage on the private schema (the index calls the normaliser by oid)'
);
select is(
  (select count(*)
   from pg_default_acl as default_acl, aclexplode(default_acl.defaclacl) as entry
   where default_acl.defaclrole = 'postgres'::regrole
     and (default_acl.defaclnamespace = 0 or default_acl.defaclnamespace = 'public'::regnamespace)
     and entry.grantee in (0, 'anon'::regrole, 'authenticated'::regrole)),
  0::bigint,
  'default privileges give PUBLIC, anon and authenticated nothing on new objects'
);

-- The member directory and phone links are gone (session-only participants).
select hasnt_table('public', 'members', 'there is no members table');
select hasnt_table('public', 'member_devices', 'there is no member_devices table');

-- anon: no table is readable --------------------------------------------------
set local role anon;
select throws_ok('select * from public.socials', '42501', null, 'anon cannot read socials');
select throws_ok('select * from public.hosts', '42501', null, 'anon cannot read hosts');
select throws_ok('select * from public.courts', '42501', null, 'anon cannot read courts');
select throws_ok('select * from public.saved_setups', '42501', null, 'anon cannot read saved_setups');
select throws_ok('select * from public.sessions', '42501', null, 'anon cannot read sessions');
select throws_ok('select * from public.session_participants', '42501', null, 'anon cannot read session_participants');
select throws_ok('select * from public.session_events', '42501', null, 'anon cannot read session_events');
select throws_ok('select * from public.matches', '42501', null, 'anon cannot read matches');
select throws_ok('select * from public.checkin_requests', '42501', null, 'anon cannot read checkin_requests');
select throws_ok('select * from public.checkin_attempts', '42501', null, 'anon cannot read checkin_attempts');
select throws_ok(
  $$select public.add_draft_participant('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', gen_random_uuid(), 'Nina', 'New', 'beginner', 'male')$$,
  '42501', null, 'anon cannot add a draft participant directly'
);
select throws_ok(
  $$select public.submit_checkin('tag0000000000000001', 'd0000000-0000-4000-8000-000000000001'::uuid, repeat('a', 64), repeat('b', 64), 'Nina', 'New', 'beginner', 'male')$$,
  '42501', null, 'anon cannot submit a check-in directly'
);
reset role;

-- Signed in but not a host: every row is filtered out ---------------------------
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
set local role authenticated;
select is_empty('select * from public.socials', 'non-host sees no socials');
select is_empty('select * from public.hosts', 'non-host sees no hosts');
select is_empty('select * from public.courts', 'non-host sees no courts');
select is_empty('select * from public.saved_setups', 'non-host sees no saved_setups');
select is_empty('select * from public.sessions', 'non-host sees no sessions');
select is_empty('select * from public.session_participants', 'non-host sees no session_participants');
select is_empty('select * from public.session_events', 'non-host sees no session_events');
select is_empty('select * from public.matches', 'non-host sees no matches');
select is_empty('select * from public.checkin_requests', 'non-host sees no checkin_requests');
reset role;

-- Host: reads everything except the private attempt table -----------------------
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;
select isnt_empty('select * from public.socials', 'host reads their social');
select isnt_empty('select * from public.hosts', 'host reads hosts');
select isnt_empty('select * from public.courts', 'host reads courts');
select isnt_empty('select * from public.saved_setups', 'host reads saved_setups');
select isnt_empty('select * from public.sessions', 'host reads sessions');
select isnt_empty('select * from public.session_participants', 'host reads session_participants');
select isnt_empty('select * from public.session_events', 'host reads session_events');
select isnt_empty('select * from public.matches', 'host reads matches');
select isnt_empty('select * from public.checkin_requests', 'host reads checkin_requests');
select throws_ok('select * from public.checkin_attempts', '42501', null, 'host cannot read check-in attempts');

-- ...and writes nothing with their own session.
select throws_ok(
  $$insert into public.session_participants (session_id, social_id, first_name, last_name, skill_level)
    values ('d0000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'Kofi', 'Mensah', 'beginner')$$,
  '42501', null, 'host cannot insert participants with their session'
);
select throws_ok(
  $$update public.sessions set name = 'Renamed social' where id = 'd0000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'host cannot update sessions with their session'
);
select throws_ok(
  $$delete from public.session_participants where id = 'e0000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'host cannot delete participants with their session'
);
select throws_ok(
  $$insert into public.session_events (session_id, seq, event_id, type, payload, occurred_at, actor_user_id)
    values ('d0000000-0000-4000-8000-000000000001', 2, gen_random_uuid(), 'Resumed', '{}', now(), 'a0000000-0000-4000-8000-000000000002')$$,
  '42501', null, 'host cannot insert into session_events'
);
select throws_ok(
  $$select public.append_session_event('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', gen_random_uuid(), 1, 'Paused', '{}', now())$$,
  '42501', null, 'host cannot execute the log functions with their session'
);
select throws_ok(
  $$select public.approve_checkin('a0000000-0000-4000-8000-000000000002', gen_random_uuid(), gen_random_uuid(), p_gender => 'male')$$,
  '42501', null, 'host cannot execute check-in decisions with their session'
);
select throws_ok(
  $$select public.add_participant_mid_session('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', gen_random_uuid(), 'Nina', 'New', 'beginner', gen_random_uuid(), 0, now(), 'male')$$,
  '42501', null, 'host cannot add participants mid-session with their session'
);
reset role;

-- Not even a social manager writes with their session (invites go through server code).
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$insert into public.hosts (user_id, display_name, social_id) values ('a0000000-0000-4000-8000-000000000003', 'New Host', '50000000-0000-4000-8000-000000000001')$$,
  '42501', null, 'a manager cannot add hosts with their session'
);
select throws_ok(
  $$update public.socials set name = 'Renamed'$$,
  '42501', null, 'a manager cannot rename their social with their session'
);
reset role;

-- The server (service_role) writes tables directly, after its own host check.
set local role service_role;
select lives_ok(
  $$insert into public.courts (social_id, name) values ('50000000-0000-4000-8000-000000000001', 'Second court')$$,
  'service_role can add a court'
);
select throws_ok(
  $$insert into public.session_events (session_id, seq, event_id, type, payload, occurred_at, actor_user_id)
    values ('d0000000-0000-4000-8000-000000000001', 2, gen_random_uuid(), 'Resumed', '{}', now(), 'a0000000-0000-4000-8000-000000000002')$$,
  '42501', null, 'not even service_role inserts into session_events directly'
);
reset role;

-- Append-only log, for every role -----------------------------------------------
select throws_ok(
  $$update public.session_events set payload = '{"tampered":true}'$$,
  '42501', 'SESSION_EVENTS_APPEND_ONLY', 'even the owner cannot update session_events'
);
select throws_ok(
  $$delete from public.session_events$$,
  '42501', 'SESSION_EVENTS_APPEND_ONLY', 'even the owner cannot delete session_events'
);
select throws_ok(
  $$truncate public.session_events cascade$$,
  '42501', 'SESSION_EVENTS_APPEND_ONLY', 'even the owner cannot truncate session_events'
);

select * from finish();
rollback;
