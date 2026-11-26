-- Reclub roster (migration 20261126090000): isolation between socials, one
-- phone per name, a player recorded as the actor of their own check-in, and
-- removing a draft participant frees their name. Transaction-only fixtures.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, email) values
  ('a1500000-0000-4000-8000-000000000001', 'roster-a@example.test'),
  ('a1500000-0000-4000-8000-000000000002', 'roster-b@example.test');
insert into public.socials (id, name, checkin_tag) values
  ('51500000-0000-4000-8000-000000000001', 'Roster A', 'rostersocial00001'),
  ('51500000-0000-4000-8000-000000000002', 'Roster B', 'rostersocial00002');
insert into public.hosts (user_id, display_name, social_id) values
  ('a1500000-0000-4000-8000-000000000001', 'Host A', '51500000-0000-4000-8000-000000000001'),
  ('a1500000-0000-4000-8000-000000000002', 'Host B', '51500000-0000-4000-8000-000000000002');
insert into public.sessions (id, social_id, host_id, name, host_name, planned_start, planned_end, config_snapshot) values
  ('d1500000-0000-4000-8000-000000000001', '51500000-0000-4000-8000-000000000001',
   'a1500000-0000-4000-8000-000000000001', 'Roster draft', 'Host A', now(), now() + interval '2 hours', '{"courts":[]}');

set local role service_role;
select is(
  public.import_roster_entries('a1500000-0000-4000-8000-000000000001', 'd1500000-0000-4000-8000-000000000001', 0,
    '[{"id":"e1500000-0000-4000-8000-000000000001","displayName":"Minh  Nguyen"},
      {"id":"e1500000-0000-4000-8000-000000000002","displayName":"Minh Nguyen"},
      {"id":"e1500000-0000-4000-8000-000000000003","displayName":"Sunny"}]'::jsonb) ->> 'status',
  'imported',
  'a host imports names'
);
select throws_ok(
  $$select public.import_roster_entries('a1500000-0000-4000-8000-000000000002', 'd1500000-0000-4000-8000-000000000001', 3,
    '[{"id":"e1500000-0000-4000-8000-000000000009","displayName":"Intruder"}]'::jsonb)$$,
  'P0002', null,
  'a host of another social cannot import into this session'
);
select is(
  (select display_name from public.session_roster_entries where id = 'e1500000-0000-4000-8000-000000000001'),
  'Minh Nguyen',
  'spaces in a pasted name are collapsed'
);

select is(
  public.claim_roster_entry('rostersocial00001', 'd1500000-0000-4000-8000-000000000001',
    'e1500000-0000-4000-8000-000000000003', repeat('a', 64), repeat('b', 64), 'beginner', 'male') ->> 'status',
  'claimed',
  'a phone claims a one-word name'
);
select is(
  (select last_name from public.session_participants p
   join public.session_roster_entries e on e.session_participant_id = p.id
   where e.id = 'e1500000-0000-4000-8000-000000000003'),
  '',
  'a one-word name has an empty last name'
);
select throws_ok(
  $$select public.claim_roster_entry('rostersocial00002', 'd1500000-0000-4000-8000-000000000001',
    'e1500000-0000-4000-8000-000000000001', repeat('c', 64), repeat('b', 64), 'beginner', 'male')$$,
  'P0001', 'SESSION_CHANGED',
  'another social''s tag cannot claim in this session'
);
reset role;
select throws_ok(
  $$update public.session_roster_entries
    set session_participant_id = (select session_participant_id from public.session_roster_entries where id = 'e1500000-0000-4000-8000-000000000003'),
        claimed_at = now(), claimed_device_token_hash = repeat('a', 64)
    where id = 'e1500000-0000-4000-8000-000000000001'$$,
  '23505', null,
  'one phone holds at most one name'
);
select throws_ok(
  $$insert into public.session_events (session_id, seq, event_id, type, payload, occurred_at)
    values ('d1500000-0000-4000-8000-000000000001', 1, gen_random_uuid(), 'Paused', '{}', now())$$,
  '23514', null,
  'every event names exactly one actor'
);

-- RLS: each social's hosts read only their own roster.
select set_config('request.jwt.claims', '{"sub":"a1500000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from public.session_roster_entries), 3::bigint, 'a host reads their social''s roster');
reset role;
select set_config('request.jwt.claims', '{"sub":"a1500000-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from public.session_roster_entries), 0::bigint, 'another social''s host reads none of it');
reset role;
set local role anon;
select throws_ok($$select count(*) from public.session_roster_entries$$, '42501', null, 'anon reads nothing');
reset role;

-- Removing a draft participant frees their roster name.
set local role service_role;
select is(
  public.remove_draft_participant('a1500000-0000-4000-8000-000000000001',
    (select session_participant_id from public.session_roster_entries where id = 'e1500000-0000-4000-8000-000000000003')) ->> 'status',
  'removed',
  'a host removes a roster-claimed draft participant'
);
select is(
  (select session_participant_id from public.session_roster_entries where id = 'e1500000-0000-4000-8000-000000000003'),
  null,
  'the name is free to claim again'
);

select * from finish();
rollback;
