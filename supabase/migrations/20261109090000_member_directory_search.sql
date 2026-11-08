-- Members directory search (M4, /members): case- and accent-insensitive
-- "contains" search on a member's name.
--
-- `search_name` is the full name ("first last") lowercased, decomposed (NFD)
-- with combining marks removed and whitespace collapsed, e.g. 'Élodie  Durand'
-- -> 'elodie durand'. The server normalises the search text the same way
-- (src/server/members/memberSearch.ts) and filters with
-- `search_name LIKE '%<escaped text>%'`, so "elo", "durand" and "elodie d" all
-- match. Only built-in immutable functions are used, so no extension is needed
-- and the column stays correct whoever writes the row (server, check-in
-- functions, seed).
--
-- No index: a "contains" pattern can't use a b-tree, and a sequential scan
-- over a club's members (hundreds to a few thousand rows) takes well under a
-- millisecond. Add a pg_trgm GIN index here only if directories grow far
-- beyond that.
--
-- Reads keep going through RLS: `authenticated` already has table-level
-- SELECT on members (hosts only, via members_select_hosts), which covers the
-- new column. Nobody can write a generated column directly.

alter table public.members
  add column search_name text not null
    generated always as (
      regexp_replace(
        regexp_replace(normalize(lower(first_name || ' ' || last_name), NFD), '[̀-ͯ]', '', 'g'),
        '\s+', ' ', 'g'
      )
    ) stored;
