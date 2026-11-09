-- Draft housekeeping (cancel_draft_session, remove_draft_participant) and the
-- integrity triggers: config snapshot locked after the start, participants
-- removable only from a draft, and at least one social manager per social
-- with hosts (more cases in 11_social_isolation.test.sql).
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-000000000001', 'pgtap-manager@example.test'),
  ('a0000000-0000-4000-8000-000000000002', 'pgtap-host@example.test'),
  ('a0000000-0000-4000-8000-000000000003', 'pgtap-outsider@example.test');
insert into public.socials (id, name) values ('50000000-0000-4000-8000-000000000005', 'pgTAP Social');
insert into public.hosts (user_id, display_name, role, social_id) values
  ('a0000000-0000-4000-8000-000000000001', 'Mia Manager', 'manager', '50000000-0000-4000-8000-000000000005'),
  ('a0000000-0000-4000-8000-000000000002', 'Hal Host', 'host', '50000000-0000-4000-8000-000000000005');
-- One open session per social: the manager's session (d...02) comes once the host's draft is cancelled.
insert into public.sessions (id, social_id, host_id, name, host_name, planned_start, planned_end) values
  ('d0000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000002', 'Tuesday social', 'Hal Host', now(), now() + interval '2 hours');
insert into public.members (social_id, id, first_name, last_name) values
  ('50000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000001', 'Grace', 'Kim'),
  ('50000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000002', 'Kofi', 'Mensah');
insert into public.session_participants (id, session_id, social_id, member_id, first_name, last_name) values
  ('e0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000001', 'Grace', 'Kim');
-- Grace was approved from a check-in.
insert into public.checkin_requests (id, session_id, social_id, member_id, first_name, last_name, status, device_token_hash, ip_hash, decided_by, decided_at, session_participant_id) values
  ('c1000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000001', 'Grace', 'Kim', 'approved',
   repeat('a', 64), repeat('b', 64), 'a0000000-0000-4000-8000-000000000002', now(), 'e0000000-0000-4000-8000-000000000001');

set local role service_role;

-- remove_draft_participant ---------------------------------------------------------------
select throws_ok(
  $$select public.remove_draft_participant('a0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000001')$$,
  '42501', 'NOT_A_HOST', 'a non-host cannot remove participants'
);
select throws_ok(
  $$delete from public.session_participants where id = 'e0000000-0000-4000-8000-000000000001'$$,
  '23503', null, 'a participant added by an approval cannot be deleted directly'
);
select is(
  public.remove_draft_participant('a0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000001') ->> 'status',
  'removed',
  'a host removes an approved participant from a draft'
);
select results_eq(
  $$select status::text, session_participant_id is null, decided_at is not null,
           (select count(*) from public.session_participants where id = 'e0000000-0000-4000-8000-000000000001')
    from public.checkin_requests where id = 'c1000000-0000-4000-8000-000000000001'$$,
  $$values ('withdrawn'::text, true, true, 0::bigint)$$,
  'the request is withdrawn (decision time kept) and the participant is gone'
);
select throws_ok(
  $$select public.remove_draft_participant('a0000000-0000-4000-8000-000000000002', gen_random_uuid())$$,
  'P0002', 'PARTICIPANT_NOT_FOUND', 'removing an unknown participant fails clearly'
);

-- Config snapshot and cancel_draft_session ----------------------------------------------------
select lives_ok(
  $$update public.sessions set config_snapshot = '{"draft":true}' where id = 'd0000000-0000-4000-8000-000000000001'$$,
  'a draft''s config snapshot can change'
);
select throws_ok(
  $$insert into public.sessions (social_id, host_id, name, host_name, planned_start, planned_end)
    values ('50000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001', 'Second open social', 'Mia Manager', now(), now() + interval '2 hours')$$,
  '23505', null, 'a social has at most one open session, whichever host creates it'
);
select throws_ok(
  $$select public.cancel_draft_session('a0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000001')$$,
  '42501', 'NOT_A_HOST', 'a non-host cannot cancel a draft'
);
select is(
  public.cancel_draft_session('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001') ->> 'status',
  'cancelled',
  'a host of the social cancels its draft'
);
select is(
  public.cancel_draft_session('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001') ->> 'status',
  'already_cancelled',
  'cancelling twice is idempotent'
);
select lives_ok(
  $$insert into public.sessions (id, social_id, host_id, name, host_name, planned_start, planned_end)
    values ('d0000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001', 'Manager social', 'Mia Manager', now(), now() + interval '2 hours')$$,
  'cancelling frees the social''s one open-session slot'
);
reset role;
insert into public.session_participants (id, session_id, social_id, member_id, first_name, last_name) values
  ('e0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000002', 'Kofi', 'Mensah');
set local role service_role;
select throws_ok(
  $$update public.sessions set config_snapshot = '{"edited":true}' where id = 'd0000000-0000-4000-8000-000000000001'$$,
  'P0001', 'CONFIG_SNAPSHOT_LOCKED', 'a cancelled session''s config snapshot is locked'
);

-- After the start ------------------------------------------------------------------------------
select is(
  public.start_session('a0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002', gen_random_uuid(), now(),
    '{"config":{"participants":[{"participantId":"e0000000-0000-4000-8000-000000000002"}]},"initialAttendeeIds":["e0000000-0000-4000-8000-000000000002"]}') ->> 'status',
  'appended',
  'the manager starts their session'
);
select throws_ok(
  $$select public.cancel_draft_session('a0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002')$$,
  'P0001', 'SESSION_NOT_DRAFT', 'a live session cannot be cancelled'
);
select throws_ok(
  $$update public.sessions set config_snapshot = '{"edited":true}' where id = 'd0000000-0000-4000-8000-000000000002'$$,
  'P0001', 'CONFIG_SNAPSHOT_LOCKED', 'a live session''s config snapshot is locked'
);
select throws_ok(
  $$delete from public.session_participants where id = 'e0000000-0000-4000-8000-000000000002'$$,
  'P0001', 'SESSION_NOT_DRAFT', 'a live session''s participants cannot be deleted'
);
select throws_ok(
  $$select public.remove_draft_participant('a0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002')$$,
  'P0001', 'SESSION_NOT_DRAFT', 'remove_draft_participant refuses a live session'
);
reset role;

-- At least one manager per social with hosts ------------------------------------------------------
-- The guard is deferred to commit; this rolled-back test checks at each statement instead.
set constraints hosts_keep_one_manager_per_social immediate;
select throws_ok(
  $$update public.hosts set role = 'host' where user_id = 'a0000000-0000-4000-8000-000000000001'$$,
  'P0001', 'LAST_MANAGER', 'the social''s last manager cannot be demoted'
);
select throws_ok(
  $$delete from auth.users where id = 'a0000000-0000-4000-8000-000000000001'$$,
  'P0001', 'LAST_MANAGER', 'the social''s last manager cannot be removed, even by deleting their user'
);
update public.hosts set role = 'manager' where user_id = 'a0000000-0000-4000-8000-000000000002';
select lives_ok(
  $$update public.hosts set role = 'host' where user_id = 'a0000000-0000-4000-8000-000000000001'$$,
  'a manager can be demoted once the social has another manager'
);

select * from finish();
rollback;
