-- Socials and hosts (M4.5 A1, docs/plans/socials.md): a host reads only their
-- own social and its hosts; a host never moves to another social; a social
-- with hosts keeps a manager (checked at commit); the check-in tag belongs to
-- the social; create_social_with_manager is atomic and service_role only.
-- The directory (A2): members, member phones and courts belong to one social;
-- reads, check-in search/submit/approve and draft attendance never cross
-- socials; per-social uniques; composite FK for phones.
-- Setups and sessions are scoped by A3, which extends this file.
begin;
create extension if not exists pgtap with schema extensions;
select plan(78);

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
-- Open sessions: in A a host's draft and the manager's live one; in B a draft.
insert into public.sessions (id, host_id, name, host_name, planned_start, planned_end, status, started_at) values
  ('d1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000002', 'A draft', 'Host A',
   now(), now() + interval '2 hours', 'draft', null),
  ('d1100000-0000-4000-8000-000000000002', 'a1100000-0000-4000-8000-000000000001', 'A live', 'Manager A',
   now(), now() + interval '2 hours', 'live', now()),
  ('d1100000-0000-4000-8000-000000000003', 'a1100000-0000-4000-8000-000000000004', 'B draft', 'Host B',
   now(), now() + interval '2 hours', 'draft', null);

-- The directory: in A and B a member named Grace K..., the same phone, and a
-- "Court 1" each (B's phone and court are inserted by the checks below).
insert into public.members (id, social_id, first_name, last_name, skill_level) values
  ('b1100000-0000-4000-8000-00000000000a', '51100000-0000-4000-8000-00000000000a', 'Grace', 'Kim', 'advanced'),
  ('b1100000-0000-4000-8000-00000000000b', '51100000-0000-4000-8000-00000000000b', 'Grace', 'Kimball', 'beginner');
insert into public.member_devices (social_id, token_hash, member_id) values
  ('51100000-0000-4000-8000-00000000000a', repeat('d', 64), 'b1100000-0000-4000-8000-00000000000a');
insert into public.courts (id, social_id, name) values
  ('c1100000-0000-4000-8000-00000000000a', '51100000-0000-4000-8000-00000000000a', 'Court 1');

-- Schema ----------------------------------------------------------------------
select col_type_is('public', 'hosts', 'social_id', 'uuid', 'hosts.social_id is a uuid');
select col_not_null('public', 'hosts', 'social_id', 'every host belongs to a social');
select col_not_null('public', 'members', 'social_id', 'every member belongs to a social');
select col_not_null('public', 'member_devices', 'social_id', 'every member phone belongs to a social');
select col_not_null('public', 'courts', 'social_id', 'every court belongs to a social');
select is(
  (select count(*) from pg_policies
   where schemaname = 'public' and tablename in ('socials', 'hosts', 'members', 'courts')
     and qual like '%current_social_id%'),
  4::bigint,
  'the socials, hosts, members and courts policies compare against current_social_id'
);
select is(
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'member_devices'),
  0::bigint,
  'member_devices has no read policy'
);
select col_is_pk('public', 'member_devices', array['social_id', 'token_hash'], 'a phone is recognised per social');
select fk_ok(
  'public', 'member_devices', array['member_id', 'social_id'],
  'public', 'members', array['id', 'social_id'],
  'a phone links only to a member of its own social'
);
select is(
  (select count(*) from pg_constraint
   where conrelid = 'public.member_devices'::regclass and contype = 'f'),
  1::bigint,
  'the composite FK replaced the single-column one (no ambiguous PostgREST embed)'
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
  'select id from public.members',
  $$values ('b1100000-0000-4000-8000-00000000000a'::uuid)$$,
  'host A sees only social A''s members'
);
select results_eq(
  'select id from public.courts',
  $$values ('c1100000-0000-4000-8000-00000000000a'::uuid)$$,
  'host A sees only social A''s courts'
);
select throws_ok('select * from public.member_devices', '42501', null, 'host A cannot read member phones');
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
  'select id from public.members',
  $$values ('b1100000-0000-4000-8000-00000000000a'::uuid)$$,
  'manager A sees only social A''s members'
);
select results_eq(
  'select id from public.courts',
  $$values ('c1100000-0000-4000-8000-00000000000a'::uuid)$$,
  'manager A sees only social A''s courts'
);
reset role;

select set_config('request.jwt.claims', '{"sub":"a1100000-0000-4000-8000-000000000004","role":"authenticated"}', true);
set local role authenticated;
select results_eq('select name::text from public.socials', $$values ('Social B')$$, 'host B sees only social B');
select set_eq(
  'select user_id from public.hosts',
  $$values ('a1100000-0000-4000-8000-000000000003'::uuid), ('a1100000-0000-4000-8000-000000000004'::uuid)$$,
  'host B sees only social B''s hosts'
);
select results_eq(
  'select id from public.members',
  $$values ('b1100000-0000-4000-8000-00000000000b'::uuid)$$,
  'host B sees only social B''s members'
);
select is_empty('select id from public.courts', 'host B sees none of A''s courts (B has none yet)');
reset role;

select set_config('request.jwt.claims', '{"sub":"a1100000-0000-4000-8000-000000000005","role":"authenticated"}', true);
set local role authenticated;
select is(private.current_social_id(), null, 'a non-host has no current social');
select is_empty('select * from public.socials', 'a non-host sees no socials');
select is_empty('select * from public.hosts', 'a non-host sees no hosts');
select is_empty('select * from public.members', 'a non-host sees no members');
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
select lives_ok(
  $$insert into public.member_devices (social_id, token_hash, member_id) values
    ('51100000-0000-4000-8000-00000000000b', repeat('d', 64), 'b1100000-0000-4000-8000-00000000000b')$$,
  'the same phone can be a different member in B'
);
select throws_ok(
  $$insert into public.member_devices (social_id, token_hash, member_id) values
    ('51100000-0000-4000-8000-00000000000a', repeat('d', 64), 'b1100000-0000-4000-8000-00000000000a')$$,
  '23505', null, 'a phone is linked once per social'
);
select throws_ok(
  $$insert into public.member_devices (social_id, token_hash, member_id) values
    ('51100000-0000-4000-8000-00000000000a', repeat('e', 64), 'b1100000-0000-4000-8000-00000000000b')$$,
  '23503', null, 'a phone in A cannot point at B''s member'
);

-- Directory rows never move to another social ----------------------------------------
select throws_ok(
  $$update public.members set social_id = '51100000-0000-4000-8000-00000000000b' where id = 'b1100000-0000-4000-8000-00000000000a'$$,
  'P0001', 'SOCIAL_ID_IMMUTABLE', 'a member cannot be moved to another social'
);
select throws_ok(
  $$update public.member_devices set social_id = '51100000-0000-4000-8000-00000000000b'
    where social_id = '51100000-0000-4000-8000-00000000000a' and token_hash = repeat('d', 64)$$,
  'P0001', 'SOCIAL_ID_IMMUTABLE', 'a member phone cannot be moved to another social'
);
select throws_ok(
  $$update public.courts set social_id = '51100000-0000-4000-8000-00000000000b' where id = 'c1100000-0000-4000-8000-00000000000a'$$,
  'P0001', 'SOCIAL_ID_IMMUTABLE', 'a court cannot be moved to another social'
);

-- Check-in and attendance stay within the session's social -----------------------------
select results_eq(
  $$select member_id from public.search_checkin_names('tagsociala00000001', 'grace k', repeat('1', 64), repeat('2', 64))$$,
  $$values ('b1100000-0000-4000-8000-00000000000a'::uuid)$$,
  'A''s tag searches only A''s members'
);
select results_eq(
  $$select member_id from public.search_checkin_names('tagsocialb00000001', 'grace k', repeat('1', 64), repeat('2', 64))$$,
  $$values ('b1100000-0000-4000-8000-00000000000b'::uuid)$$,
  'B''s tag searches only B''s members'
);
select is(
  public.submit_checkin('tagsociala00000001', repeat('3', 64), repeat('2', 64), 'Grace', 'Kimball', null,
    'b1100000-0000-4000-8000-00000000000b') ->> 'status',
  'member_not_found',
  'A''s tag with B''s member answers member_not_found'
);
select is(
  (select count(*) from public.checkin_requests where device_token_hash = repeat('3', 64)),
  0::bigint,
  'and creates no request'
);

-- Host A's draft (until A3: the draft's social is its host's).
select lives_ok(
  $$select public.set_draft_member_attendance('a1100000-0000-4000-8000-000000000002', 'd1100000-0000-4000-8000-000000000001',
    array['b1100000-0000-4000-8000-00000000000a', 'b1100000-0000-4000-8000-00000000000b']::uuid[], true)$$,
  'attendance with A''s and B''s members'
);
select results_eq(
  $$select member_id from public.session_participants where session_id = 'd1100000-0000-4000-8000-000000000001'$$,
  $$values ('b1100000-0000-4000-8000-00000000000a'::uuid)$$,
  'only A''s member joins A''s draft; B''s is skipped'
);

-- Approving in A's draft: a new player (on the phone B also knows) and a
-- request naming B's member.
insert into public.checkin_requests (id, session_id, member_id, first_name, last_name, skill_level, device_token_hash, ip_hash) values
  ('c2100000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-000000000001', null, 'Nina', 'New', 'beginner', repeat('d', 64), repeat('2', 64)),
  ('c2100000-0000-4000-8000-000000000002', 'd1100000-0000-4000-8000-000000000001', 'b1100000-0000-4000-8000-00000000000b', 'Grace', 'Kimball', null, repeat('7', 64), repeat('2', 64));
select is(
  public.approve_checkin('a1100000-0000-4000-8000-000000000002', 'c2100000-0000-4000-8000-000000000001',
    'e2100000-0000-4000-8000-000000000001') ->> 'status',
  'approved',
  'host A approves a new player'
);
select results_eq(
  $$select member.social_id from public.members as member
    join public.checkin_requests as request on request.member_id = member.id
    where request.id = 'c2100000-0000-4000-8000-000000000001'$$,
  $$values ('51100000-0000-4000-8000-00000000000a'::uuid)$$,
  'the new member joins A''s directory'
);
select results_eq(
  $$select device.social_id, device.member_id = request.member_id from public.member_devices as device
    cross join public.checkin_requests as request
    where device.token_hash = repeat('d', 64) and request.id = 'c2100000-0000-4000-8000-000000000001'
    order by device.social_id$$,
  $$values ('51100000-0000-4000-8000-00000000000a'::uuid, true), ('51100000-0000-4000-8000-00000000000b'::uuid, false)$$,
  'the phone now means the new member in A and still B''s member in B'
);
select throws_ok(
  $$select public.approve_checkin('a1100000-0000-4000-8000-000000000002', 'c2100000-0000-4000-8000-000000000002',
    'e2100000-0000-4000-8000-000000000002')$$,
  'P0002', 'MEMBER_NOT_FOUND', 'a request naming B''s member cannot be approved into A'
);
select results_eq(
  $$select first_name::text, last_name::text, skill_level::text, last_checked_in_at from public.members
    where id = 'b1100000-0000-4000-8000-00000000000b'$$,
  $$values ('Grace', 'Kimball', 'beginner', null::timestamptz)$$,
  'B''s member is unchanged'
);

-- Only A's hosts decide A's requests; anyone else is told it doesn't exist.
insert into public.checkin_requests (id, session_id, member_id, first_name, last_name, skill_level, device_token_hash, ip_hash) values
  ('c2100000-0000-4000-8000-000000000003', 'd1100000-0000-4000-8000-000000000001', null, 'Pia', 'Pending', 'beginner', repeat('8', 64), repeat('2', 64));
select throws_ok(
  $$select public.approve_checkin('a1100000-0000-4000-8000-000000000004', 'c2100000-0000-4000-8000-000000000003',
    'e2100000-0000-4000-8000-000000000003')$$,
  'P0002', 'CHECKIN_REQUEST_NOT_FOUND', 'host B cannot approve A''s request (it looks missing)'
);
select throws_ok(
  $$select public.reject_checkin('a1100000-0000-4000-8000-000000000004', 'c2100000-0000-4000-8000-000000000003')$$,
  'P0002', 'CHECKIN_REQUEST_NOT_FOUND', 'host B cannot reject A''s request (it looks missing)'
);
select results_eq(
  $$select status::text, decided_by, member_id, session_participant_id from public.checkin_requests
    where id = 'c2100000-0000-4000-8000-000000000003'$$,
  $$values ('pending', null::uuid, null::uuid, null::uuid)$$,
  'A''s request is still pending and undecided'
);
select is(
  (select count(*) from public.member_devices where token_hash = repeat('8', 64)),
  0::bigint,
  'no phone was linked'
);
select is(
  (select count(*) from public.members where social_id = '51100000-0000-4000-8000-00000000000a'),
  2::bigint,
  'A''s directory is unchanged (Grace and the approved Nina)'
);
select is(
  (select count(*) from public.session_participants where session_id = 'd1100000-0000-4000-8000-000000000001'),
  2::bigint,
  'A''s draft attendance is unchanged'
);

-- A session whose creator was removed belongs to no known social until A3.
insert into public.sessions (id, host_id, name, host_name, planned_start, planned_end, status) values
  ('d1100000-0000-4000-8000-000000000009', null, 'Orphaned draft', 'Gone Host', now(), now() + interval '2 hours', 'draft');
insert into public.checkin_requests (id, session_id, member_id, first_name, last_name, skill_level, device_token_hash, ip_hash) values
  ('c2100000-0000-4000-8000-000000000009', 'd1100000-0000-4000-8000-000000000009', null, 'Otto', 'Orphan', 'beginner', repeat('9', 64), repeat('2', 64));
select throws_ok(
  $$select public.approve_checkin('a1100000-0000-4000-8000-000000000002', 'c2100000-0000-4000-8000-000000000009',
    'e2100000-0000-4000-8000-000000000009')$$,
  'P0002', 'CHECKIN_REQUEST_NOT_FOUND', 'a request in a session with no known social cannot be approved'
);
select throws_ok(
  $$select public.reject_checkin('a1100000-0000-4000-8000-000000000002', 'c2100000-0000-4000-8000-000000000009')$$,
  'P0002', 'CHECKIN_REQUEST_NOT_FOUND', 'nor rejected'
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
  'd1100000-0000-4000-8000-000000000002'::uuid,
  'with two open sessions in A (until A3), A''s tag opens the live one'
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
