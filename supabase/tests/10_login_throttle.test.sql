-- Host sign-in throttle (record_login_attempt): only service_role can use it,
-- nobody touches the table directly, and the per-IP / per-email limits hold.
begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

delete from public.login_attempts;

-- Grants ----------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.record_login_attempt(text, text, text)', 'execute'),
  'anon cannot execute record_login_attempt'
);
select ok(
  not has_function_privilege('authenticated', 'public.record_login_attempt(text, text, text)', 'execute'),
  'authenticated cannot execute record_login_attempt'
);
select ok(
  has_function_privilege('service_role', 'public.record_login_attempt(text, text, text)', 'execute'),
  'service_role can execute record_login_attempt'
);
select is(
  (select count(*) from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'login_attempts'
     and grantee in ('anon', 'authenticated', 'service_role')),
  0::bigint,
  'no API role has any privilege on login_attempts'
);

set local role service_role;
select throws_ok('select * from public.login_attempts', '42501', null, 'service_role cannot read login_attempts directly');

-- Per-email limits (one IP per call so the IP limit doesn't interfere) ----------
select is(
  (select bool_and(public.record_login_attempt('request_code', md5(n::text) || md5(n::text), repeat('e', 64)))
   from generate_series(1, 5) as n),
  true,
  'the first 5 code requests for an email are allowed'
);
select is(
  public.record_login_attempt('request_code', repeat('0', 64), repeat('e', 64)),
  false,
  'the 6th code request for an email in 10 minutes is refused'
);
select is(
  public.record_login_attempt('request_code', repeat('0', 64), repeat('f', 64)),
  true,
  'another email is not affected'
);
select is(
  (select bool_and(public.record_login_attempt('verify_code', md5(n::text) || md5('v'), repeat('e', 64)))
   from generate_series(1, 10) as n),
  true,
  'code checks have their own per-email budget of 10'
);
select is(
  public.record_login_attempt('verify_code', repeat('1', 64), repeat('e', 64)),
  false,
  'the 11th code check for an email is refused'
);

-- Per-IP limit across emails -----------------------------------------------------
select is(
  (select bool_and(public.record_login_attempt('request_code', repeat('a', 64), md5(n::text) || md5('ip')))
   from generate_series(1, 20) as n),
  true,
  'the first 20 attempts from one IP are allowed'
);
select is(
  public.record_login_attempt('verify_code', repeat('a', 64), repeat('d', 64)),
  false,
  'the 21st attempt from one IP (any kind, any email) is refused'
);

reset role;
select is(
  (select count(*) from public.login_attempts where ip_hash = repeat('a', 64)),
  20::bigint,
  'refused attempts are not recorded'
);

-- The window slides: attempts older than 10 minutes stop counting ---------------
update public.login_attempts set created_at = now() - interval '11 minutes' where ip_hash = repeat('a', 64);
set local role service_role;
select is(
  public.record_login_attempt('verify_code', repeat('a', 64), repeat('d', 64)),
  true,
  'the IP is allowed again once its attempts leave the 10-minute window'
);

-- Validation ---------------------------------------------------------------------
select throws_ok(
  $$select public.record_login_attempt('reset_password', repeat('a', 64), repeat('d', 64))$$,
  '22023', 'INVALID_LOGIN_ATTEMPT_KIND', 'an unknown kind is rejected'
);
select throws_ok(
  $$select public.record_login_attempt('request_code', 'not-a-hash', repeat('d', 64))$$,
  '23514', null, 'a malformed IP hash is rejected'
);
select throws_ok(
  $$select public.record_login_attempt('request_code', repeat('a', 64), 'someone@example.test')$$,
  '23514', null, 'a raw email (not a hash) is rejected'
);

-- Pruning ------------------------------------------------------------------------
reset role;
insert into public.login_attempts (kind, ip_hash, email_hash, created_at)
values ('request_code', repeat('9', 64), repeat('9', 64), now() - interval '2 days');
set local role service_role;
select is(
  public.record_login_attempt('request_code', repeat('8', 64), repeat('8', 64)),
  true,
  'a new attempt is recorded'
);
reset role;
select is(
  (select count(*) from public.login_attempts where created_at < now() - interval '1 day'),
  0::bigint,
  'attempts older than a day are pruned'
);

select * from finish();
rollback;
