-- Draft attendance (Setup "Who's playing?"), session-only participants
-- (20261112090000): add_draft_participant (name and level required, one name
-- per session) and remove_draft_participant (any participant).
begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

insert into auth.users (id, email) values
  ('a8000000-0000-4000-8000-000000000001', 'pgtap-attendance-owner@example.test'),
  ('a8000000-0000-4000-8000-000000000002', 'pgtap-attendance-other@example.test'),
  ('a8000000-0000-4000-8000-000000000003', 'pgtap-attendance-outsider@example.test'),
  ('a8000000-0000-4000-8000-000000000004', 'pgtap-attendance-cohost@example.test');
-- The owner and a co-host share one social; the other host runs another social.
insert into public.socials (id, name) values
  ('50000000-0000-4000-8000-000000000008', 'pgTAP Social'),
  ('50000000-0000-4000-8000-000000000018', 'pgTAP Other Social');
insert into public.hosts (user_id, display_name, role, social_id) values
  ('a8000000-0000-4000-8000-000000000001', 'Owner Host', 'host', '50000000-0000-4000-8000-000000000008'),
  ('a8000000-0000-4000-8000-000000000004', 'Co Host', 'host', '50000000-0000-4000-8000-000000000008'),
  ('a8000000-0000-4000-8000-000000000002', 'Other Host', 'host', '50000000-0000-4000-8000-000000000018');
insert into public.sessions (id, social_id, host_id, name, host_name, planned_start, planned_end, status) values
  ('d8000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000008', 'a8000000-0000-4000-8000-000000000001', 'Owner draft', 'Owner Host',
   now(), now() + interval '2 hours', 'draft'),
  ('d8000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000018', 'a8000000-0000-4000-8000-000000000002', 'Other draft', 'Other Host',
   now(), now() + interval '2 hours', 'draft'),
  -- The social's earlier session, no longer a draft.
  ('d8000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000008', 'a8000000-0000-4000-8000-000000000001', 'Old one', 'Owner Host',
   now(), now() + interval '2 hours', 'cancelled');
-- The other social's attendee, which nothing here may touch.
insert into public.session_participants (id, session_id, social_id, first_name, last_name, skill_level) values
  ('e8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000018', 'Omar', 'Other', 'beginner');

-- Grants: only the server's secret key can call them.
select ok(not has_function_privilege('anon', 'public.add_draft_participant(uuid, uuid, uuid, text, text, public.skill_level)', 'execute'),
  'anon cannot execute add_draft_participant');
select ok(not has_function_privilege('authenticated', 'public.add_draft_participant(uuid, uuid, uuid, text, text, public.skill_level)', 'execute'),
  'authenticated cannot execute add_draft_participant');
select ok(has_function_privilege('service_role', 'public.add_draft_participant(uuid, uuid, uuid, text, text, public.skill_level)', 'execute'),
  'service_role can execute add_draft_participant');
select hasnt_function('public', 'set_draft_member_attendance', 'set_draft_member_attendance is gone');
select hasnt_function('public', 'add_draft_guest', 'add_draft_guest is gone');
select hasnt_function('public', 'remove_draft_guest', 'remove_draft_guest is gone');

set local role service_role;

-- Refusals -----------------------------------------------------------------------------
select throws_ok(
  $$select public.add_draft_participant('a8000000-0000-4000-8000-000000000003', 'd8000000-0000-4000-8000-000000000001', gen_random_uuid(), 'Kai', 'Lee', 'beginner')$$,
  '42501', 'NOT_A_HOST', 'a non-host cannot add a participant'
);
select throws_ok(
  $$select public.add_draft_participant('a8000000-0000-4000-8000-000000000002', 'd8000000-0000-4000-8000-000000000001', gen_random_uuid(), 'Kai', 'Lee', 'beginner')$$,
  'P0002', 'DRAFT_NOT_OPEN', 'a host of another social cannot add to the draft'
);
select throws_ok(
  $$select public.add_draft_participant('a8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000003', gen_random_uuid(), 'Kai', 'Lee', 'beginner')$$,
  'P0002', 'DRAFT_NOT_OPEN', 'a session that is no longer a draft is refused'
);
select throws_ok(
  $$select public.add_draft_participant('a8000000-0000-4000-8000-000000000001', gen_random_uuid(), gen_random_uuid(), 'Kai', 'Lee', 'beginner')$$,
  'P0002', 'DRAFT_NOT_OPEN', 'an unknown session fails clearly'
);
select throws_ok(
  $$select public.add_draft_participant('a8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001', gen_random_uuid(), 'Kai', 'Lee', null)$$,
  '22023', 'INVALID_INPUT', 'a level is required'
);
select throws_ok(
  $$select public.add_draft_participant('a8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001', gen_random_uuid(), 'Kai', '   ', 'beginner')$$,
  '22023', 'INVALID_NAME', 'a last name is required'
);
select is(
  (select count(*) from public.session_participants where session_id in
    ('d8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000003')),
  0::bigint,
  'refused calls change nothing'
);

-- Adding ---------------------------------------------------------------------------------
select is(
  public.add_draft_participant('a8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001',
    'f8000000-0000-4000-8000-000000000001', '  Kai ', ' Lee  Jr ', 'intermediate'),
  'f8000000-0000-4000-8000-000000000001'::uuid,
  'adding a participant returns the participant id the server chose'
);
select is(
  public.add_draft_participant('a8000000-0000-4000-8000-000000000004', 'd8000000-0000-4000-8000-000000000001',
    'f8000000-0000-4000-8000-000000000001', 'Kai', 'Lee Jr', 'intermediate'),
  'f8000000-0000-4000-8000-000000000001'::uuid,
  'repeating the same add (a retry, by a co-host) is accepted'
);
select results_eq(
  $$select first_name::text, last_name::text, skill_level::text
    from public.session_participants where session_id = 'd8000000-0000-4000-8000-000000000001'$$,
  $$values ('Kai'::text, 'Lee Jr'::text, 'intermediate'::text)$$,
  'a repeated add leaves one row, with trimmed names'
);
select throws_ok(
  $$select public.add_draft_participant('a8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001',
    gen_random_uuid(), 'KAI', 'lee jr', 'beginner')$$,
  'P0001', 'NAME_ALREADY_IN_SESSION', 'a second player with the same name (any case) is refused'
);
select throws_ok(
  $$select public.add_draft_participant('a8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001',
    'e8000000-0000-4000-8000-000000000001', 'Kai', 'Lee', 'beginner')$$,
  '23505', 'PARTICIPANT_ID_TAKEN', 'another session''s participant id cannot be reused'
);
select lives_ok(
  $$select public.add_draft_participant('a8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001',
    'f8000000-0000-4000-8000-000000000002', 'Kai', 'Lee Jr B', 'beginner')$$,
  'a distinguishing initial makes the name addable'
);
select lives_ok(
  $$select public.add_draft_participant('a8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001',
    'f8000000-0000-4000-8000-000000000003', 'Omar', 'Other', 'advanced')$$,
  'a name used in another social''s session is fine'
);

-- Removing (approved check-ins become withdrawn) -----------------------------------------
reset role;
insert into public.checkin_requests (session_id, social_id, first_name, last_name, skill_level, status, device_token_hash, ip_hash, decided_at, session_participant_id) values
  ('d8000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000008', 'Kai', 'Lee Jr', 'intermediate', 'approved',
   repeat('a', 64), repeat('b', 64), now(), 'f8000000-0000-4000-8000-000000000001');
set local role service_role;
select throws_ok(
  $$select public.remove_draft_participant('a8000000-0000-4000-8000-000000000002', 'f8000000-0000-4000-8000-000000000002')$$,
  'P0002', 'PARTICIPANT_NOT_FOUND', 'a host of another social cannot remove the draft''s participants'
);
select throws_ok(
  $$select public.remove_draft_participant('a8000000-0000-4000-8000-000000000001', 'e8000000-0000-4000-8000-000000000001')$$,
  'P0002', 'PARTICIPANT_NOT_FOUND', 'a participant of another social''s session is never removed'
);
select is(
  public.remove_draft_participant('a8000000-0000-4000-8000-000000000004', 'f8000000-0000-4000-8000-000000000001') ->> 'status',
  'removed',
  'a co-host removes a participant who checked in'
);
select results_eq(
  $$select status::text, session_participant_id from public.checkin_requests where session_id = 'd8000000-0000-4000-8000-000000000001'$$,
  $$values ('withdrawn'::text, null::uuid)$$,
  'the check-in that added the removed participant becomes withdrawn'
);
select is(
  public.add_draft_participant('a8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001',
    gen_random_uuid(), 'Kai', 'Lee Jr', 'intermediate') is not null,
  true,
  'the name is free again once its participant is removed'
);
select results_eq(
  $$select first_name::text || ' ' || last_name::text
    from public.session_participants where session_id = 'd8000000-0000-4000-8000-000000000001' order by 1$$,
  $$values ('Kai Lee Jr'::text), ('Kai Lee Jr B'::text), ('Omar Other'::text)$$,
  'the draft has exactly the expected players'
);
select is(
  (select count(*) from public.session_participants where id = 'e8000000-0000-4000-8000-000000000001'),
  1::bigint,
  'the other social''s draft is untouched'
);

select * from finish();
rollback;
