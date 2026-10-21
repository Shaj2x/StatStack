-- StatStack cloud saves. Run once in Supabase: SQL Editor → New query → Run.
-- One row per signed-in player. Row-level security means a player can only
-- read and write their own row, so the public anon key in js/config.js is safe.

create table if not exists public.saves (
  id uuid primary key references auth.users (id) on delete cascade,
  username text unique check (username ~ '^[A-Za-z0-9_]{3,16}$'),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Usernames are unique regardless of case
create unique index if not exists saves_username_lower on public.saves (lower(username));

-- Signed-in players can reach the table through the Data API; nobody else can
grant select, insert, update on public.saves to authenticated;
revoke all on public.saves from anon;

alter table public.saves enable row level security;

drop policy if exists "Players read their own save" on public.saves;
create policy "Players read their own save" on public.saves
  for select using (auth.uid() = id);

drop policy if exists "Players create their own save" on public.saves;
create policy "Players create their own save" on public.saves
  for insert with check (auth.uid() = id);

drop policy if exists "Players update their own save" on public.saves;
create policy "Players update their own save" on public.saves
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- Lets the sign-up form check a username before making the account. It only
-- answers yes or no; it never reveals whose name it is.
create or replace function public.username_available(name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (select 1 from public.saves where lower(username) = lower(name));
$$;
grant execute on function public.username_available(text) to anon, authenticated;

-- Leaderboards. Saves stay private; this function hands out only usernames,
-- team colours and one number per player, for players who picked a username.
create or replace function public.as_score(j jsonb)
returns int
language sql
immutable
as $$
  select case when jsonb_typeof(j) = 'number'
    then least(greatest((j #>> '{}')::numeric, 0), 1000000)::int end;
$$;

create or replace function public.leaderboard(board text, puzzle int default null)
returns table (username text, team text, score int)
language sql
stable
security definer
set search_path = public
as $$
  select s.username, left(coalesce(s.data #>> '{profile,team}', ''), 4) as team, v.score
  from public.saves s
  cross join lateral (
    select case board
      when 'alltime' then public.as_score(s.data -> 'bestStreak')
      when 'week' then case
        when s.data #>> '{profile,weekly,week}' = to_char(now() at time zone 'utc', 'IYYY-"W"IW')
        then public.as_score(s.data #> '{profile,weekly,best}') end
      when 'legendaries' then (
        select count(*)::int
        from jsonb_array_elements(case when jsonb_typeof(s.data -> 'cards') = 'array' then s.data -> 'cards' else '[]'::jsonb end) c
        where c ->> 'rarity' = 'legendary')
      when 'daily' then case
        when public.as_score(s.data #> '{profile,daily,num}') = puzzle
         and s.data #>> '{profile,daily,done}' = 'true'
        then least(public.as_score(s.data #> '{profile,daily,score}'), 10) end
    end as score
  ) v
  where s.username is not null and v.score is not null and (v.score > 0 or board = 'daily')
  order by v.score desc, s.updated_at asc
  limit 50;
$$;
grant execute on function public.leaderboard(text, int) to anon, authenticated;
