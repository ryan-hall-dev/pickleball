-- An empty database works: no socials, hosts or sessions. Rows left
-- by `pnpm seed` and other runs are cleared inside this (rolled back)
-- transaction first. The first social and its manager come from
-- create_social_with_manager (`pnpm create-social`).
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

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
delete from public.courts;
-- Emptying every social at once passes the last-manager guard.
delete from public.hosts;
delete from public.socials;

insert into auth.users (id, email) values ('a0000000-0000-4000-8000-000000000009', 'pgtap-first-login@example.test');

-- The server calls everything as service_role.
set local role service_role;
select is(
  public.get_checkin_page('tag0000000000000001', repeat('a', 64)),
  '{"status":"inactive"}'::jsonb,
  'the check-in page on an empty database says the link is inactive'
);
select throws_ok(
  $$select public.submit_checkin('tag0000000000000001', 'd0000000-0000-4000-8000-000000000001'::uuid, repeat('a', 64), repeat('b', 64), 'Nina', 'New', 'beginner')$$,
  'P0001', 'SESSION_CHANGED', 'submit on an empty database says no session is open'
);
select throws_ok(
  $$select public.append_session_event('a0000000-0000-4000-8000-000000000009', gen_random_uuid(), gen_random_uuid(), 0, 'Paused', '{}', now())$$,
  '42501', 'NOT_A_HOST', 'with no hosts yet, nobody can write the log'
);
reset role;

select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000009","role":"authenticated"}', true);
set local role authenticated;
select is_empty('select * from public.socials', 'a signed-in user sees no socials (none yet)');
select is_empty('select * from public.sessions', 'a signed-in user sees no sessions');
reset role;

-- The operator creates the first social and its manager in one call, then it works normally.
set local role service_role;
select isnt(
  public.create_social_with_manager('First Social', 'a0000000-0000-4000-8000-000000000009', 'First Manager'),
  null,
  'the server can create the first social with its manager'
);
select throws_ok(
  $$select public.create_social_with_manager('Second Social', 'a0000000-0000-4000-8000-000000000009', 'First Manager')$$,
  '23505', null, 'a login that already hosts a social cannot manage a second one'
);
select throws_ok(
  $$select public.append_session_event('a0000000-0000-4000-8000-000000000009', gen_random_uuid(), gen_random_uuid(), 0, 'Paused', '{}', now())$$,
  'P0002', 'SESSION_NOT_FOUND', 'a host writing to a missing session gets a clear error'
);
reset role;

select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000009","role":"authenticated"}', true);
set local role authenticated;
select results_eq(
  $$select name::text, checkin_tag ~ '^[a-z0-9]{32}$' from public.socials$$,
  $$values ('First Social', true)$$,
  'the manager reads exactly their new social, which has a fresh check-in tag'
);
select results_eq(
  $$select role::text from public.hosts$$,
  $$values ('manager')$$,
  'the first login is the social''s manager'
);
reset role;

select * from finish();
rollback;
