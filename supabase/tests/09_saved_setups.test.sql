-- Saved setups (Setup "Save this setup" / "Saved setups"): save_setup and
-- apply_saved_setup.
begin;
create extension if not exists pgtap with schema extensions;
select plan(34);

insert into auth.users (id, email) values
  ('a9000000-0000-4000-8000-000000000001', 'pgtap-setups-owner@example.test'),
  ('a9000000-0000-4000-8000-000000000002', 'pgtap-setups-other@example.test'),
  ('a9000000-0000-4000-8000-000000000003', 'pgtap-setups-outsider@example.test');
insert into public.socials (id, name) values ('50000000-0000-4000-8000-000000000009', 'pgTAP Social');
insert into public.hosts (user_id, display_name, role, social_id) values
  ('a9000000-0000-4000-8000-000000000001', 'Owner Host', 'host', '50000000-0000-4000-8000-000000000009'),
  ('a9000000-0000-4000-8000-000000000002', 'Other Host', 'host', '50000000-0000-4000-8000-000000000009');
insert into public.members (social_id, id, first_name, last_name) values
  ('50000000-0000-4000-8000-000000000009', 'b9000000-0000-4000-8000-000000000001', 'Grace', 'Kim');
insert into public.sessions (id, host_id, name, location, host_name, planned_start, planned_end, status, config_snapshot) values
  ('d9000000-0000-4000-8000-000000000001', 'a9000000-0000-4000-8000-000000000001', 'Owner draft', null, 'Owner Host',
   '2026-12-05 18:00+00', '2026-12-05 20:00+00', 'draft', '{"matchFormat": "doubles", "laterStep": {"kept": true}}'),
  ('d9000000-0000-4000-8000-000000000002', 'a9000000-0000-4000-8000-000000000002', 'Other draft', null, 'Other Host',
   now(), now() + interval '2 hours', 'draft', null),
  ('d9000000-0000-4000-8000-000000000003', 'a9000000-0000-4000-8000-000000000001', 'Old one', null, 'Owner Host',
   now(), now() + interval '2 hours', 'cancelled', null);
insert into public.session_participants (id, session_id, member_id, first_name, last_name) values
  ('e9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000001', 'b9000000-0000-4000-8000-000000000001', 'Grace', 'Kim');
insert into public.saved_setups (id, host_id, name, config, last_used_at) values
  ('f9000000-0000-4000-8000-000000000002', 'a9000000-0000-4000-8000-000000000002', 'Other setup', '{}', now() - interval '30 days');

create temporary table setup_ids (label text primary key, setup_id uuid) on commit drop;
grant all on setup_ids to service_role;

-- Grants: only the server's secret key can call them.
select ok(not has_function_privilege('anon', 'public.save_setup(uuid, text, jsonb)', 'execute'),
  'anon cannot execute save_setup');
select ok(not has_function_privilege('authenticated', 'public.save_setup(uuid, text, jsonb)', 'execute'),
  'authenticated cannot execute save_setup');
select ok(has_function_privilege('service_role', 'public.save_setup(uuid, text, jsonb)', 'execute'),
  'service_role can execute save_setup');
select ok(not has_function_privilege('anon', 'public.apply_saved_setup(uuid, uuid, uuid, integer, text, integer, jsonb)', 'execute'),
  'anon cannot execute apply_saved_setup');
select ok(not has_function_privilege('authenticated', 'public.apply_saved_setup(uuid, uuid, uuid, integer, text, integer, jsonb)', 'execute'),
  'authenticated cannot execute apply_saved_setup');
select ok(has_function_privilege('service_role', 'public.apply_saved_setup(uuid, uuid, uuid, integer, text, integer, jsonb)', 'execute'),
  'service_role can execute apply_saved_setup');

set local role service_role;

-- save_setup ------------------------------------------------------------------------------
select throws_ok(
  $$select public.save_setup('a9000000-0000-4000-8000-000000000003', 'Sneaky', '{}')$$,
  '42501', 'NOT_A_HOST', 'a non-host cannot save a setup'
);
select throws_ok(
  $$select public.save_setup('a9000000-0000-4000-8000-000000000001', 'With players',
    '{"durationMinutes": 120, "participants": [{"firstName": "Grace"}]}')$$,
  '22023', 'INVALID_SETUP_CONFIG', 'attendance can never be stored in a saved setup'
);
select throws_ok(
  $$select public.save_setup('a9000000-0000-4000-8000-000000000001', 'Session ids', '{"sessionId": "d9000000-0000-4000-8000-000000000001"}')$$,
  '22023', 'INVALID_SETUP_CONFIG', 'session data can never be stored in a saved setup'
);
select throws_ok(
  $$select public.save_setup('a9000000-0000-4000-8000-000000000001', 'Not an object', '[]')$$,
  '22023', 'INVALID_SETUP_CONFIG', 'the config must be an object'
);
select throws_ok(
  $$select public.save_setup('a9000000-0000-4000-8000-000000000001', '', '{}')$$,
  '23514', null, 'an empty name breaks the short_label rule'
);

insert into setup_ids
select 'saturday', public.save_setup('a9000000-0000-4000-8000-000000000001', 'Saturday Social',
  '{"location": "Riverside", "durationMinutes": 90, "courts": [{"courtId": "c9000000-0000-4000-8000-000000000001", "name": "Court 1", "format": "doubles"}],
    "matchFormat": "doubles", "targetMatchMinutes": 12, "changeoverMinutes": 3,
    "rotation": {"objectiveOrder": ["shortestWaits"], "rules": {"mixPartners": false}}}');
select isnt((select setup_id from setup_ids where label = 'saturday'), null, 'save_setup returns the new setup''s id');
select is(
  (select config from public.saved_setups where id = (select setup_id from setup_ids where label = 'saturday')),
  '{"location": "Riverside", "durationMinutes": 90, "courts": [{"courtId": "c9000000-0000-4000-8000-000000000001", "name": "Court 1", "format": "doubles"}],
    "matchFormat": "doubles", "targetMatchMinutes": 12, "changeoverMinutes": 3,
    "rotation": {"objectiveOrder": ["shortestWaits"], "rules": {"mixPartners": false}}}'::jsonb,
  'the config is stored as given (no attendance)'
);

-- Saving again under the same name, ignoring case, replaces it.
update public.saved_setups set last_used_at = now() - interval '10 days'
where id = (select setup_id from setup_ids where label = 'saturday');
select is(
  public.save_setup('a9000000-0000-4000-8000-000000000001', 'saturday social', '{"durationMinutes": 60}'),
  (select setup_id from setup_ids where label = 'saturday'),
  'saving "saturday social" replaces "Saturday Social" (same id)'
);
select results_eq(
  $$select name::text, config, last_used_at > now() - interval '1 minute'
    from public.saved_setups where host_id = 'a9000000-0000-4000-8000-000000000001'$$,
  $$values ('saturday social', '{"durationMinutes": 60}'::jsonb, true)$$,
  'the replaced setup takes the new name, config and last used time; there is still one'
);
select isnt(
  public.save_setup('a9000000-0000-4000-8000-000000000002', 'Saturday Social', '{}'),
  (select setup_id from setup_ids where label = 'saturday'),
  'another host''s setup with the same name is a separate setup'
);
select is(
  (select count(*) from public.saved_setups where lower(name) = 'saturday social'),
  2::bigint,
  'each host keeps their own'
);

-- apply_saved_setup -----------------------------------------------------------------------
select throws_ok(
  $$select public.apply_saved_setup('a9000000-0000-4000-8000-000000000003', 'd9000000-0000-4000-8000-000000000001',
    (select setup_id from setup_ids where label = 'saturday'), 0, '', 90, '{}')$$,
  '42501', 'NOT_A_HOST', 'a non-host cannot apply a setup'
);
select throws_ok(
  $$select public.apply_saved_setup('a9000000-0000-4000-8000-000000000002', 'd9000000-0000-4000-8000-000000000001',
    'f9000000-0000-4000-8000-000000000002', 0, '', 90, '{}')$$,
  'P0002', 'DRAFT_NOT_OPEN', 'a host cannot apply a setup to someone else''s draft'
);
select throws_ok(
  $$select public.apply_saved_setup('a9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000001',
    'f9000000-0000-4000-8000-000000000002', 0, '', 90, '{}')$$,
  'P0002', 'SAVED_SETUP_NOT_FOUND', 'a host cannot apply another host''s setup'
);
select throws_ok(
  $$select public.apply_saved_setup('a9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000003',
    (select setup_id from setup_ids where label = 'saturday'), 0, '', 90, '{}')$$,
  'P0002', 'DRAFT_NOT_OPEN', 'a session that is no longer a draft is refused'
);
select throws_ok(
  $$select public.apply_saved_setup('a9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000001',
    (select setup_id from setup_ids where label = 'saturday'), 0, '', 721, '{}')$$,
  '22023', 'INVALID_DURATION', 'a duration over 12 hours is refused'
);

update public.saved_setups set last_used_at = now() - interval '10 days'
where id = (select setup_id from setup_ids where label = 'saturday');
select lives_ok(
  $$select public.apply_saved_setup('a9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000001',
    (select setup_id from setup_ids where label = 'saturday'), 0, 'Riverside', 90,
    '{"matchFormat": "singles", "targetMatchMinutes": 12, "rotation": {"objectiveOrder": ["shortestWaits"]}}')$$,
  'the owner applies their own setup to their own draft'
);
select results_eq(
  $$select name::text, location, planned_start, planned_end from public.sessions where id = 'd9000000-0000-4000-8000-000000000001'$$,
  $$values ('Owner draft', 'Riverside', '2026-12-05 18:00+00'::timestamptz, '2026-12-05 19:30+00'::timestamptz)$$,
  'apply sets the location and end = start + duration; name and start stay'
);
select is(
  (select config_snapshot from public.sessions where id = 'd9000000-0000-4000-8000-000000000001'),
  '{"matchFormat": "singles", "targetMatchMinutes": 12, "rotation": {"objectiveOrder": ["shortestWaits"]}, "laterStep": {"kept": true}}'::jsonb,
  'apply merges the patch into the draft config and keeps other keys'
);
select ok(
  (select last_used_at > now() - interval '1 minute' from public.saved_setups
   where id = (select setup_id from setup_ids where label = 'saturday')),
  'apply marks the setup as just used'
);
select is(
  (select array_agg(id) from public.session_participants where session_id = 'd9000000-0000-4000-8000-000000000001'),
  array['e9000000-0000-4000-8000-000000000001'::uuid],
  'apply never touches attendance'
);
select is(
  (select draft_revision from public.sessions where id = 'd9000000-0000-4000-8000-000000000001'),
  1,
  'apply bumps the draft''s settings revision'
);
select throws_ok(
  $$select public.apply_saved_setup('a9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000001',
    (select setup_id from setup_ids where label = 'saturday'), 0, 'Elsewhere', 60, '{}')$$,
  'P0409', 'DRAFT_CHANGED_ELSEWHERE', 'apply based on an older revision is refused'
);
select results_eq(
  $$select location, draft_revision, planned_end, config_snapshot from public.sessions where id = 'd9000000-0000-4000-8000-000000000001'$$,
  $$values ('Riverside'::text, 1, '2026-12-05 19:30+00'::timestamptz,
    '{"matchFormat": "singles", "targetMatchMinutes": 12, "rotation": {"objectiveOrder": ["shortestWaits"]}, "laterStep": {"kept": true}}'::jsonb)$$,
  'the refused stale apply changed nothing (location, revision, end, config)'
);
select is(
  (select config from public.saved_setups where id = (select setup_id from setup_ids where label = 'saturday')),
  '{"durationMinutes": 60}'::jsonb,
  'applying never changes the saved setup''s config'
);

reset role;

-- RLS: a host reads only their own setups ----------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"a9000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;
select is(
  (select count(*) from public.saved_setups where host_id = 'a9000000-0000-4000-8000-000000000001'),
  0::bigint,
  'another host sees none of the owner''s setups'
);
select is(
  (select array_agg(name::text order by name) from public.saved_setups),
  array['Other setup', 'Saturday Social'],
  'a host sees exactly their own two setups'
);
reset role;
select set_config('request.jwt.claims', '{"sub":"a9000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select results_eq(
  $$select name::text from public.saved_setups$$,
  $$values ('saturday social')$$,
  'the owner sees their own setup'
);
reset role;
select * from finish();
rollback;
