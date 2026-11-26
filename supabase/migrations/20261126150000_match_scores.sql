-- Scores after a game (docs/plans/reclub-to-court-v1.md, Phase 3; D8).
--
-- One score per finished game: two whole numbers 0-99, no ties, in the
-- orientation of matches.team_a / team_b. Any of the four players or a host
-- can enter it after the game is finished; it is optional and never holds a
-- court. The first score stands: the same score again is fine, a different
-- one is refused as "already recorded", and only a host can correct it.
-- Undoing the finish voids the score (kept for the record); a later finish
-- asks again. Scores live outside the session log, so a score never
-- conflicts with court turnover.
--
-- Additive: a new table, a trigger on matches and new functions.
-- Rollback: revert the app, drop the functions, trigger and table.

create table public.match_scores (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches (id),
  session_id uuid not null,
  social_id uuid not null,
  score_team_a integer not null check (score_team_a between 0 and 99),
  score_team_b integer not null check (score_team_b between 0 and 99),
  -- Exactly one of a host or a player entered it.
  entered_by_user_id uuid references auth.users (id) on delete set null,
  entered_by_participant_id uuid references public.session_participants (id),
  entered_at timestamptz not null default now(),
  corrected_by_user_id uuid references auth.users (id) on delete set null,
  corrected_at timestamptz,
  voided_at timestamptz,
  constraint match_scores_no_tie check (score_team_a <> score_team_b),
  constraint match_scores_session_social_fkey
    foreign key (session_id, social_id) references public.sessions (id, social_id)
);
-- One standing score per game.
create unique index match_scores_one_per_match_idx
  on public.match_scores (match_id) where voided_at is null;
create index match_scores_session_idx on public.match_scores (session_id);
create index match_scores_social_id_idx on public.match_scores (social_id);
create index match_scores_entered_by_user_idx on public.match_scores (entered_by_user_id);
create index match_scores_entered_by_participant_idx on public.match_scores (entered_by_participant_id);
create index match_scores_corrected_by_user_idx on public.match_scores (corrected_by_user_id);

alter table public.match_scores enable row level security;
create policy match_scores_select_own_social on public.match_scores
  for select to authenticated using (social_id = (select private.current_social_id()));
grant select on public.match_scores to authenticated;

create trigger match_scores_reject_social_id_change
  before update of social_id on public.match_scores
  for each row
  when (old.social_id is distinct from new.social_id)
  execute function private.reject_social_id_change();

-- Undoing a finish (the matches row turns 'reverted') voids its score.
create function private.void_score_of_reverted_match()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'reverted' and old.status is distinct from 'reverted' then
    update public.match_scores set voided_at = now()
    where match_id = new.id and voided_at is null;
  end if;
  return new;
end;
$$;
create trigger matches_void_score_when_reverted
  after update of status on public.matches
  for each row execute function private.void_score_of_reverted_match();

-- The finished game a score is for, checked for this session.
create function private.require_finished_match(p_session_id uuid, p_match_id uuid)
returns public.matches
language plpgsql
set search_path = ''
as $$
declare
  v_match public.matches;
begin
  select * into v_match from public.matches
  where id = p_match_id and session_id = p_session_id
  for update;
  if not found or v_match.status <> 'completed' then
    raise exception 'MATCH_NOT_FINISHED' using errcode = 'P0001',
      detail = 'Scores are for finished games only.';
  end if;
  return v_match;
end;
$$;

create function private.require_valid_score(p_score_team_a integer, p_score_team_b integer)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_score_team_a is null or p_score_team_b is null
    or p_score_team_a not between 0 and 99 or p_score_team_b not between 0 and 99
    or p_score_team_a = p_score_team_b then
    raise exception 'INVALID_SCORE' using errcode = '22023',
      detail = 'Two whole numbers from 0 to 99, not a tie.';
  end if;
end;
$$;

-- A player in the game's final lineup enters its score from their phone.
-- Outcomes: recorded / already_same / already_recorded (with the score).
create function public.submit_player_score(
  p_checkin_tag text,
  p_expected_session_id uuid,
  p_device_token_hash text,
  p_ip_hash text,
  p_match_id uuid,
  p_score_team_a integer,
  p_score_team_b integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.sessions;
  v_participant_id uuid;
  v_match public.matches;
  v_existing public.match_scores;
begin
  perform private.require_valid_client_identity(p_device_token_hash, p_ip_hash);
  perform private.require_valid_score(p_score_team_a, p_score_team_b);
  v_session := private.lock_checkin_session(p_checkin_tag, p_expected_session_id);
  perform private.record_checkin_attempt('claim', v_session.id, p_device_token_hash, p_ip_hash, 20, 400, 800);
  v_participant_id := public.get_checkin_participant(p_checkin_tag, v_session.id, p_device_token_hash);
  v_match := private.require_finished_match(v_session.id, p_match_id);
  if v_participant_id is null or not (v_participant_id = any(v_match.team_a || v_match.team_b)) then
    raise exception 'NOT_IN_MATCH' using errcode = '42501',
      detail = 'Only the players of the game can enter its score.';
  end if;
  select * into v_existing from public.match_scores
  where match_id = p_match_id and voided_at is null;
  if found then
    return jsonb_build_object(
      'status', case when v_existing.score_team_a = p_score_team_a and v_existing.score_team_b = p_score_team_b
        then 'already_same' else 'already_recorded' end,
      'score_team_a', v_existing.score_team_a,
      'score_team_b', v_existing.score_team_b
    );
  end if;
  insert into public.match_scores (match_id, session_id, social_id, score_team_a, score_team_b, entered_by_participant_id)
  values (p_match_id, v_session.id, v_session.social_id, p_score_team_a, p_score_team_b, v_participant_id);
  return jsonb_build_object('status', 'recorded', 'score_team_a', p_score_team_a, 'score_team_b', p_score_team_b);
end;
$$;

-- A host enters a score, or corrects the one recorded (any host of the social).
create function public.host_set_match_score(
  p_actor_user_id uuid,
  p_match_id uuid,
  p_score_team_a integer,
  p_score_team_b integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_social_id uuid := private.require_host_social(p_actor_user_id);
  v_session_id uuid;
  v_match public.matches;
  v_existing public.match_scores;
begin
  perform private.require_valid_score(p_score_team_a, p_score_team_b);
  select match.session_id into v_session_id
  from public.matches as match
  join public.sessions as session on session.id = match.session_id
  where match.id = p_match_id and session.social_id = v_social_id;
  if not found then
    raise exception 'MATCH_NOT_FINISHED' using errcode = 'P0001';
  end if;
  perform private.lock_social_session(v_social_id, v_session_id);
  v_match := private.require_finished_match(v_session_id, p_match_id);
  select * into v_existing from public.match_scores
  where match_id = v_match.id and voided_at is null
  for update;
  if found then
    if v_existing.score_team_a = p_score_team_a and v_existing.score_team_b = p_score_team_b then
      return jsonb_build_object('status', 'already_same');
    end if;
    update public.match_scores
    set score_team_a = p_score_team_a, score_team_b = p_score_team_b,
        corrected_by_user_id = p_actor_user_id, corrected_at = now()
    where id = v_existing.id;
    return jsonb_build_object('status', 'corrected');
  end if;
  insert into public.match_scores (match_id, session_id, social_id, score_team_a, score_team_b, entered_by_user_id)
  values (v_match.id, v_session_id, v_social_id, p_score_team_a, p_score_team_b, p_actor_user_id);
  return jsonb_build_object('status', 'recorded');
end;
$$;

revoke all on function public.submit_player_score(text, uuid, text, text, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.submit_player_score(text, uuid, text, text, uuid, integer, integer) to service_role;
revoke all on function public.host_set_match_score(uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.host_set_match_score(uuid, uuid, integer, integer) to service_role;
revoke all on function private.require_finished_match(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.require_valid_score(integer, integer) from public, anon, authenticated, service_role;
revoke all on function private.void_score_of_reverted_match() from public, anon, authenticated, service_role;
