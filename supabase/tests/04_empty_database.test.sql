-- An empty database works: no club settings, hosts, members or sessions. Rows
-- left by `pnpm seed` are cleared inside this (rolled back) transaction first.
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

alter table public.session_events disable trigger session_events_block_update_delete;
delete from public.session_events;
alter table public.session_events enable trigger session_events_block_update_delete;
delete from public.checkin_attempts;
delete from public.checkin_requests;
delete from public.matches;
alter table public.session_participants disable trigger session_participants_delete_only_in_draft;
delete from public.session_participants;
alter table public.session_participants enable trigger session_participants_delete_only_in_draft;
delete from public.sessions;
delete from public.saved_setups;
delete from public.member_devices;
delete from public.members;
delete from public.courts;
alter table public.hosts disable trigger hosts_keep_one_admin;
delete from public.hosts;
alter table public.hosts enable trigger hosts_keep_one_admin;
delete from public.club_settings;

insert into auth.users (id, email) values ('a0000000-0000-4000-8000-000000000009', 'pgtap-first-login@example.test');

-- The server calls everything as service_role.
set local role service_role;
select throws_ok(
  $$select * from public.search_checkin_names('tag0000000000000001', 'gr', repeat('a', 64), repeat('b', 64))$$,
  'P0002', 'NO_OPEN_SESSION', 'search on an empty database says no session is open'
);
select throws_ok(
  $$select public.submit_checkin('tag0000000000000001', repeat('a', 64), repeat('b', 64), 'Nina', 'New', 'beginner')$$,
  'P0002', 'NO_OPEN_SESSION', 'submit on an empty database says no session is open'
);
select throws_ok(
  $$select public.append_session_event('a0000000-0000-4000-8000-000000000009', gen_random_uuid(), gen_random_uuid(), 0, 'Paused', '{}', now())$$,
  '42501', 'NOT_A_HOST', 'with no hosts yet, nobody can write the log'
);
reset role;

select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000009","role":"authenticated"}', true);
set local role authenticated;
select is_empty('select * from public.club_settings', 'a signed-in user sees no club settings (none yet)');
select is_empty('select * from public.sessions', 'a signed-in user sees no sessions');
reset role;

-- The first admin is bootstrapped by the owner (seed script or SQL), then works normally.
insert into public.hosts (user_id, display_name, role) values ('a0000000-0000-4000-8000-000000000009', 'First Admin', 'admin');
set local role service_role;
select throws_ok(
  $$select public.append_session_event('a0000000-0000-4000-8000-000000000009', gen_random_uuid(), gen_random_uuid(), 0, 'Paused', '{}', now())$$,
  'P0002', 'SESSION_NOT_FOUND', 'a host writing to a missing session gets a clear error'
);
select lives_ok(
  $$insert into public.club_settings (club_name) values ('New Club')$$,
  'the server can create the club settings row'
);
select throws_ok(
  $$insert into public.club_settings (club_name) values ('Second Club')$$,
  '23505', null, 'club_settings holds a single row'
);
reset role;

select * from finish();
rollback;
