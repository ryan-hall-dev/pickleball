-- Socials and hosts (M4.5 A1, docs/plans/socials.md): a host reads only their
-- own social and its hosts; a host never moves to another social; a social
-- with hosts keeps a manager (checked at commit); the check-in tag belongs to
-- the social; create_social_with_manager is atomic and service_role only.
-- Members, courts, setups and sessions are scoped by A2/A3, which extend this file.
begin;
create extension if not exists pgtap with schema extensions;
select plan(35);

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

-- Schema ----------------------------------------------------------------------
select col_type_is('public', 'hosts', 'social_id', 'uuid', 'hosts.social_id is a uuid');
select col_not_null('public', 'hosts', 'social_id', 'every host belongs to a social');
select is(
  (select count(*) from pg_policies
   where schemaname = 'public' and tablename in ('socials', 'hosts')
     and qual like '%current_social_id%'),
  2::bigint,
  'the socials and hosts policies compare against current_social_id'
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
reset role;

select set_config('request.jwt.claims', '{"sub":"a1100000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select results_eq('select name::text from public.socials', $$values ('Social A')$$, 'manager A sees only social A');
select set_eq(
  'select user_id from public.hosts',
  $$values ('a1100000-0000-4000-8000-000000000001'::uuid), ('a1100000-0000-4000-8000-000000000002'::uuid)$$,
  'manager A sees only social A''s hosts'
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
reset role;

select set_config('request.jwt.claims', '{"sub":"a1100000-0000-4000-8000-000000000005","role":"authenticated"}', true);
set local role authenticated;
select is(private.current_social_id(), null, 'a non-host has no current social');
select is_empty('select * from public.socials', 'a non-host sees no socials');
select is_empty('select * from public.hosts', 'a non-host sees no hosts');
reset role;

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
