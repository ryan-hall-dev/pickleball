-- Socials and hosts (M4.5 A1, docs/plans/socials.md): a host reads only their
-- own social and its hosts; a host never moves to another social; a social
-- with hosts keeps a manager (checked at commit); the check-in tag belongs to
-- the social; create_social_with_manager is atomic and service_role only.
-- The directory (A2): courts belong to one social; reads, check-in
-- submit/approve and draft attendance never cross socials; per-social
-- uniques. (Members and member phones were removed by session-only
-- participants, 20261112090000.)
-- Sessions (A3): saved setups, sessions, participants, check-in requests, the
-- log and match rows belong to one social; reads and every write function
-- stay within the actor's social; composite FKs refuse cross-social links;
-- one open session per social; setup names unique per social.
begin;
create extension if not exists pgtap with schema extensions;
select plan(95);

insert into auth.users (id, email) values
  ('a1100000-0000-4000-8000-000000000001', 'pgtap-manager-a@example.test'),
  ('a1100000-0000-4000-8000-000000000002', 'pgtap-host-a@example.test'),
  ('a1100000-0000-4000-8000-000000000003', 'pgtap-manager-b@example.test'),
  ('a1100000-0000-4000-8000-000000000004', 'pgtap-host-b@example.test'),
  ('a1100000-0000-4000-8000-000000000005', 'pgtap-outsider@example.test'),
  ('a1100000-0000-4000-8000-000000000006', 'pgtap-manager-c@example.test'),
  ('a1100000-0000-4000-8000-000000000007', 'pgtap-host-c1@example.test'),
  ('a1100000-0000-4000-8000-000000000008', 'pgtap-host-c2@example.test'),
  ('a1100000-0000-4000-8000-000000000009', 'pgtap-manager-d@example.test'),
  ('a1100000-0000-4000-8000-000000000010', 'pgtap-host-d@example.test');
insert into public.socials (id, name, checkin_tag) values
  ('51100000-0000-4000-8000-00000000000a', 'Social A', 'tagsociala00000001'),
  ('51100000-0000-4000-8000-00000000000b', 'Social B', 'tagsocialb00000001'),
  ('51100000-0000-4000-8000-00000000000c', 'Social C', 'tagsocialc00000001'),
  ('51100000-0000-4000-8000-00000000000d', 'Social D', 'tagsociald00000001');
insert into public.hosts (user_id, display_name, role, social_id) values
  ('a1100000-0000-4000-8000-000000000001', 'Manager A', 'manager', '51100000-0000-4000-8000-00000000000a'),
  ('a1100000-0000-4000-8000-000000000002', 'Host A', 'host', '51100000-0000-4000-8000-00000000000a'),
  ('a1100000-0000-4000-8000-000000000003', 'Manager B', 'manager', '51100000-0000-4000-8000-00000000000b'),
  ('a1100000-0000-4000-8000-000000000004', 'Host B', 'host', '51100000-0000-4000-8000-00000000000b'),
  ('a1100000-0000-4000-8000-000000000006', 'Manager C', 'manager', '51100000-0000-4000-8000-00000000000c'),
  ('a1100000-0000-4000-8000-000000000007', 'Host C1', 'host', '51100000-0000-4000-8000-00000000000c'),
  ('a1100000-0000-4000-8000-000000000008', 'Host C2', 'host', '51100000-0000-4000-8000-00000000000c'),
  ('a1100000-0000-4000-8000-000000000009', 'Manager D', 'manager', '51100000-0000-4000-8000-00000000000d'),
  ('a1100000-0000-4000-8000-000000000010', 'Host D', 'host', '51100000-0000-4000-8000-00000000000d');
-- One open session each: in A host A's draft; in B a live one (with a log
-- and a match row, below).
insert into public.sessions (id, social_id, host_id, name, host_name, planned_start, planned_end, status, started_at) values
  ('d1100000-0000-4000-8000-000000000001', '51100000-0000-4000-8000-00000000000a', 'a1100000-0000-4000-8000-000000000002', 'A draft', 'Host A',
   now(), now() + interval '2 hours', 'draft', null),
  ('d1100000-0000-4000-8000-000000000003', '51100000-0000-4000-8000-00000000000b', 'a1100000-0000-4000-8000-000000000004', 'B live', 'Host B',
   now(), now() + interval '2 hours', 'live', now());
-- A "Tuesday" saved setup in each social.
insert into public.saved_setups (id, social_id, host_id, name, config) values
  ('f1100000-0000-4000-8000-00000000000a', '51100000-0000-4000-8000-00000000000a', 'a1100000-0000-4000-8000-000000000002', 'Tuesday', '{}'),
  ('f1100000-0000-4000-8000-00000000000b', '51100000-0000-4000-8000-00000000000b', 'a1100000-0000-4000-8000-000000000004', 'Tuesday', '{}');

-- The directory: a "Court 1" each (B's court is inserted by the checks below).
insert into public.courts (id, social_id, name) values
  ('c1100000-0000-4000-8000-00000000000a', '51100000-0000-4000-8000-00000000000a', 'Court 1');
-- A's draft: Grace attends and a first-timer waits for approval. B's live
-- session: Grace K. attends, one logged event and one match row.
insert into public.session_participants (id, session_id, social_id, first_name, last_name, skill_level) values
  ('e1100000-0000-4000-8000-00000000000a', 'd1100000-0000-4000-8000-000000000001', '51100000-0000-4000-8000-00000000000a', 'Grace', 'Kim', 'advanced'),
  ('e1100000-0000-4000-8000-00000000000b', 'd1100000-0000-4000-8000-000000000003', '51100000-0000-4000-8000-00000000000b', 'Grace', 'Kimball', 'beginner');
insert into public.checkin_requests (id, session_id, social_id, first_name, last_name, skill_level, device_token_hash, ip_hash) values
  ('c2100000-0000-4000-8000-00000000000a', 'd1100000-0000-4000-8000-000000000001', '51100000-0000-4000-8000-00000000000a', 'Paula', 'Pending', 'beginner', repeat('5', 64), repeat('2', 64));
insert into public.session_events (session_id, seq, event_id, type, payload, occurred_at, actor_user_id) values
  ('d1100000-0000-4000-8000-000000000003', 1, 'f2100000-0000-4000-8000-00000000000b', 'Paused', '{}', now(), 'a1100000-0000-4000-8000-000000000004');
update public.sessions set last_seq = 1 where id = 'd1100000-0000-4000-8000-000000000003';
insert into public.matches (id, session_id, court_id, court_name, team_a, team_b, started_at, ended_at, duration_seconds, status) values
  ('f3100000-0000-4000-8000-00000000000b', 'd1100000-0000-4000-8000-000000000003', 'c1100000-0000-4000-8000-00000000000b', 'Court 1',
   '{e1100000-0000-4000-8000-00000000000b}', '{}', now(), now(), 0, 'completed');

-- Schema ----------------------------------------------------------------------
select col_type_is('public', 'hosts', 'social_id', 'uuid', 'hosts.social_id is a uuid');
select col_not_null('public', 'hosts', 'social_id', 'every host belongs to a social');
select hasnt_column('public', 'session_participants', 'member_id', 'participants link to no member');
select hasnt_column('public', 'session_participants', 'is_guest', 'participants have no guest flag');
select hasnt_column('public', 'checkin_requests', 'member_id', 'check-in requests name no member');
select col_not_null('public', 'courts', 'social_id', 'every court belongs to a social');
select is(
  (select count(*) from pg_policies
   where schemaname = 'public' and tablename in ('socials', 'hosts', 'courts')
     and qual like '%current_social_id%'),
  3::bigint,
  'the socials, hosts and courts policies compare against current_social_id'
);
select is(
  (select array_agg(tablename::text order by tablename) from pg_tables as public_table
   where schemaname = 'public'
     and tablename not in ('socials', 'session_events', 'matches', 'checkin_attempts', 'login_attempts')
     and not exists (
       select 1 from information_schema.columns as column_info
       where column_info.table_schema = 'public' and column_info.table_name = public_table.tablename
         and column_info.column_name = 'social_id' and column_info.data_type = 'uuid' and column_info.is_nullable = 'NO'
     )),
  null,
  'every public table but socials, the log, match rows and attempts has social_id uuid not null'
);
select is(
  (select array_agg(policyname::text) from pg_policies
   where schemaname = 'public' and qual not like '%current_social_id%'),
  null,
  'every policy compares against current_social_id'
);
select fk_ok(
  'public', 'session_participants', array['session_id', 'social_id'],
  'public', 'sessions', array['id', 'social_id'],
  'a participant belongs to a session of its own social'
);
select fk_ok(
  'public', 'checkin_requests', array['session_id', 'social_id'],
  'public', 'sessions', array['id', 'social_id'],
  'a check-in request belongs to a session of its own social'
);
select is(
  (select count(*) from pg_constraint
   where conrelid in ('public.session_participants'::regclass, 'public.checkin_requests'::regclass)
     and contype = 'f' and confrelid = 'public.sessions'::regclass
     and cardinality(conkey) = 1),
  0::bigint,
  'the composite FKs replaced the single-column ones (no ambiguous PostgREST embed)'
);

-- Reads: each host sees exactly their own social and its hosts -----------------
select set_config('request.jwt.claims', '{"sub":"a1100000-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;
select is(private.current_social_id(), '51100000-0000-4000-8000-00000000000a'::uuid, 'host A''s current social is A');
select results_eq('select name::text from public.socials', $$values ('Social A')$$, 'host A sees only social A');
select set_eq(
  'select user_id from public.hosts',
  $$values ('a1100000-0000-4000-8000-000000000001'::uuid), ('a1100000-0000-4000-8000-000000000002'::uuid)$$,
  'host A sees only social A''s hosts'
);
select results_eq(
  'select id from public.courts',
  $$values ('c1100000-0000-4000-8000-00000000000a'::uuid)$$,
  'host A sees only social A''s courts'
);
select results_eq('select id from public.saved_setups', $$values ('f1100000-0000-4000-8000-00000000000a'::uuid)$$,
  'host A sees only social A''s saved setups');
select results_eq('select id from public.sessions', $$values ('d1100000-0000-4000-8000-000000000001'::uuid)$$,
  'host A sees only social A''s sessions');
select results_eq('select id from public.session_participants', $$values ('e1100000-0000-4000-8000-00000000000a'::uuid)$$,
  'host A sees only social A''s participants');
select results_eq('select id from public.checkin_requests', $$values ('c2100000-0000-4000-8000-00000000000a'::uuid)$$,
  'host A sees only social A''s check-in requests');
select is_empty('select * from public.session_events', 'host A sees none of B''s log');
select is_empty('select * from public.matches', 'host A sees none of B''s match rows');
reset role;

select set_config('request.jwt.claims', '{"sub":"a1100000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select results_eq('select name::text from public.socials', $$values ('Social A')$$, 'manager A sees only social A');
select set_eq(
  'select user_id from public.hosts',
  $$values ('a1100000-0000-4000-8000-000000000001'::uuid), ('a1100000-0000-4000-8000-000000000002'::uuid)$$,
  'manager A sees only social A''s hosts'
);
select results_eq(
  'select id from public.courts',
  $$values ('c1100000-0000-4000-8000-00000000000a'::uuid)$$,
  'manager A sees only social A''s courts'
);
select results_eq('select id from public.sessions', $$values ('d1100000-0000-4000-8000-000000000001'::uuid)$$,
  'manager A sees only social A''s sessions');
reset role;

select set_config('request.jwt.claims', '{"sub":"a1100000-0000-4000-8000-000000000004","role":"authenticated"}', true);
set local role authenticated;
select results_eq('select name::text from public.socials', $$values ('Social B')$$, 'host B sees only social B');
select set_eq(
  'select user_id from public.hosts',
  $$values ('a1100000-0000-4000-8000-000000000003'::uuid), ('a1100000-0000-4000-8000-000000000004'::uuid)$$,
  'host B sees only social B''s hosts'
);
select is_empty('select id from public.courts', 'host B sees none of A''s courts (B has none yet)');
select results_eq('select id from public.saved_setups', $$values ('f1100000-0000-4000-8000-00000000000b'::uuid)$$,
  'host B sees only social B''s saved setups');
select results_eq('select id from public.sessions', $$values ('d1100000-0000-4000-8000-000000000003'::uuid)$$,
  'host B sees only social B''s sessions');
select results_eq('select id from public.session_participants', $$values ('e1100000-0000-4000-8000-00000000000b'::uuid)$$,
  'host B sees only social B''s participants');
select is_empty('select * from public.checkin_requests', 'host B sees none of A''s check-in requests');
select results_eq('select event_id from public.session_events', $$values ('f2100000-0000-4000-8000-00000000000b'::uuid)$$,
  'host B sees B''s log');
select results_eq('select id from public.matches', $$values ('f3100000-0000-4000-8000-00000000000b'::uuid)$$,
  'host B sees B''s match rows');
reset role;

select set_config('request.jwt.claims', '{"sub":"a1100000-0000-4000-8000-000000000005","role":"authenticated"}', true);
set local role authenticated;
select is(private.current_social_id(), null, 'a non-host has no current social');
select is_empty('select * from public.socials', 'a non-host sees no socials');
select is_empty('select * from public.hosts', 'a non-host sees no hosts');
select is_empty('select * from public.courts', 'a non-host sees no courts');
reset role;

-- Per-social uniques and links ------------------------------------------------------
select lives_ok(
  $$insert into public.courts (id, social_id, name) values
    ('c1100000-0000-4000-8000-00000000000b', '51100000-0000-4000-8000-00000000000b', 'Court 1')$$,
  'B may have a "Court 1" too'
);
select throws_ok(
  $$insert into public.courts (social_id, name) values ('51100000-0000-4000-8000-00000000000a', 'court 1')$$,
  '23505', null, 'a second "Court 1" (any case) within A is refused'
);
select throws_ok(
  $$insert into public.session_participants (session_id, social_id, first_name, last_name, skill_level) values
    ('d1100000-0000-4000-8000-000000000003', '51100000-0000-4000-8000-00000000000a', 'Gus', 'Guest', 'beginner')$$,
  '23503', null, 'a participant cannot claim A while joining B''s session'
);
select throws_ok(
  $$insert into public.checkin_requests (session_id, social_id, first_name, last_name, skill_level, device_token_hash, ip_hash) values
    ('d1100000-0000-4000-8000-000000000001', '51100000-0000-4000-8000-00000000000b', 'Rhea', 'Request', 'beginner', repeat('6', 64), repeat('2', 64))$$,
  '23503', null, 'a check-in request cannot claim B while asking for A''s session'
);
select throws_ok(
  $$insert into public.sessions (social_id, host_id, name, host_name, planned_start, planned_end) values
    ('51100000-0000-4000-8000-00000000000a', 'a1100000-0000-4000-8000-000000000001', 'Second A draft', 'Manager A', now(), now() + interval '2 hours')$$,
  '23505', null, 'A cannot have a second open session, even from another of its hosts'
);
select throws_ok(
  $$insert into public.saved_setups (social_id, host_id, name, config) values
    ('51100000-0000-4000-8000-00000000000a', 'a1100000-0000-4000-8000-000000000001', ' tuesday', '{}')$$,
  '23514', null, 'setup names are trimmed labels'
);
select throws_ok(
  $$insert into public.saved_setups (social_id, host_id, name, config) values
    ('51100000-0000-4000-8000-00000000000a', 'a1100000-0000-4000-8000-000000000001', 'TUESDAY', '{}')$$,
  '23505', null, 'a second "Tuesday" (any case) within A is refused, whoever saves it (B has its own)'
);

-- Directory rows never move to another social ----------------------------------------
select throws_ok(
  $$update public.courts set social_id = '51100000-0000-4000-8000-00000000000b' where id = 'c1100000-0000-4000-8000-00000000000a'$$,
  'P0001', 'SOCIAL_ID_IMMUTABLE', 'a court cannot be moved to another social'
);
select throws_ok(
  $$update public.sessions set social_id = '51100000-0000-4000-8000-00000000000b' where id = 'd1100000-0000-4000-8000-000000000001'$$,
  'P0001', 'SOCIAL_ID_IMMUTABLE', 'a session cannot be moved to another social'
);
select throws_ok(
  $$update public.session_participants set social_id = '51100000-0000-4000-8000-00000000000b' where id = 'e1100000-0000-4000-8000-00000000000a'$$,
  'P0001', 'SOCIAL_ID_IMMUTABLE', 'a participant cannot be moved to another social'
);
select throws_ok(
  $$update public.checkin_requests set social_id = '51100000-0000-4000-8000-00000000000b' where id = 'c2100000-0000-4000-8000-00000000000a'$$,
  'P0001', 'SOCIAL_ID_IMMUTABLE', 'a check-in request cannot be moved to another social'
);
select throws_ok(
  $$update public.saved_setups set social_id = '51100000-0000-4000-8000-00000000000b' where id = 'f1100000-0000-4000-8000-00000000000a'$$,
  'P0001', 'SOCIAL_ID_IMMUTABLE', 'a saved setup cannot be moved to another social'
);

-- Check-in and attendance stay within the session's social -----------------------------
select is(
  public.submit_checkin('tagsociala00000001', 'd1100000-0000-4000-8000-000000000001'::uuid, repeat('3', 64), repeat('2', 64), 'Grace', 'Kimball', 'beginner', 'male') ->> 'status',
  'pending',
  'A''s tag with the name of B''s participant gives an ordinary pending request'
);
select results_eq(
  $$select social_id, session_id from public.checkin_requests where device_token_hash = repeat('3', 64)$$,
  $$values ('51100000-0000-4000-8000-00000000000a'::uuid, 'd1100000-0000-4000-8000-000000000001'::uuid)$$,
  'the request belongs to A''s open session'
);

-- Approving in A's draft: names are unique per session, never across socials.
select is(
  public.approve_checkin('a1100000-0000-4000-8000-000000000002',
    (select id from public.checkin_requests where device_token_hash = repeat('3', 64)),
    'e2100000-0000-4000-8000-000000000001', p_gender => 'male') ->> 'status',
  'approved',
  'host A approves a name B''s session also has'
);
select results_eq(
  $$select social_id, session_id from public.session_participants where id = 'e2100000-0000-4000-8000-000000000001'$$,
  $$values ('51100000-0000-4000-8000-00000000000a'::uuid, 'd1100000-0000-4000-8000-000000000001'::uuid)$$,
  'the new participant joins A''s draft in A'
);
select results_eq(
  $$select first_name::text, last_name::text, skill_level::text from public.session_participants
    where id = 'e1100000-0000-4000-8000-00000000000b'$$,
  $$values ('Grace', 'Kimball', 'beginner')$$,
  'B''s participant is unchanged'
);

-- Only A's hosts decide A's requests; anyone else is told it doesn't exist.
insert into public.checkin_requests (id, session_id, social_id, first_name, last_name, skill_level, device_token_hash, ip_hash) values
  ('c2100000-0000-4000-8000-000000000003', 'd1100000-0000-4000-8000-000000000001', '51100000-0000-4000-8000-00000000000a', 'Pia', 'Pending', 'beginner', repeat('8', 64), repeat('2', 64));
select throws_ok(
  $$select public.approve_checkin('a1100000-0000-4000-8000-000000000004', 'c2100000-0000-4000-8000-000000000003',
    'e2100000-0000-4000-8000-000000000003', p_gender => 'male')$$,
  'P0002', 'CHECKIN_REQUEST_NOT_FOUND', 'host B cannot approve A''s request (it looks missing)'
);
select throws_ok(
  $$select public.reject_checkin('a1100000-0000-4000-8000-000000000004', 'c2100000-0000-4000-8000-000000000003')$$,
  'P0002', 'CHECKIN_REQUEST_NOT_FOUND', 'host B cannot reject A''s request (it looks missing)'
);
select results_eq(
  $$select status::text, decided_by, session_participant_id from public.checkin_requests
    where id = 'c2100000-0000-4000-8000-000000000003'$$,
  $$values ('pending', null::uuid, null::uuid)$$,
  'A''s request is still pending and undecided'
);
select is(
  (select count(*) from public.session_participants where session_id = 'd1100000-0000-4000-8000-000000000001'),
  2::bigint,
  'A''s draft attendance is unchanged'
);

-- Every session, draft and setup write by one social's host on the other's
-- ids is refused as if they didn't exist, and changes nothing.
create temporary table rows_before on commit drop as
  select session.id, session.status, session.name::text, session.last_seq, session.draft_revision,
         (select count(*) from public.session_participants where session_id = session.id) as participant_count,
         (select count(*) from public.session_events where session_id = session.id) as event_count
  from public.sessions as session
  where session.id in ('d1100000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-000000000003');
select throws_ok(
  $$select public.append_session_event('a1100000-0000-4000-8000-000000000002', 'd1100000-0000-4000-8000-000000000003',
    gen_random_uuid(), 1, 'Resumed', '{}', now())$$,
  'P0002', 'SESSION_NOT_FOUND', 'host A cannot append to B''s log'
);
select throws_ok(
  $$select public.end_session('a1100000-0000-4000-8000-000000000002', 'd1100000-0000-4000-8000-000000000003',
    gen_random_uuid(), 1, now())$$,
  'P0002', 'SESSION_NOT_FOUND', 'host A cannot end B''s session'
);
select throws_ok(
  $$select public.start_session('a1100000-0000-4000-8000-000000000002', 'd1100000-0000-4000-8000-000000000003',
    gen_random_uuid(), now(), '{}')$$,
  'P0002', 'SESSION_NOT_FOUND', 'host A cannot start B''s session'
);
select throws_ok(
  $$select public.add_participant_mid_session('a1100000-0000-4000-8000-000000000002', 'd1100000-0000-4000-8000-000000000003',
    gen_random_uuid(), 'Gus', 'Guest', 'beginner', gen_random_uuid(), 1, now(), 'male')$$,
  'P0002', 'SESSION_NOT_FOUND', 'host A cannot add a participant to B''s live session'
);
select throws_ok(
  $$select public.cancel_draft_session('a1100000-0000-4000-8000-000000000004', 'd1100000-0000-4000-8000-000000000001')$$,
  'P0002', 'SESSION_NOT_FOUND', 'host B cannot cancel A''s draft'
);
select throws_ok(
  $$select public.remove_draft_participant('a1100000-0000-4000-8000-000000000004', 'e1100000-0000-4000-8000-00000000000a')$$,
  'P0002', 'PARTICIPANT_NOT_FOUND', 'host B cannot remove A''s participant'
);
select throws_ok(
  $$select public.save_session_draft('a1100000-0000-4000-8000-000000000004', 'd1100000-0000-4000-8000-000000000001', 0,
    'Hijack', '', 'Host B', now(), now() + interval '1 hour', '{}')$$,
  'P0002', 'DRAFT_NOT_OPEN', 'host B cannot save A''s draft'
);
select throws_ok(
  $$select public.add_draft_participant('a1100000-0000-4000-8000-000000000004', 'd1100000-0000-4000-8000-000000000001',
    gen_random_uuid(), 'Gus', 'Guest', 'beginner', 'male')$$,
  'P0002', 'DRAFT_NOT_OPEN', 'host B cannot add a participant to A''s draft'
);
select throws_ok(
  $$select public.apply_saved_setup('a1100000-0000-4000-8000-000000000002', 'd1100000-0000-4000-8000-000000000001',
    'f1100000-0000-4000-8000-00000000000b', 0, '', 90, '{}')$$,
  'P0002', 'SAVED_SETUP_NOT_FOUND', 'host A cannot apply B''s setup'
);
select throws_ok(
  $$select public.apply_saved_setup('a1100000-0000-4000-8000-000000000004', 'd1100000-0000-4000-8000-000000000001',
    'f1100000-0000-4000-8000-00000000000b', 0, '', 90, '{}')$$,
  'P0002', 'DRAFT_NOT_OPEN', 'host B cannot apply anything to A''s draft'
);
select is(
  public.save_setup('a1100000-0000-4000-8000-000000000004', 'Tuesday', '{"durationMinutes": 30}'),
  'f1100000-0000-4000-8000-00000000000b'::uuid,
  'host B saving "Tuesday" replaces B''s own setup'
);
select results_eq(
  $$select config from public.saved_setups where id = 'f1100000-0000-4000-8000-00000000000a'$$,
  $$values ('{}'::jsonb)$$,
  'A''s "Tuesday" is unchanged'
);
select set_eq(
  $$select session.id, session.status, session.name::text, session.last_seq, session.draft_revision,
           (select count(*) from public.session_participants where session_id = session.id) as participant_count,
           (select count(*) from public.session_events where session_id = session.id) as event_count
    from public.sessions as session
    where session.id in ('d1100000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-000000000003')$$,
  $$select * from rows_before$$,
  'neither social''s session, attendance or log changed'
);

set local role anon;
select throws_ok('select * from public.socials', '42501', null, 'anon cannot read socials');
reset role;

-- A host never moves to another social ------------------------------------------
select throws_ok(
  $$update public.hosts set social_id = '51100000-0000-4000-8000-00000000000b' where user_id = 'a1100000-0000-4000-8000-000000000002'$$,
  'P0001', 'SOCIAL_ID_IMMUTABLE', 'a host cannot be moved to another social'
);
select lives_ok(
  $$update public.hosts set social_id = social_id, display_name = 'Host A' where user_id = 'a1100000-0000-4000-8000-000000000002'$$,
  'writing the same social_id back is not a move'
);
select throws_ok(
  $$delete from public.socials where id = '51100000-0000-4000-8000-00000000000b'$$,
  '23503', null, 'a social with hosts cannot be deleted'
);

-- A social with hosts keeps a manager ---------------------------------------------
-- Deferred: in one transaction a manager can be demoted before another is
-- promoted; only the state at commit (here: SET CONSTRAINTS IMMEDIATE) counts.
set constraints hosts_keep_one_manager_per_social deferred;
select lives_ok(
  $$update public.hosts set role = 'host' where user_id = 'a1100000-0000-4000-8000-000000000003'$$,
  'demoting B''s only manager is not checked until commit'
);
select lives_ok(
  $$update public.hosts set role = 'manager' where user_id = 'a1100000-0000-4000-8000-000000000004'$$,
  'promoting another host of B in the same transaction'
);
select lives_ok(
  $$set constraints hosts_keep_one_manager_per_social immediate$$,
  'at commit B has a manager again, so the check passes'
);

-- From here on every statement is checked as it ends.
select throws_ok(
  $$update public.hosts set role = 'host' where user_id = 'a1100000-0000-4000-8000-000000000001'$$,
  'P0001', 'LAST_MANAGER', 'A''s only manager cannot be demoted while A has a host'
);
select throws_ok(
  $$delete from public.hosts where user_id = 'a1100000-0000-4000-8000-000000000001'$$,
  'P0001', 'LAST_MANAGER', 'A''s only manager cannot be removed while A has a host'
);
select throws_ok(
  $$delete from public.hosts where user_id in ('a1100000-0000-4000-8000-000000000006', 'a1100000-0000-4000-8000-000000000007')$$,
  'P0001', 'LAST_MANAGER', 'deleting C''s manager and a host in one statement fails while another host stays'
);
select lives_ok(
  $$delete from public.hosts where user_id in ('a1100000-0000-4000-8000-000000000009', 'a1100000-0000-4000-8000-000000000010')$$,
  'deleting D''s manager and its only host together empties D, which is allowed'
);
select lives_ok(
  $$delete from public.socials where id = '51100000-0000-4000-8000-00000000000d'$$,
  'an empty social can be deleted'
);
select lives_ok(
  $$delete from public.hosts where user_id = 'a1100000-0000-4000-8000-000000000008'$$,
  'a plain host can be removed while the social keeps its manager'
);

-- The check-in tag belongs to the social --------------------------------------------
select is(
  (private.find_open_session_by_checkin_tag('tagsocialb00000001')).id,
  'd1100000-0000-4000-8000-000000000003'::uuid,
  'B''s tag opens B''s open session'
);
select is(
  (private.find_open_session_by_checkin_tag('tagsociala00000001')).id,
  'd1100000-0000-4000-8000-000000000001'::uuid,
  'A''s tag opens A''s one open session'
);
select throws_ok(
  $$select private.find_open_session_by_checkin_tag('tagsocialc00000001')$$,
  'P0002', 'NO_OPEN_SESSION', 'a social with nothing open answers like an unknown tag'
);

-- create_social_with_manager ----------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.create_social_with_manager(text, uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.create_social_with_manager(text, uuid, text)', 'execute'),
  'only the server can create socials'
);
set local role service_role;
select throws_ok(
  $$select public.create_social_with_manager('Atomic Social', 'a1100000-0000-4000-8000-000000000002', 'Host A')$$,
  '23505', null, 'a login that hosts a social cannot manage a new one'
);
select throws_ok(
  $$select public.create_social_with_manager('   ', 'a1100000-0000-4000-8000-000000000005', 'Outsider')$$,
  '23514', null, 'a blank social name is refused'
);
reset role;
select is(
  (select count(*) from public.socials where name in ('Atomic Social', '   ')),
  0::bigint,
  'a refused create_social_with_manager leaves no social behind'
);
set local role service_role;
select lives_ok(
  $$select public.create_social_with_manager('Outsider Social', 'a1100000-0000-4000-8000-000000000005', 'Outsider')$$,
  'a login on no social can become the manager of a new one'
);
reset role;
select results_eq(
  $$select social.name::text, host.role::text from public.hosts as host
    join public.socials as social on social.id = host.social_id
    where host.user_id = 'a1100000-0000-4000-8000-000000000005'$$,
  $$values ('Outsider Social', 'manager')$$,
  'the new social has the login as its manager'
);

select * from finish();
rollback;
