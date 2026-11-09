-- save_session_draft (Setup screen autosave, with the settings revision) and
-- case-insensitive court names.
begin;
create extension if not exists pgtap with schema extensions;
select plan(23);

insert into auth.users (id, email) values
  ('a7000000-0000-4000-8000-000000000001', 'pgtap-draft-owner@example.test'),
  ('a7000000-0000-4000-8000-000000000002', 'pgtap-draft-other@example.test'),
  ('a7000000-0000-4000-8000-000000000003', 'pgtap-draft-outsider@example.test');
insert into public.socials (id, name) values ('50000000-0000-4000-8000-000000000007', 'pgTAP Social');
insert into public.hosts (user_id, display_name, role, social_id) values
  ('a7000000-0000-4000-8000-000000000001', 'Owner Host', 'host', '50000000-0000-4000-8000-000000000007'),
  ('a7000000-0000-4000-8000-000000000002', 'Other Host', 'host', '50000000-0000-4000-8000-000000000007');
insert into public.members (id, first_name, last_name) values
  ('b7000000-0000-4000-8000-000000000001', 'Grace', 'Kim');
insert into public.sessions (id, host_id, name, host_name, planned_start, planned_end, status, started_at, config_snapshot) values
  -- The owner's draft, with a key another setup step owns.
  ('d7000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', 'Draft', 'Owner Host',
   now(), now() + interval '2 hours', 'draft', null, '{"rotation":{"objectiveOrder":["equalGames"]},"targetMatchMinutes":15}'),
  -- The other host's draft, with no snapshot yet.
  ('d7000000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-000000000002', 'Other draft', 'Other Host',
   now(), now() + interval '2 hours', 'draft', null, null);
-- The owner's earlier session that is live (another host's live one would also do).
insert into public.sessions (id, host_id, name, host_name, planned_start, planned_end, status, started_at) values
  ('d7000000-0000-4000-8000-000000000003', null, 'Live one', 'Owner Host',
   now(), now() + interval '2 hours', 'live', now());

-- Grants: only the server's secret key can call it.
select ok(
  not has_function_privilege('anon', 'public.save_session_draft(uuid, uuid, integer, text, text, text, timestamptz, timestamptz, jsonb)', 'execute'),
  'anon cannot execute save_session_draft'
);
select ok(
  not has_function_privilege('authenticated', 'public.save_session_draft(uuid, uuid, integer, text, text, text, timestamptz, timestamptz, jsonb)', 'execute'),
  'authenticated cannot execute save_session_draft'
);
select ok(
  has_function_privilege('service_role', 'public.save_session_draft(uuid, uuid, integer, text, text, text, timestamptz, timestamptz, jsonb)', 'execute'),
  'service_role can execute save_session_draft'
);

set local role service_role;

select throws_ok(
  $$select public.save_session_draft('a7000000-0000-4000-8000-000000000003', 'd7000000-0000-4000-8000-000000000001', 0,
    'Hijack', '', 'X', now(), now() + interval '1 hour', '{}')$$,
  '42501', 'NOT_A_HOST', 'a non-host cannot save a draft'
);
select throws_ok(
  $$select public.save_session_draft('a7000000-0000-4000-8000-000000000002', 'd7000000-0000-4000-8000-000000000001', 0,
    'Hijack', '', 'X', now(), now() + interval '1 hour', '{"courts":[]}')$$,
  'P0002', 'DRAFT_NOT_OPEN', 'another host cannot save someone else''s draft'
);
select throws_ok(
  $$select public.save_session_draft('a7000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000003', 0,
    'Hijack', '', 'X', now(), now() + interval '1 hour', '{}')$$,
  'P0002', 'DRAFT_NOT_OPEN', 'a session that is not a draft cannot be saved'
);
select throws_ok(
  $$select public.save_session_draft('a7000000-0000-4000-8000-000000000001', gen_random_uuid(), 0,
    'Ghost', '', 'X', now(), now() + interval '1 hour', '{}')$$,
  'P0002', 'DRAFT_NOT_OPEN', 'an unknown session fails clearly'
);
select throws_ok(
  $$select public.save_session_draft('a7000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000001', 0,
    'Draft', '', 'X', now(), now() + interval '1 hour', '[1]')$$,
  '22023', 'INVALID_CONFIG_PATCH', 'the config patch must be an object'
);
select results_eq(
  $$select name::text, config_snapshot from public.sessions where id = 'd7000000-0000-4000-8000-000000000001'$$,
  $$values ('Draft'::text, '{"rotation":{"objectiveOrder":["equalGames"]},"targetMatchMinutes":15}'::jsonb)$$,
  'refused saves change nothing'
);

select is(
  public.save_session_draft('a7000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000001', 0,
    'Saturday social', 'Riverside', 'Owner H.', '2026-11-07 18:00+00', '2026-11-07 20:00+00',
    '{"courts":[{"courtId":"c7000000-0000-4000-8000-000000000001","name":"Court 1","format":"doubles"}],"matchFormat":"doubles","targetMatchMinutes":12,"changeoverMinutes":3}') ->> 'status',
  'saved',
  'the owner saves their draft'
);
select is(
  (select draft_revision from public.sessions where id = 'd7000000-0000-4000-8000-000000000001'),
  1,
  'a save bumps the settings revision'
);
select results_eq(
  $$select name::text, location, host_name::text, planned_start, planned_end, config_snapshot
    from public.sessions where id = 'd7000000-0000-4000-8000-000000000001'$$,
  $$values ('Saturday social'::text, 'Riverside'::text, 'Owner H.'::text,
            '2026-11-07 18:00+00'::timestamptz, '2026-11-07 20:00+00'::timestamptz,
            '{"rotation":{"objectiveOrder":["equalGames"]},"courts":[{"courtId":"c7000000-0000-4000-8000-000000000001","name":"Court 1","format":"doubles"}],"matchFormat":"doubles","targetMatchMinutes":12,"changeoverMinutes":3}'::jsonb)$$,
  'scalar columns are written and the patch merges, keeping keys other steps own'
);
select lives_ok(
  $$select public.save_session_draft('a7000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000001', 1,
    'Saturday social', '', 'Owner H.', '2026-11-07 18:00+00', '2026-11-07 20:00+00', '{}')$$,
  'an empty patch is allowed'
);
select is(
  (select location from public.sessions where id = 'd7000000-0000-4000-8000-000000000001'),
  null,
  'an empty location is stored as none'
);
select is(
  public.save_session_draft('a7000000-0000-4000-8000-000000000002', 'd7000000-0000-4000-8000-000000000002', 0,
    'Other draft', '', 'Other Host', now(), now() + interval '1 hour', '{"matchFormat":"singles"}') ->> 'status',
  'saved',
  'a draft without a snapshot starts from an empty object'
);
select throws_ok(
  $$select public.save_session_draft('a7000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000001', 2,
    'Saturday social', '', 'Owner H.', '2026-11-07 20:00+00', '2026-11-07 18:00+00', '{}')$$,
  '23514', null, 'the planned end must stay after the start'
);

-- Optimistic concurrency: a save based on an old revision is refused.
select is(
  public.save_session_draft('a7000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000001', 2,
    'Newest', '', 'Owner H.', '2026-11-07 18:00+00', '2026-11-07 20:00+00', '{}') ->> 'draftRevision',
  '3',
  'a save at the current revision returns the new one'
);
select throws_ok(
  $$select public.save_session_draft('a7000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000001', 2,
    'Stale tab', '', 'Owner H.', '2026-11-07 18:00+00', '2026-11-07 20:00+00', '{"targetMatchMinutes":99}')$$,
  'P0409', 'DRAFT_CHANGED_ELSEWHERE', 'a save based on an older revision is refused'
);
select results_eq(
  $$select name::text, draft_revision, config_snapshot ->> 'targetMatchMinutes' from public.sessions where id = 'd7000000-0000-4000-8000-000000000001'$$,
  $$values ('Newest'::text, 3, '12'::text)$$,
  'the refused stale save changed nothing'
);
-- Attendance is reconciled separately: it never bumps the settings revision.
select lives_ok(
  $$select public.set_draft_member_attendance('a7000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000001',
    array['b7000000-0000-4000-8000-000000000001']::uuid[], true)$$,
  'attendance changes on the same draft'
);
select is(
  (select draft_revision from public.sessions where id = 'd7000000-0000-4000-8000-000000000001'),
  3,
  'attendance does not bump the settings revision'
);

-- Court names are unique whatever their case.
insert into public.courts (name) values ('Pgtap Court Zeta');
select throws_ok(
  $$insert into public.courts (name) values ('pgtap court ZETA')$$,
  '23505', null, 'a court name differing only by case is refused'
);
select lives_ok(
  $$insert into public.courts (name) values ('Pgtap Court Eta')$$,
  'a different court name is fine'
);

select * from finish();
rollback;
