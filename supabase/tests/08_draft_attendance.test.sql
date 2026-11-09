-- Draft attendance (Setup "Who's playing?"): set_draft_member_attendance,
-- add_draft_guest and remove_draft_guest.
begin;
create extension if not exists pgtap with schema extensions;
select plan(37);

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
insert into public.members (social_id, id, first_name, last_name, skill_level, is_active) values
  ('50000000-0000-4000-8000-000000000008', 'b8000000-0000-4000-8000-000000000001', 'Grace', 'Kim', 'advanced', true),
  ('50000000-0000-4000-8000-000000000008', 'b8000000-0000-4000-8000-000000000002', 'Kofi', 'Mensah', null, true),
  ('50000000-0000-4000-8000-000000000008', 'b8000000-0000-4000-8000-000000000003', 'Ina', 'Inactive', 'beginner', false),
  ('50000000-0000-4000-8000-000000000018', 'b8000000-0000-4000-8000-000000000004', 'Omar', 'Other', 'beginner', true);
insert into public.sessions (id, social_id, host_id, name, host_name, planned_start, planned_end, status) values
  ('d8000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000008', 'a8000000-0000-4000-8000-000000000001', 'Owner draft', 'Owner Host',
   now(), now() + interval '2 hours', 'draft'),
  ('d8000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000018', 'a8000000-0000-4000-8000-000000000002', 'Other draft', 'Other Host',
   now(), now() + interval '2 hours', 'draft'),
  -- The social's earlier session, no longer a draft.
  ('d8000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000008', 'a8000000-0000-4000-8000-000000000001', 'Old one', 'Owner Host',
   now(), now() + interval '2 hours', 'cancelled');
-- The other social's attendee, which nothing here may touch.
insert into public.session_participants (id, session_id, social_id, member_id, first_name, last_name) values
  ('e8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000018', 'b8000000-0000-4000-8000-000000000004', 'Omar', 'Other');

-- Grants: only the server's secret key can call them.
select ok(not has_function_privilege('anon', 'public.set_draft_member_attendance(uuid, uuid, uuid[], boolean)', 'execute'),
  'anon cannot execute set_draft_member_attendance');
select ok(not has_function_privilege('authenticated', 'public.set_draft_member_attendance(uuid, uuid, uuid[], boolean)', 'execute'),
  'authenticated cannot execute set_draft_member_attendance');
select ok(has_function_privilege('service_role', 'public.set_draft_member_attendance(uuid, uuid, uuid[], boolean)', 'execute'),
  'service_role can execute set_draft_member_attendance');
select ok(not has_function_privilege('anon', 'public.add_draft_guest(uuid, uuid, uuid, text, text, public.skill_level)', 'execute'),
  'anon cannot execute add_draft_guest');
select ok(not has_function_privilege('authenticated', 'public.add_draft_guest(uuid, uuid, uuid, text, text, public.skill_level)', 'execute'),
  'authenticated cannot execute add_draft_guest');
select ok(has_function_privilege('service_role', 'public.add_draft_guest(uuid, uuid, uuid, text, text, public.skill_level)', 'execute'),
  'service_role can execute add_draft_guest');
select ok(not has_function_privilege('anon', 'public.remove_draft_guest(uuid, uuid, uuid)', 'execute'),
  'anon cannot execute remove_draft_guest');
select ok(not has_function_privilege('authenticated', 'public.remove_draft_guest(uuid, uuid, uuid)', 'execute'),
  'authenticated cannot execute remove_draft_guest');
select ok(has_function_privilege('service_role', 'public.remove_draft_guest(uuid, uuid, uuid)', 'execute'),
  'service_role can execute remove_draft_guest');

set local role service_role;

-- Refusals -----------------------------------------------------------------------------
select throws_ok(
  $$select public.set_draft_member_attendance('a8000000-0000-4000-8000-000000000003', 'd8000000-0000-4000-8000-000000000001',
    array['b8000000-0000-4000-8000-000000000001']::uuid[], true)$$,
  '42501', 'NOT_A_HOST', 'a non-host cannot change attendance'
);
select throws_ok(
  $$select public.set_draft_member_attendance('a8000000-0000-4000-8000-000000000002', 'd8000000-0000-4000-8000-000000000001',
    array['b8000000-0000-4000-8000-000000000001']::uuid[], true)$$,
  'P0002', 'DRAFT_NOT_OPEN', 'a host of another social cannot change the draft''s attendance'
);
select throws_ok(
  $$select public.add_draft_guest('a8000000-0000-4000-8000-000000000002', 'd8000000-0000-4000-8000-000000000001', gen_random_uuid(), 'Kai', 'Lee', null)$$,
  'P0002', 'DRAFT_NOT_OPEN', 'a host of another social cannot add a guest to the draft'
);
select throws_ok(
  $$select public.remove_draft_guest('a8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000002',
    'e8000000-0000-4000-8000-000000000001')$$,
  'P0002', 'DRAFT_NOT_OPEN', 'a host cannot remove anyone from another social''s draft'
);
select throws_ok(
  $$select public.set_draft_member_attendance('a8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000003',
    array['b8000000-0000-4000-8000-000000000001']::uuid[], true)$$,
  'P0002', 'DRAFT_NOT_OPEN', 'a session that is no longer a draft is refused'
);
select throws_ok(
  $$select public.add_draft_guest('a8000000-0000-4000-8000-000000000001', gen_random_uuid(), gen_random_uuid(), 'Kai', 'Lee', null)$$,
  'P0002', 'DRAFT_NOT_OPEN', 'an unknown session fails clearly'
);
select is(
  (select count(*) from public.session_participants where session_id in
    ('d8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000003')),
  0::bigint,
  'refused calls change nothing'
);

-- Members --------------------------------------------------------------------------------
select is(
  public.set_draft_member_attendance('a8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001',
    array['b8000000-0000-4000-8000-000000000001', 'b8000000-0000-4000-8000-000000000002',
          'b8000000-0000-4000-8000-000000000003', 'b8000000-0000-4000-8000-000000000001', gen_random_uuid()]::uuid[], true) ->> 'status',
  'saved',
  'the owner marks members as attending'
);
select results_eq(
  $$select member_id, is_guest, first_name::text, last_name::text, skill_level::text
    from public.session_participants where session_id = 'd8000000-0000-4000-8000-000000000001' order by first_name$$,
  $$values ('b8000000-0000-4000-8000-000000000001'::uuid, false, 'Grace'::text, 'Kim'::text, 'advanced'::text),
           ('b8000000-0000-4000-8000-000000000002'::uuid, false, 'Kofi'::text, 'Mensah'::text, null::text)$$,
  'active members get one snapshot row each; inactive, unknown and repeated ids are skipped'
);
create temporary table first_rows on commit drop as
  select id, member_id from public.session_participants where session_id = 'd8000000-0000-4000-8000-000000000001';
select lives_ok(
  $$select public.set_draft_member_attendance('a8000000-0000-4000-8000-000000000004', 'd8000000-0000-4000-8000-000000000001',
    array['b8000000-0000-4000-8000-000000000001', 'b8000000-0000-4000-8000-000000000002']::uuid[], true)$$,
  'a co-host marks the same members again on the social''s draft (co-editing, a retry)'
);
select set_eq(
  $$select id, member_id from public.session_participants where session_id = 'd8000000-0000-4000-8000-000000000001'$$,
  $$select id, member_id from first_rows$$,
  'repeating it keeps the same rows (idempotent)'
);

-- Guests -----------------------------------------------------------------------------------
select is(
  public.add_draft_guest('a8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001',
    'f8000000-0000-4000-8000-000000000001', '  Kai ', ' Lee  Jr ', 'intermediate'),
  'f8000000-0000-4000-8000-000000000001'::uuid,
  'adding a guest returns the participant id the server chose'
);
select is(
  public.add_draft_guest('a8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001',
    'f8000000-0000-4000-8000-000000000001', 'Kai', 'Lee Jr', 'intermediate'),
  'f8000000-0000-4000-8000-000000000001'::uuid,
  'repeating the same add (a retry) is accepted'
);
select is(
  (select count(*) from public.session_participants where id = 'f8000000-0000-4000-8000-000000000001'),
  1::bigint,
  'a repeated add leaves one row'
);
select throws_ok(
  $$select public.add_draft_guest('a8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001',
    (select id from public.session_participants
     where session_id = 'd8000000-0000-4000-8000-000000000001' and member_id = 'b8000000-0000-4000-8000-000000000001'),
    'Kai', 'Lee', null)$$,
  '23505', 'PARTICIPANT_ID_TAKEN', 'a member''s participant id cannot be reused for a guest'
);
select throws_ok(
  $$select public.add_draft_guest('a8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001',
    'e8000000-0000-4000-8000-000000000001', 'Kai', 'Lee', null)$$,
  '23505', 'PARTICIPANT_ID_TAKEN', 'another session''s participant id cannot be reused'
);
select lives_ok(
  $$select public.add_draft_guest('a8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001',
    gen_random_uuid(), 'Kai', 'Lee Jr', null)$$,
  'a second guest with the same name is allowed'
);
select results_eq(
  $$select member_id, first_name::text, last_name::text, skill_level::text
    from public.session_participants
    where session_id = 'd8000000-0000-4000-8000-000000000001' and is_guest order by skill_level nulls last$$,
  $$values (null::uuid, 'Kai'::text, 'Lee Jr'::text, 'intermediate'::text),
           (null::uuid, 'Kai'::text, 'Lee Jr'::text, null::text)$$,
  'guests have no member and their names are trimmed'
);
select throws_ok(
  $$select public.add_draft_guest('a8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001', gen_random_uuid(), 'Kai', '   ', null)$$,
  '22023', 'INVALID_NAME', 'a guest needs a last name'
);
select is(
  public.remove_draft_guest('a8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001',
    (select id from public.session_participants
     where session_id = 'd8000000-0000-4000-8000-000000000001' and member_id = 'b8000000-0000-4000-8000-000000000001')) ->> 'status',
  'not_found',
  'remove_draft_guest never removes a member'
);
select is(
  public.remove_draft_guest('a8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001',
    (select id from public.session_participants
     where session_id = 'd8000000-0000-4000-8000-000000000001' and is_guest and skill_level is null)) ->> 'status',
  'removed',
  'the owner removes a guest'
);
select results_eq(
  $$select coalesce(member_id::text, 'guest ' || skill_level::text)
    from public.session_participants where session_id = 'd8000000-0000-4000-8000-000000000001' order by 1$$,
  $$values ('b8000000-0000-4000-8000-000000000001'::text), ('b8000000-0000-4000-8000-000000000002'::text), ('guest intermediate'::text)$$,
  'removing a guest leaves the members and the other guest'
);
select is(
  public.remove_draft_guest('a8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001',
    'e8000000-0000-4000-8000-000000000001') ->> 'status',
  'not_found',
  'a participant of another session is never removed'
);

-- Clear: every attending member, after one was approved from a check-in ---------------------
reset role;
insert into public.checkin_requests (session_id, social_id, member_id, first_name, last_name, status, device_token_hash, ip_hash, decided_at, session_participant_id)
select 'd8000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000008', 'b8000000-0000-4000-8000-000000000001', 'Grace', 'Kim', 'approved',
       repeat('a', 64), repeat('b', 64), now(), id
from public.session_participants
where session_id = 'd8000000-0000-4000-8000-000000000001' and member_id = 'b8000000-0000-4000-8000-000000000001';
set local role service_role;

select lives_ok(
  $$select public.set_draft_member_attendance('a8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001',
    array['b8000000-0000-4000-8000-000000000001', 'b8000000-0000-4000-8000-000000000002']::uuid[], false)$$,
  'Clear removes every attending member'
);
select results_eq(
  $$select is_guest, first_name::text from public.session_participants where session_id = 'd8000000-0000-4000-8000-000000000001'$$,
  $$values (true, 'Kai'::text)$$,
  'Clear leaves the guests'
);
select results_eq(
  $$select status::text, session_participant_id from public.checkin_requests where session_id = 'd8000000-0000-4000-8000-000000000001'$$,
  $$values ('withdrawn'::text, null::uuid)$$,
  'a check-in that added a removed member becomes withdrawn'
);
select lives_ok(
  $$select public.set_draft_member_attendance('a8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001',
    array['b8000000-0000-4000-8000-000000000001']::uuid[], false)$$,
  'removing a member who is not attending is fine'
);
select is(
  (select count(*) from public.session_participants where id = 'e8000000-0000-4000-8000-000000000001'),
  1::bigint,
  'the other social''s draft is untouched'
);

select * from finish();
rollback;
