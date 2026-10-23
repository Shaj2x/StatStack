-- StatStack fair play: the server keeps score for signed-in players.
-- Run it in Supabase (SQL Editor → New query → Run) after supabase/schema.sql
-- and supabase/catalog.sql. It's safe to run again after changes.
--
-- Coins, cards, streaks, Daily results and battle records live in the tables
-- below, which players can't write to. Every move goes through a function
-- here: the server hands out each question, times the answer, grades it and
-- pays for it, deals packs, and runs battles. Leaderboards read only these
-- tables, so editing the game in the browser changes nothing that counts.

-- ─── TABLES ─────────────────────────────────────────────────────────────────
create table if not exists public.wallets (
  id uuid primary key references auth.users (id) on delete cascade,
  coins bigint not null default 0 check (coins >= 0),
  free_packs int not null default 0,
  -- Higher or Lower: current run, best ever, best this ISO week, the last question
  hl_streak int not null default 0, hl_best int not null default 0,
  hl_week text not null default '', hl_week_best int not null default 0,
  hl_rounds int not null default 0, hl_correct int not null default 0,
  hl_last jsonb,
  who_streak int not null default 0, who_best int not null default 0,
  who_rounds int not null default 0, who_correct int not null default 0,
  login_last date, login_streak int not null default 0, login_best int not null default 0,
  sets jsonb not null default '{}'::jsonb, -- set id → milestones paid
  battle_w int not null default 0, battle_l int not null default 0, battle_streak int not null default 0,
  battle_best int not null default 0, battle_legend_wins int not null default 0,
  packs int not null default 0, sold int not null default 0, coins_earned bigint not null default 0,
  dailies int not null default 0, daily_perfect int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.owned_cards (
  id bigserial primary key,
  owner uuid not null references auth.users (id) on delete cascade,
  card text not null references public.catalog (key) on update cascade,
  pulled timestamptz not null default now()
);
create index if not exists owned_cards_owner on public.owned_cards (owner);

-- A question or opponent handed out and waiting for an answer
create table if not exists public.rounds (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  data jsonb not null,
  issued timestamptz not null default now(),
  done boolean not null default false
);
create index if not exists rounds_owner on public.rounds (owner, kind) where not done;

-- One Daily puzzle per day, made on first request and the same for everyone
create table if not exists public.daily_puzzles (
  num int primary key,
  questions jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.daily_runs (
  owner uuid not null references auth.users (id) on delete cascade,
  num int not null,
  answers jsonb not null default '[]'::jsonb,
  q_issued timestamptz,
  done boolean not null default false,
  score int not null default 0,
  bonus int not null default 0,
  finished timestamptz,
  primary key (owner, num)
);

-- Nobody reads or writes these directly; only the functions below do
alter table public.wallets enable row level security;
alter table public.owned_cards enable row level security;
alter table public.rounds enable row level security;
alter table public.daily_puzzles enable row level security;
alter table public.daily_runs enable row level security;
revoke all on public.wallets, public.owned_cards, public.rounds, public.daily_puzzles, public.daily_runs from anon, authenticated;

-- ─── RULES ──────────────────────────────────────────────────────────────────
-- Shot clocks in seconds, plus allowance for the trip to the server
create or replace function public.game_rules() returns jsonb language sql immutable as $$
  select '{"hl_clock": 6, "who_clock": 8, "daily_clock": 8, "grace": 1.5,
           "hl_fast": 3, "who_fast": 4, "daily_fast": 4, "daily_fast_pay": 25,
           "who_pay": 25, "who_pay_hint": 12,
           "prices": {"player": 2000, "era": 3000, "team": 3500, "elite": 8000},
           "sell": {"common": 150, "rare": 400, "epic": 1000, "legendary": 3000},
           "login": [100, 200, 300, 400, 500, 600, "pack"],
           "battle": {"rookie": [-7, 60], "pro": [-3, 150], "allstar": [2, 350], "legend": [6, 800]}}'::jsonb;
$$;

-- ─── HELPERS ────────────────────────────────────────────────────────────────
create or replace function public._uid() returns uuid language plpgsql stable as $$
declare u uuid := auth.uid();
begin
  if u is null then raise exception 'Sign in to play for coins' using errcode = '28000'; end if;
  return u;
end $$;

-- The player's wallet, made on first use and locked for this move
create or replace function public._wallet(u uuid) returns public.wallets language plpgsql as $$
declare w public.wallets;
begin
  insert into public.wallets (id) values (u) on conflict (id) do nothing;
  select * into w from public.wallets where id = u for update;
  return w;
end $$;

create or replace function public._stat(c public.catalog, s text) returns float8 language sql immutable as $$
  select case s when 'ppg' then c.ppg when 'rpg' then c.rpg when 'apg' then c.apg when 'spg' then c.spg when 'bpg' then c.bpg end;
$$;

create or replace function public._rarity_rank(r text) returns int language sql immutable as $$
  select case r when 'legendary' then 3 when 'epic' then 2 when 'rare' then 1 else 0 end;
$$;

create or replace function public._utc_today() returns date language sql stable as $$
  select (now() at time zone 'utc')::date;
$$;

-- Daily #1 was 21 October 2026 (UTC)
create or replace function public._daily_today() returns int language sql stable as $$
  select (public._utc_today() - date '2026-10-21') + 1;
$$;
create or replace function public._daily_month(num int) returns text language sql immutable as $$
  select to_char(date '2026-10-21' + (num - 1), 'YYYY-MM');
$$;

create or replace function public._elapsed(t timestamptz) returns float8 language sql stable as $$
  select extract(epoch from (now() - t))::float8;
$$;

create or replace function public._cards_json(u uuid) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_array(o.id, o.card, floor(extract(epoch from o.pulled) * 1000)) order by o.pulled, o.id), '[]'::jsonb)
  from public.owned_cards o where o.owner = u;
$$;

-- Months already over where the player finished in the top 10 of the season
-- board (Daily points, players with a username)
create or replace function public._trophies(u uuid) returns jsonb language sql stable as $$
  with pts as (
    select r.owner, public._daily_month(r.num) as month, sum(r.score) as total, max(r.finished) as last
    from public.daily_runs r join public.saves s on s.id = r.owner
    where r.done and s.username is not null
    group by r.owner, public._daily_month(r.num)
  ), ranked as (
    select owner, month, rank() over (partition by month order by total desc, last asc) as place
    from pts where total > 0 and month < to_char(now() at time zone 'utc', 'YYYY-MM')
  )
  select coalesce(jsonb_agg(jsonb_build_object('month', month, 'rank', place) order by month), '[]'::jsonb)
  from ranked where owner = u and place <= 10;
$$;

-- ─── STATE ──────────────────────────────────────────────────────────────────
-- Everything the game shows for this account. p_num is the Daily the
-- player's calendar is on.
create or replace function public.game_state(p_num int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u uuid := public._uid();
  w public.wallets;
  run public.daily_runs;
begin
  w := public._wallet(u);
  select * into run from public.daily_runs where owner = u and num = coalesce(p_num, public._daily_today());
  return jsonb_build_object(
    'rules', public.game_rules(),
    'today', to_char(public._utc_today(), 'YYYY-MM-DD'),
    'daily_today', public._daily_today(),
    'coins', w.coins,
    'free_packs', w.free_packs,
    'hl', jsonb_build_object('streak', w.hl_streak, 'best', w.hl_best, 'week', w.hl_week, 'week_best', w.hl_week_best,
      'rounds', w.hl_rounds, 'correct', w.hl_correct, 'last', w.hl_last),
    'who', jsonb_build_object('streak', w.who_streak, 'best', w.who_best, 'rounds', w.who_rounds, 'correct', w.who_correct),
    'login', jsonb_build_object('last', coalesce(to_char(w.login_last, 'YYYY-MM-DD'), ''), 'streak', w.login_streak, 'best', w.login_best),
    'sets', w.sets,
    'battle', jsonb_build_object('w', w.battle_w, 'l', w.battle_l, 'streak', w.battle_streak, 'best', w.battle_best, 'legendWins', w.battle_legend_wins),
    'stats', jsonb_build_object('packs', w.packs, 'sold', w.sold, 'coinsEarned', w.coins_earned, 'dailies', w.dailies, 'dailyPerfect', w.daily_perfect),
    'cards', public._cards_json(u),
    'daily', case when run.owner is null then null else jsonb_build_object('num', run.num, 'answers', run.answers, 'done', run.done, 'score', run.score, 'bonus', run.bonus) end,
    'month_pts', (select coalesce(jsonb_object_agg(month, total), '{}'::jsonb) from (
      select public._daily_month(num) as month, sum(score) as total from public.daily_runs
      where owner = u and done group by public._daily_month(num)) m),
    'trophies', public._trophies(u),
    'event', public._event(),
    'social', jsonb_build_object(
      'requests', (select count(*) from public.friendships f where u in (f.a, f.b) and not f.accepted and f.requested_by <> u),
      'challenges', (select count(*) from public.challenges c where c.to_id = u and not c.seen),
      'trades', (select count(*) from public.trades t where t.to_id = u and t.status = 'open'))
  );
end $$;

-- ─── HIGHER OR LOWER ────────────────────────────────────────────────────────
-- Player B is picked closer to player A as the run goes on, like the game
-- always has. A question left unanswered counts as a miss.
create or replace function public.hl_next(p_season text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u uuid := public._uid();
  w public.wallets;
  a public.catalog;
  b public.catalog;
  st text;
  rn int := 1;
  v float8;
  maxd float8;
  rid uuid;
begin
  if not exists (select 1 from public.catalog where season = p_season and ord >= 0) then
    raise exception 'Unknown season';
  end if;
  w := public._wallet(u);
  delete from public.rounds where owner = u and issued < now() - interval '1 day';
  if exists (select 1 from public.rounds where owner = u and kind = 'hl' and not done) then
    update public.rounds set done = true where owner = u and kind = 'hl' and not done;
    w.hl_streak := 0;
    w.hl_last := null;
  end if;
  if w.hl_last is not null and w.hl_last ->> 'season' = p_season and (w.hl_last ->> 'alive')::boolean then
    select * into a from public.catalog where key = w.hl_last ->> 'b';
    rn := (w.hl_last ->> 'round')::int + 1;
  end if;
  if a.key is null then
    -- A new run: a fresh season, a miss, or the first question ever
    select * into a from public.catalog where season = p_season and ord >= 0 order by random() limit 1;
    rn := 1;
    w.hl_streak := 0;
  end if;
  update public.wallets set hl_streak = w.hl_streak, hl_last = w.hl_last where id = u;

  st := (array['ppg', 'rpg', 'apg', 'spg', 'bpg'])[1 + floor(random() * 5)::int];
  v := public._stat(a, st);
  maxd := case when rn <= 5 then 'Infinity'::float8 when rn <= 10 then 10 when rn <= 15 then 6 when rn <= 20 then 3.5 else 1.5 end;
  select * into b from public.catalog c
  where c.season = p_season and c.ord >= 0 and c.name <> a.name and abs(public._stat(c, st) - v) <= maxd
  order by random() limit 1;
  if b.key is null then
    select * into b from public.catalog c where c.season = p_season and c.ord >= 0 and c.name <> a.name order by random() limit 1;
  end if;

  insert into public.rounds (owner, kind, data)
  values (u, 'hl', jsonb_build_object('season', p_season, 'a', a.key, 'b', b.key, 'stat', st, 'round', rn))
  returning id into rid;
  return jsonb_build_object('id', rid, 'a', a.key, 'b', b.key, 'stat', st, 'round', rn, 'streak', w.hl_streak,
    'clock', (public.game_rules() ->> 'hl_clock')::int);
end $$;

-- p_guess is 'higher', 'lower', or anything else when the shot clock ran out
create or replace function public.hl_answer(p_id uuid, p_guess text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u uuid := public._uid();
  rules jsonb := public.game_rules();
  r public.rounds;
  w public.wallets;
  a public.catalog;
  b public.catalog;
  v1 float8; v2 float8;
  el float8;
  late boolean;
  ok boolean;
  streak int := 0; mult int := 1; earned int := 0; bonus int := 0;
  wk text := to_char(now() at time zone 'utc', 'IYYY-"W"IW');
begin
  select * into r from public.rounds where id = p_id and owner = u and kind = 'hl' for update;
  if not found or r.done then raise exception 'That question is over'; end if;
  w := public._wallet(u);
  el := public._elapsed(r.issued);
  select * into a from public.catalog where key = r.data ->> 'a';
  select * into b from public.catalog where key = r.data ->> 'b';
  v1 := public._stat(a, r.data ->> 'stat');
  v2 := public._stat(b, r.data ->> 'stat');
  late := el > (rules ->> 'hl_clock')::float8 + (rules ->> 'grace')::float8;
  ok := coalesce(not late and ((p_guess = 'higher' and v2 >= v1) or (p_guess = 'lower' and v2 <= v1)), false);
  if ok then
    streak := w.hl_streak + 1;
    mult := streak / 3 + 1;
    earned := 10 * mult;
    if el <= (rules ->> 'hl_fast')::float8 + (rules ->> 'grace')::float8 / 2 then bonus := ceil(earned / 2.0); end if;
  end if;
  update public.wallets set
    coins = coins + earned + bonus,
    coins_earned = coins_earned + earned + bonus,
    hl_streak = streak,
    hl_best = greatest(hl_best, streak),
    hl_week_best = case when hl_week = wk then greatest(hl_week_best, streak) else streak end,
    hl_week = wk,
    hl_rounds = hl_rounds + 1,
    hl_correct = hl_correct + ok::int,
    hl_last = jsonb_build_object('season', r.data ->> 'season', 'b', b.key, 'round', (r.data ->> 'round')::int, 'alive', ok)
  where id = u
  returning * into w;
  update public.rounds set done = true where id = p_id;
  return jsonb_build_object('ok', ok, 'late', late or coalesce(p_guess not in ('higher', 'lower'), true), 'value', v2,
    'earned', earned, 'bonus', bonus, 'streak', w.hl_streak, 'mult', mult, 'best', w.hl_best,
    'week', w.hl_week, 'week_best', w.hl_week_best, 'coins', w.coins,
    'rounds', w.hl_rounds, 'correct', w.hl_correct);
end $$;

-- ─── WHO AM I? ──────────────────────────────────────────────────────────────
-- A season's stat line and four names; the wrong names had the closest numbers
create or replace function public.who_next(p_season text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u uuid := public._uid();
  w public.wallets;
  ans public.catalog;
  opts text[];
  rid uuid;
begin
  if not exists (select 1 from public.catalog where season = p_season and ord >= 0) then
    raise exception 'Unknown season';
  end if;
  w := public._wallet(u);
  if exists (select 1 from public.rounds where owner = u and kind = 'who' and not done) then
    update public.rounds set done = true where owner = u and kind = 'who' and not done;
    update public.wallets set who_streak = 0 where id = u;
    w.who_streak := 0;
  end if;
  select * into ans from public.catalog where season = p_season and ord >= 0 and ppg >= 4 order by random() limit 1;
  select array_agg(key order by random()) into opts from (
    select key from (
      select c.key from public.catalog c
      where c.season = p_season and c.ord >= 0 and c.ppg >= 4 and c.name <> ans.name
      order by abs(c.ppg - ans.ppg) / 5 + abs(c.rpg - ans.rpg) / 2 + abs(c.apg - ans.apg) / 1.5
             + abs(c.spg - ans.spg) / 0.4 + abs(c.bpg - ans.bpg) / 0.4
      limit 7
    ) near order by random() limit 3
  ) d;
  select array_agg(k order by random()) into opts from unnest(opts || ans.key) k;
  insert into public.rounds (owner, kind, data)
  values (u, 'who', jsonb_build_object('season', p_season, 'answer', ans.key, 'options', to_jsonb(opts), 'hint', false))
  returning id into rid;
  return jsonb_build_object('id', rid, 'options', to_jsonb(opts), 'streak', w.who_streak,
    'line', jsonb_build_object('ppg', ans.ppg, 'rpg', ans.rpg, 'apg', ans.apg, 'spg', ans.spg, 'bpg', ans.bpg),
    'clock', (public.game_rules() ->> 'who_clock')::int);
end $$;

create or replace function public.who_hint(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u uuid := public._uid(); r public.rounds;
begin
  select * into r from public.rounds where id = p_id and owner = u and kind = 'who' for update;
  if not found or r.done then raise exception 'That question is over'; end if;
  update public.rounds set data = data || '{"hint": true}'::jsonb where id = p_id;
  return jsonb_build_object('team', (select team from public.catalog where key = r.data ->> 'answer'));
end $$;

-- p_pick is 0–3, or -1 when the shot clock ran out
create or replace function public.who_answer(p_id uuid, p_pick int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u uuid := public._uid();
  rules jsonb := public.game_rules();
  r public.rounds;
  w public.wallets;
  el float8;
  late boolean;
  ok boolean;
  pay int := 0; bonus int := 0;
begin
  select * into r from public.rounds where id = p_id and owner = u and kind = 'who' for update;
  if not found or r.done then raise exception 'That question is over'; end if;
  w := public._wallet(u);
  el := public._elapsed(r.issued);
  late := el > (rules ->> 'who_clock')::float8 + (rules ->> 'grace')::float8;
  ok := coalesce(not late and p_pick between 0 and 3 and r.data -> 'options' ->> p_pick = r.data ->> 'answer', false);
  if ok then
    pay := case when (r.data ->> 'hint')::boolean then (rules ->> 'who_pay_hint')::int else (rules ->> 'who_pay')::int end;
    if el <= (rules ->> 'who_fast')::float8 + (rules ->> 'grace')::float8 / 2 then bonus := ceil(pay / 2.0); end if;
  end if;
  update public.wallets set
    coins = coins + pay + bonus,
    coins_earned = coins_earned + pay + bonus,
    who_streak = case when ok then who_streak + 1 else 0 end,
    who_best = greatest(who_best, case when ok then who_streak + 1 else 0 end),
    who_rounds = who_rounds + 1,
    who_correct = who_correct + ok::int
  where id = u
  returning * into w;
  update public.rounds set done = true where id = p_id;
  return jsonb_build_object('ok', ok, 'late', late or not coalesce(p_pick between 0 and 3, false), 'answer', r.data ->> 'answer',
    'pay', pay, 'bonus', bonus, 'streak', w.who_streak, 'best', w.who_best, 'coins', w.coins,
    'rounds', w.who_rounds, 'correct', w.who_correct);
end $$;

-- ─── DAILY CHALLENGE ────────────────────────────────────────────────────────
-- Hard on purpose: players from every era, the two numbers within 6% of each
-- other, and every other question a star against a lesser player who usually
-- edges them. Made once per day and stored, so everyone gets the same ten.
create or replace function public._make_daily() returns jsonb language plpgsql as $$
declare
  stats text[] := array['ppg', 'ppg', 'ppg', 'rpg', 'rpg', 'apg', 'apg', 'spg', 'bpg'];
  mins jsonb := '{"ppg": 6, "rpg": 2.5, "apg": 1.5, "spg": 0.6, "bpg": 0.4}';
  used text[] := '{}';
  qs jsonb := '[]'::jsonb;
  st text; trap boolean; av float8;
  a public.catalog; b public.catalog;
  upset boolean;
  guard int := 0;
begin
  while jsonb_array_length(qs) < 10 and guard < 4000 loop
    guard := guard + 1;
    st := stats[1 + floor(random() * 9)::int];
    trap := jsonb_array_length(qs) % 2 = 0;
    select * into a from public.catalog where ord >= 0 and ppg > 0 and (not trap or rarity in ('epic', 'legendary'))
      order by random() limit 1;
    av := public._stat(a, st);
    continue when av < (mins ->> st)::float8 or a.name = any(used);
    upset := trap and random() < 0.7;
    b := null;
    if upset then
      select * into b from public.catalog c where c.ord >= 0 and c.ppg > 0 and c.name <> a.name and not (c.name = any(used))
        and public._stat(c, st) > av and public._stat(c, st) - av <= greatest(0.1, av * 0.06)
        and public._rarity_rank(c.rarity) < public._rarity_rank(a.rarity)
        order by random() limit 1;
    end if;
    if b.key is null then
      select * into b from public.catalog c where c.ord >= 0 and c.ppg > 0 and c.name <> a.name and not (c.name = any(used))
        and public._stat(c, st) <> av and abs(public._stat(c, st) - av) <= greatest(0.1, av * 0.06)
        and (not trap or public._rarity_rank(c.rarity) < public._rarity_rank(a.rarity))
        order by random() limit 1;
    end if;
    continue when b.key is null;
    used := used || a.name || b.name;
    -- The star sits on the left about half the time, so the trap isn't a pattern
    qs := qs || case when random() < 0.5
      then jsonb_build_object('a', a.key, 'b', b.key, 'stat', st)
      else jsonb_build_object('a', b.key, 'b', a.key, 'stat', st) end;
  end loop;
  return qs;
end $$;

-- Today's puzzle (or an older one, for a friend's challenge). Anyone may ask.
create or replace function public.daily_puzzle(p_num int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare qs jsonb;
begin
  if p_num < 1 or p_num > public._daily_today() + 1 then raise exception 'That Daily isn''t out yet'; end if;
  select questions into qs from public.daily_puzzles where num = p_num;
  if qs is null then
    insert into public.daily_puzzles (num, questions) values (p_num, public._make_daily()) on conflict (num) do nothing;
    select questions into qs from public.daily_puzzles where num = p_num;
  end if;
  return qs;
end $$;

-- Calendars differ around the world, so yesterday's, today's and tomorrow's
-- UTC puzzles are open; each can be played once
create or replace function public._daily_run(u uuid, p_num int) returns public.daily_runs language plpgsql as $$
declare run public.daily_runs;
begin
  if p_num not between public._daily_today() - 1 and public._daily_today() + 1 then
    raise exception 'That Daily is closed';
  end if;
  perform public.daily_puzzle(p_num);
  insert into public.daily_runs (owner, num) values (u, p_num) on conflict do nothing;
  select * into run from public.daily_runs where owner = u and num = p_num for update;
  return run;
end $$;

-- Starts the shot clock on the next question, when it's on screen
create or replace function public.daily_next(p_num int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u uuid := public._uid(); run public.daily_runs;
begin
  run := public._daily_run(u, p_num);
  if not run.done and run.q_issued is null then
    update public.daily_runs set q_issued = now() where owner = u and num = p_num returning * into run;
  end if;
  return jsonb_build_object('index', jsonb_array_length(run.answers), 'answers', run.answers, 'done', run.done,
    'score', run.score, 'elapsed', case when run.q_issued is null then 0 else public._elapsed(run.q_issued) end,
    'clock', (public.game_rules() ->> 'daily_clock')::int);
end $$;

create or replace function public.daily_answer(p_num int, p_guess text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u uuid := public._uid();
  rules jsonb := public.game_rules();
  run public.daily_runs;
  w public.wallets;
  q jsonb;
  a public.catalog; b public.catalog;
  va float8; vb float8;
  el float8;
  late boolean;
  ok boolean;
  fast int := 0;
  idx int;
  reward int := 0;
begin
  run := public._daily_run(u, p_num);
  if run.done then raise exception 'You''ve played this Daily'; end if;
  if run.q_issued is null then raise exception 'Start the question first'; end if;
  idx := jsonb_array_length(run.answers);
  q := (select questions -> idx from public.daily_puzzles where num = p_num);
  select * into a from public.catalog where key = q ->> 'a';
  select * into b from public.catalog where key = q ->> 'b';
  va := public._stat(a, q ->> 'stat');
  vb := public._stat(b, q ->> 'stat');
  el := public._elapsed(run.q_issued);
  late := el > (rules ->> 'daily_clock')::float8 + (rules ->> 'grace')::float8;
  ok := coalesce(not late and p_guess in ('higher', 'lower') and (p_guess = 'higher') = (vb > va), false);
  if ok and el <= (rules ->> 'daily_fast')::float8 + (rules ->> 'grace')::float8 / 2 then
    fast := (rules ->> 'daily_fast_pay')::int;
  end if;
  update public.daily_runs set answers = answers || to_jsonb(ok), q_issued = null, bonus = bonus + fast
  where owner = u and num = p_num returning * into run;

  if jsonb_array_length(run.answers) >= 10 then
    select count(*) into run.score from jsonb_array_elements(run.answers) x where x = 'true'::jsonb;
    reward := run.score * 50 + case when run.score = 10 then 250 else 0 end + run.bonus;
    update public.daily_runs set done = true, score = run.score, finished = now() where owner = u and num = p_num;
    w := public._wallet(u);
    update public.wallets set coins = coins + reward, coins_earned = coins_earned + reward,
      dailies = dailies + 1, daily_perfect = daily_perfect + (run.score = 10)::int
    where id = u returning * into w;
    run.done := true;
  else
    select * into w from public.wallets where id = u;
  end if;
  return jsonb_build_object('ok', ok, 'late', late or coalesce(p_guess not in ('higher', 'lower'), true), 'value_a', va, 'value_b', vb,
    'answers', run.answers, 'done', run.done, 'score', run.score, 'reward', reward, 'bonus', run.bonus,
    'fast', fast, 'coins', coalesce(w.coins, 0));
end $$;

-- ─── DAILY LOGIN REWARD ─────────────────────────────────────────────────────
-- Days are UTC days. Day 1–6 pay coins, day 7 a free Player Pack; missing a
-- day starts the run again.
create or replace function public.claim_login()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u uuid := public._uid();
  w public.wallets;
  today date := public._utc_today();
  n int; reward jsonb;
begin
  w := public._wallet(u);
  if w.login_last = today then
    return jsonb_build_object('claimed', false, 'streak', w.login_streak, 'coins', w.coins, 'free_packs', w.free_packs,
      'login', jsonb_build_object('last', to_char(w.login_last, 'YYYY-MM-DD'), 'streak', w.login_streak, 'best', w.login_best));
  end if;
  n := case when w.login_last = today - 1 then w.login_streak + 1 else 1 end;
  reward := public.game_rules() -> 'login' -> ((n - 1) % 7);
  update public.wallets set
    login_last = today, login_streak = n, login_best = greatest(login_best, n),
    free_packs = free_packs + case when reward = '"pack"'::jsonb then 1 else 0 end,
    coins = coins + case when reward = '"pack"'::jsonb then 0 else (reward #>> '{}')::int end,
    coins_earned = coins_earned + case when reward = '"pack"'::jsonb then 0 else (reward #>> '{}')::int end
  where id = u returning * into w;
  return jsonb_build_object('claimed', true, 'streak', n, 'reward', reward, 'coins', w.coins, 'free_packs', w.free_packs,
    'login', jsonb_build_object('last', to_char(w.login_last, 'YYYY-MM-DD'), 'streak', w.login_streak, 'best', w.login_best));
end $$;

-- ─── WEEKEND PACKS ──────────────────────────────────────────────────────────
-- Each weekend (Friday to Sunday, UTC) one limited pack is in the shop, and
-- the theme rotates every week. js/app.js has the same schedule and pools.
create or replace function public._event(at timestamptz default now()) returns jsonb language sql stable as $$
  with d as (select (at at time zone 'utc')::date as day),
  w as (select day, floor((day - date '2026-10-19') / 7.0)::int as week from d),
  e as (
    select w.*, (array['playoff', 'bigs', 'scorers', 'dimes', 'lockdown'])[1 + ((w.week % 5) + 5) % 5] as id from w
  )
  select jsonb_build_object(
    'id', id,
    'live', extract(isodow from day) >= 5,
    'starts', to_char(date '2026-10-19' + week * 7 + 4, 'YYYY-MM-DD'),
    'ends', to_char(date '2026-10-19' + week * 7 + 7, 'YYYY-MM-DD'),
    'price', case id when 'playoff' then 5000 else 4000 end,
    'odds', case id when 'playoff' then '{"legendary": 5, "epic": 20, "rare": 75, "common": 0}'::jsonb
                    else '{"legendary": 4, "epic": 12, "rare": 34, "common": 50}'::jsonb end)
  from e;
$$;
create or replace function public._event_has(id text, c public.catalog) returns boolean language sql immutable as $$
  select case id
    when 'playoff' then c.rarity <> 'common'
    when 'bigs' then c.rpg >= 9
    when 'scorers' then c.ppg >= 22
    when 'dimes' then c.apg >= 7
    when 'lockdown' then c.spg >= 1.6 or c.bpg >= 1.8
    else false end;
$$;

-- ─── PACKS ──────────────────────────────────────────────────────────────────
-- p_choice is the era or franchise for those packs; p_season the season the
-- player is on, for Player Packs
create or replace function public.open_pack(p_type text, p_choice text default null, p_season text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u uuid := public._uid();
  w public.wallets;
  ev jsonb := public._event();
  price int := case when p_type = 'event' then (ev ->> 'price')::int else (public.game_rules() -> 'prices' ->> p_type)::int end;
  odds jsonb := case when p_type = 'elite' then '{"legendary": 8, "epic": 32, "rare": 60, "common": 0}'::jsonb
                     when p_type = 'event' then ev -> 'odds'
                     else '{"legendary": 2, "epic": 8, "rare": 20, "common": 70}'::jsonb end;
  tiers text[] := array['legendary', 'epic', 'rare', 'common'];
  free boolean;
  roll float8 := random() * 100;
  i int := 4;
  t int;
  card public.catalog;
  o public.owned_cards;
begin
  if price is null then raise exception 'Unknown pack'; end if;
  if p_type = 'event' and not (ev ->> 'live')::boolean then raise exception 'That pack is only in the shop at the weekend'; end if;
  w := public._wallet(u);
  free := p_type = 'player' and w.free_packs > 0;
  if not free and w.coins < price then raise exception 'Not enough coins'; end if;
  -- Roll a rarity, then fall back a tier at a time (down, then up) if the pool has none of it
  for k in 1..4 loop
    if roll < (odds ->> tiers[k])::float8 then i := k; exit; end if;
    roll := roll - (odds ->> tiers[k])::float8;
  end loop;
  foreach t in array array[i, i + 1, i + 2, i + 3, i - 1, i - 2, i - 3] loop
    continue when t < 1 or t > 4;
    select * into card from public.catalog c
    where c.ord >= 0 and c.rarity = tiers[t] and case p_type
      when 'player' then c.season = p_season
      when 'era' then c.era = p_choice
      when 'team' then c.franchise = p_choice
      when 'event' then public._event_has(ev ->> 'id', c)
      else true end
    order by random() limit 1;
    exit when card.key is not null;
  end loop;
  if card.key is null then raise exception 'That pack has no cards'; end if;
  update public.wallets set
    coins = coins - case when free then 0 else price end,
    free_packs = free_packs - free::int,
    packs = packs + 1
  where id = u returning * into w;
  insert into public.owned_cards (owner, card) values (u, card.key) returning * into o;
  return jsonb_build_object('card', jsonb_build_array(o.id, o.card, floor(extract(epoch from o.pulled) * 1000)),
    'coins', w.coins, 'free_packs', w.free_packs, 'packs', w.packs);
end $$;

-- Sell up to p_count extra copies of one card, newest first, always keeping one
create or replace function public.sell_copies(p_card text, p_count int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u uuid := public._uid();
  w public.wallets;
  ids bigint[];
  value int;
begin
  w := public._wallet(u);
  select array_agg(id) into ids from (
    select id from public.owned_cards where owner = u and card = p_card
    order by pulled desc, id desc offset 0
    limit greatest(0, least(p_count, (select count(*) from public.owned_cards where owner = u and card = p_card) - 1))
  ) s;
  if ids is null then return jsonb_build_object('sold', 0, 'value', 0, 'removed', '[]'::jsonb, 'coins', w.coins); end if;
  delete from public.owned_cards where id = any(ids);
  value := cardinality(ids) * (public.game_rules() -> 'sell' ->> (select rarity from public.catalog where key = p_card))::int;
  update public.wallets set coins = coins + value, coins_earned = coins_earned + value, sold = sold + cardinality(ids)
  where id = u returning * into w;
  return jsonb_build_object('sold', cardinality(ids), 'value', value, 'removed', to_jsonb(ids), 'coins', w.coins);
end $$;

-- Every duplicate in the collection, keeping the first copy of each card
create or replace function public.sell_all_copies()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u uuid := public._uid();
  w public.wallets;
  ids bigint[];
  value int;
begin
  w := public._wallet(u);
  select array_agg(id), coalesce(sum((public.game_rules() -> 'sell' ->> rarity)::int), 0) into ids, value from (
    select o.id, c.rarity, row_number() over (partition by o.card order by o.pulled, o.id) as n
    from public.owned_cards o join public.catalog c on c.key = o.card where o.owner = u
  ) s where n > 1;
  if ids is null then return jsonb_build_object('sold', 0, 'value', 0, 'removed', '[]'::jsonb, 'coins', w.coins); end if;
  delete from public.owned_cards where id = any(ids);
  update public.wallets set coins = coins + value, coins_earned = coins_earned + value, sold = sold + cardinality(ids)
  where id = u returning * into w;
  return jsonb_build_object('sold', cardinality(ids), 'value', value, 'removed', to_jsonb(ids), 'coins', w.coins);
end $$;

-- ─── SETS ───────────────────────────────────────────────────────────────────
-- Era sets: the era's legendary cards. Team sets: every card of a franchise.
-- Season sets: every card of a season. Each pays at three milestones, once.
create or replace function public.claim_sets()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u uuid := public._uid();
  w public.wallets;
  s record;
  goals int[]; pays int[];
  met int; done int;
  paid jsonb := '[]'::jsonb;
  total int := 0;
  new_sets jsonb;
begin
  w := public._wallet(u);
  new_sets := w.sets;
  for s in
    with owned as (select distinct card from public.owned_cards where owner = u),
    members as (
      select 'era-' || era as id, 'era' as kind, key from public.catalog where ord >= 0 and rarity = 'legendary'
      union all select 'team-' || franchise, 'team', key from public.catalog where ord >= 0
      union all select 'season-' || season, 'season', key from public.catalog where ord >= 0
    )
    select m.id, m.kind, count(*) as size, count(o.card) as have
    from members m left join owned o on o.card = m.key group by m.id, m.kind
  loop
    goals := case s.kind when 'era' then array[1, 5, s.size] when 'team' then array[5, 15, s.size] else array[10, 40, s.size] end;
    pays := case s.kind when 'era' then array[2000, 10000, 60000] when 'team' then array[1000, 4000, 25000] else array[1500, 6000, 50000] end;
    met := (s.have >= least(goals[1], s.size))::int + (s.have >= least(goals[2], s.size))::int + (s.have >= s.size)::int;
    done := coalesce((new_sets ->> s.id)::int, 0);
    if met > done then
      for t in done + 1..met loop
        paid := paid || jsonb_build_object('id', s.id, 'tier', t - 1, 'pay', pays[t], 'goal', least(goals[t], s.size));
        total := total + pays[t];
      end loop;
      new_sets := new_sets || jsonb_build_object(s.id, met);
    end if;
  end loop;
  if total > 0 or new_sets <> w.sets then
    update public.wallets set coins = coins + total, coins_earned = coins_earned + total, sets = new_sets
    where id = u returning * into w;
  end if;
  return jsonb_build_object('paid', paid, 'coins', w.coins, 'sets', w.sets);
end $$;

-- ─── LINEUP BATTLES ─────────────────────────────────────────────────────────
-- p_keys: the five starters, as catalog keys the player owns
create or replace function public._lineup_ovr(u uuid, p_keys text[]) returns int language plpgsql stable as $$
declare n int; names int; o numeric;
begin
  if cardinality(p_keys) <> 5 then raise exception 'Pick five starters'; end if;
  select count(*), count(distinct c.name), avg(c.ovr) into n, names, o
  from public.catalog c where c.key = any(p_keys)
    and exists (select 1 from public.owned_cards w where w.owner = u and w.card = c.key);
  if n <> 5 or names <> 5 then raise exception 'Your lineup has cards you don''t own'; end if;
  return round(o);
end $$;

create or replace function public.battle_opponent(p_level text, p_keys text[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u uuid := public._uid();
  lvl jsonb := public.game_rules() -> 'battle' -> p_level;
  mine int;
  target int;
  width int := 2;
  picked text[] := '{}';
  names text[];
  c public.catalog;
  team_name text;
  rid uuid;
begin
  if lvl is null then raise exception 'Unknown level'; end if;
  mine := public._lineup_ovr(u, p_keys);
  target := greatest(70, least(97, mine + (lvl ->> 0)::int));
  select array_agg(name) into names from public.catalog where key = any(p_keys);
  if (select count(*) from public.catalog where ord >= 0 and not (name = any(names)) and abs(ovr - target) <= 2) < 12 then
    width := 5;
  end if;
  for i in 1..5 loop
    select * into c from public.catalog where ord >= 0 and not (name = any(names)) and abs(ovr - target) <= width
      order by random() limit 1;
    exit when c.key is null;
    picked := picked || c.key;
    names := names || c.name;
  end loop;
  team_name := (array['Glass Cleaners', 'Splash Club', 'Paint Patrol', 'Fast Break Five', 'Iso Kings', 'Lockdown Crew',
    'Bench Mob', 'Showtime Select', 'Twin Towers', 'Retro Ballers', 'Pick and Roll', 'Hardwood Heroes', 'Night Shift',
    'Full Court Press'])[1 + floor(random() * 14)::int];
  delete from public.rounds where owner = u and kind = 'battle' and not done;
  insert into public.rounds (owner, kind, data)
  values (u, 'battle', jsonb_build_object('level', p_level, 'mine', to_jsonb(p_keys), 'theirs', to_jsonb(picked), 'name', team_name))
  returning id into rid;
  return jsonb_build_object('id', rid, 'name', team_name, 'cards', to_jsonb(picked));
end $$;

-- Who wins comes from the OVR gap; the box score is drawn by the game
create or replace function public.battle_play(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u uuid := public._uid();
  r public.rounds;
  w public.wallets;
  mine int; theirs int;
  win boolean;
  pay int := 0;
begin
  select * into r from public.rounds where id = p_id and owner = u and kind = 'battle' for update;
  if not found or r.done then raise exception 'That game is over'; end if;
  w := public._wallet(u);
  mine := public._lineup_ovr(u, array(select jsonb_array_elements_text(r.data -> 'mine')));
  select round(avg(ovr)) into theirs from public.catalog where key in (select jsonb_array_elements_text(r.data -> 'theirs'));
  win := random() < 1 / (1 + exp(-(mine - theirs) / 3.0));
  if win then pay := (public.game_rules() -> 'battle' -> (r.data ->> 'level') ->> 1)::int; end if;
  update public.wallets set
    coins = coins + pay, coins_earned = coins_earned + pay,
    battle_w = battle_w + win::int, battle_l = battle_l + (not win)::int,
    battle_streak = case when win then battle_streak + 1 else 0 end,
    battle_best = greatest(battle_best, case when win then battle_streak + 1 else 0 end),
    battle_legend_wins = battle_legend_wins + (win and r.data ->> 'level' = 'legend')::int
  where id = u returning * into w;
  update public.rounds set done = true where id = p_id;
  return jsonb_build_object('win', win, 'pay', pay, 'coins', w.coins,
    'battle', jsonb_build_object('w', w.battle_w, 'l', w.battle_l, 'streak', w.battle_streak, 'best', w.battle_best, 'legendWins', w.battle_legend_wins));
end $$;

-- ─── LEADERBOARDS ───────────────────────────────────────────────────────────
-- Only numbers the server recorded count. Saves supply the username, team
-- colour and the three showcase cards, which must be cards the player owns.
drop function if exists public.leaderboard(text, int);
create or replace function public.leaderboard(board text, puzzle int default null, period text default null)
returns table (
  username text, team text, score int,
  showcase jsonb, best int, legends int, wins int, losses int, trophies int
)
language sql stable security definer set search_path = public as $$
  with month as (
    select coalesce(period, to_char(now() at time zone 'utc', 'YYYY-MM')) as m
  ), legends as (
    select o.owner, count(*)::int as n from public.owned_cards o join public.catalog c on c.key = o.card
    where c.rarity = 'legendary' group by o.owner
  ), pts as (
    select r.owner, public._daily_month(r.num) as m, sum(r.score)::int as total, max(r.finished) as last
    from public.daily_runs r where r.done group by r.owner, public._daily_month(r.num)
  ), placed as (
    select p.owner, rank() over (partition by p.m order by p.total desc, p.last asc) as place
    from pts p join public.saves s on s.id = p.owner
    where s.username is not null and p.total > 0 and p.m < to_char(now() at time zone 'utc', 'YYYY-MM')
  ), cups as (
    select owner, count(*)::int as n from placed where place <= 10 group by owner
  )
  select
    s.username,
    left(coalesce(s.data #>> '{profile,team}', ''), 4),
    v.score,
    coalesce((
      select jsonb_agg(x) from (
        select x from jsonb_array_elements(
          case when jsonb_typeof(s.data #> '{profile,showcase}') = 'array' then s.data #> '{profile,showcase}' else '[]'::jsonb end
        ) x
        where jsonb_typeof(x) = 'string' and exists (
          select 1 from public.owned_cards o join public.catalog c on c.key = o.card
          where o.owner = s.id and c.name || '|' || c.season = x #>> '{}')
        limit 3
      ) q
    ), '[]'::jsonb),
    w.hl_best,
    coalesce(lg.n, 0),
    w.battle_w,
    w.battle_l,
    coalesce(cu.n, 0)
  from public.saves s
  join public.wallets w on w.id = s.id
  left join legends lg on lg.owner = s.id
  left join cups cu on cu.owner = s.id
  cross join month
  cross join lateral (
    select case board
      when 'alltime' then w.hl_best
      when 'week' then case when w.hl_week = to_char(now() at time zone 'utc', 'IYYY-"W"IW') then w.hl_week_best end
      when 'legendaries' then lg.n
      when 'daily' then (select r.score from public.daily_runs r where r.owner = s.id and r.num = puzzle and r.done)
      when 'season' then (select p.total from pts p where p.owner = s.id and p.m = month.m)
    end as score
  ) v
  where s.username is not null and v.score is not null and (v.score > 0 or board = 'daily')
  order by v.score desc, s.updated_at asc
  limit 50;
$$;

-- ─── FRIENDS ────────────────────────────────────────────────────────────────
-- One row per pair (a < b). A request is a row that isn't accepted yet.
create table if not exists public.friendships (
  a uuid not null references auth.users (id) on delete cascade,
  b uuid not null references auth.users (id) on delete cascade,
  requested_by uuid not null,
  accepted boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (a, b),
  check (a < b)
);
create index if not exists friendships_b on public.friendships (b);

-- A challenge sent straight to a friend: a Daily score or a lineup to beat
create table if not exists public.challenges (
  id bigserial primary key,
  from_id uuid not null references auth.users (id) on delete cascade,
  to_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('daily', 'lineup')),
  payload jsonb not null,
  seen boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists challenges_to on public.challenges (to_id) where not seen;

-- Card swaps between friends. give: the sender's cards, want: the friend's.
create table if not exists public.trades (
  id bigserial primary key,
  from_id uuid not null references auth.users (id) on delete cascade,
  to_id uuid not null references auth.users (id) on delete cascade,
  give bigint[] not null,
  want bigint[] not null,
  status text not null default 'open' check (status in ('open', 'accepted', 'declined', 'cancelled', 'void')),
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index if not exists trades_from on public.trades (from_id, status);
create index if not exists trades_to on public.trades (to_id, status);

alter table public.friendships enable row level security;
alter table public.challenges enable row level security;
alter table public.trades enable row level security;
revoke all on public.friendships, public.challenges, public.trades from anon, authenticated;

create or replace function public._user_named(p_name text) returns uuid language sql stable as $$
  select id from public.saves where lower(username) = lower(trim(p_name)) limit 1;
$$;
create or replace function public._name_of(u uuid) returns text language sql stable as $$
  select username from public.saves where id = u;
$$;
create or replace function public._are_friends(x uuid, y uuid) returns boolean language sql stable as $$
  select exists (select 1 from public.friendships where a = least(x, y) and b = greatest(x, y) and accepted);
$$;
-- The friend a name points to, or an error
create or replace function public._friend(u uuid, p_name text) returns uuid language plpgsql stable as $$
declare f uuid := public._user_named(p_name);
begin
  if f is null or not public._are_friends(u, f) then raise exception 'You''re not friends with %', p_name; end if;
  return f;
end $$;

-- Send a request, or accept theirs if they already asked
create or replace function public.friend_request(p_name text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u uuid := public._uid();
  f uuid := public._user_named(p_name);
  fr public.friendships;
begin
  if public._name_of(u) is null then raise exception 'Pick a username on your profile first'; end if;
  if f is null then raise exception 'No player called %', p_name; end if;
  if f = u then raise exception 'That''s you'; end if;
  select * into fr from public.friendships where a = least(u, f) and b = greatest(u, f) for update;
  if found then
    if fr.accepted then return jsonb_build_object('status', 'friends'); end if;
    if fr.requested_by = f then
      update public.friendships set accepted = true where a = fr.a and b = fr.b;
      return jsonb_build_object('status', 'friends');
    end if;
    return jsonb_build_object('status', 'sent');
  end if;
  if (select count(*) from public.friendships where (a = u or b = u)) >= 200 then raise exception 'That''s a lot of friends. Remove some first.'; end if;
  insert into public.friendships (a, b, requested_by) values (least(u, f), greatest(u, f), u);
  return jsonb_build_object('status', 'sent');
end $$;

create or replace function public.friend_respond(p_name text, p_accept boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u uuid := public._uid(); f uuid := public._user_named(p_name);
begin
  if p_accept then
    update public.friendships set accepted = true where a = least(u, f) and b = greatest(u, f) and requested_by = f and not accepted;
  else
    delete from public.friendships where a = least(u, f) and b = greatest(u, f) and not accepted;
  end if;
  return jsonb_build_object('ok', found);
end $$;

-- Unfriend, cancel a request, and call off any open trades between the two
create or replace function public.friend_remove(p_name text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u uuid := public._uid(); f uuid := public._user_named(p_name);
begin
  delete from public.friendships where a = least(u, f) and b = greatest(u, f);
  update public.trades set status = 'cancelled', done_at = now()
  where status = 'open' and ((from_id = u and to_id = f) or (from_id = f and to_id = u));
  return jsonb_build_object('ok', true);
end $$;

-- Friends, requests both ways, and each friend's record and showcase
create or replace function public.friends_list()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'username', s.username,
    'team', left(coalesce(s.data #>> '{profile,team}', ''), 4),
    'status', case when f.accepted then 'friend' when f.requested_by = public._uid() then 'outgoing' else 'incoming' end,
    'best', coalesce(w.hl_best, 0),
    'wins', coalesce(w.battle_w, 0), 'losses', coalesce(w.battle_l, 0),
    'legends', (select count(*) from public.owned_cards o join public.catalog c on c.key = o.card where o.owner = s.id and c.rarity = 'legendary'),
    'cards', (select count(*) from public.owned_cards o where o.owner = s.id),
    'daily', (select jsonb_build_object('num', r.num, 'score', r.score) from public.daily_runs r
              where r.owner = s.id and r.done order by r.num desc limit 1),
    'showcase', coalesce((
      select jsonb_agg(x) from (
        select x from jsonb_array_elements(
          case when jsonb_typeof(s.data #> '{profile,showcase}') = 'array' then s.data #> '{profile,showcase}' else '[]'::jsonb end) x
        where jsonb_typeof(x) = 'string' and exists (
          select 1 from public.owned_cards o join public.catalog c on c.key = o.card
          where o.owner = s.id and c.name || '|' || c.season = x #>> '{}')
        limit 3) q), '[]'::jsonb)
  ) order by f.accepted, lower(s.username)), '[]'::jsonb)
  from public.friendships f
  join public.saves s on s.id = case when f.a = public._uid() then f.b else f.a end
  left join public.wallets w on w.id = s.id
  where public._uid() in (f.a, f.b) and s.username is not null;
$$;

-- A friend's cards, to pick from when offering a trade
create or replace function public.friend_cards(p_name text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare u uuid := public._uid(); f uuid := public._friend(u, p_name);
begin
  return public._cards_json(f);
end $$;

-- ─── CHALLENGES SENT TO A FRIEND ────────────────────────────────────────────
-- p_kind 'daily': your finished score on Daily p_num. p_kind 'lineup': five
-- of your cards as "Name|Season" keys, and a lineup name.
create or replace function public.challenge_send(p_name text, p_kind text, p_num int default null,
  p_keys text[] default null, p_lineup text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u uuid := public._uid();
  f uuid := public._friend(u, p_name);
  payload jsonb;
  sc int;
begin
  if p_kind = 'daily' then
    select score into sc from public.daily_runs where owner = u and num = p_num and done;
    if sc is null then raise exception 'Finish that Daily first'; end if;
    payload := jsonb_build_object('n', p_num, 's', sc);
  elsif p_kind = 'lineup' then
    if cardinality(p_keys) <> 5 or (select count(distinct split_part(k, '|', 1)) from unnest(p_keys) k) <> 5
       or exists (select 1 from unnest(p_keys) k where not exists (
         select 1 from public.owned_cards o join public.catalog c on c.key = o.card
         where o.owner = u and c.name || '|' || c.season = k)) then
      raise exception 'Your lineup has cards you don''t own';
    end if;
    payload := jsonb_build_object('k', to_jsonb(p_keys), 'name', left(regexp_replace(coalesce(p_lineup, ''), '[^\w ''’.-]', '', 'g'), 24));
  else
    raise exception 'Unknown challenge';
  end if;
  if (select count(*) from public.challenges where to_id = f and not seen) >= 20 then
    raise exception '% has a full inbox. Try again later.', p_name;
  end if;
  insert into public.challenges (from_id, to_id, kind, payload) values (u, f, p_kind, payload);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.challenge_inbox()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'from', public._name_of(c.from_id), 'kind', c.kind,
    'payload', c.payload, 'at', floor(extract(epoch from c.created_at) * 1000)) order by c.created_at), '[]'::jsonb)
  from public.challenges c where c.to_id = public._uid() and not c.seen;
$$;

create or replace function public.challenge_seen(p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  update public.challenges set seen = true where id = p_id and to_id = public._uid();
  return jsonb_build_object('ok', found);
end $$;

-- ─── TRADES ─────────────────────────────────────────────────────────────────
-- Offer up to five of your cards for up to five of a friend's. Nothing moves
-- until they accept, and then only if both sides still own every card.
create or replace function public.trade_offer(p_name text, p_give bigint[], p_want bigint[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u uuid := public._uid();
  f uuid := public._friend(u, p_name);
  g bigint[] := coalesce(p_give, '{}');
  wt bigint[] := coalesce(p_want, '{}');
  tid bigint;
begin
  if cardinality(g) + cardinality(wt) = 0 then raise exception 'Pick some cards to swap'; end if;
  if cardinality(g) > 5 or cardinality(wt) > 5 then raise exception 'Up to five cards each way'; end if;
  if (select count(distinct x) from unnest(g) x) <> cardinality(g) or (select count(distinct x) from unnest(wt) x) <> cardinality(wt) then
    raise exception 'A card is in there twice';
  end if;
  if (select count(*) from public.owned_cards where id = any(g) and owner = u) <> cardinality(g) then
    raise exception 'You don''t own all of those cards';
  end if;
  if (select count(*) from public.owned_cards where id = any(wt) and owner = f) <> cardinality(wt) then
    raise exception '% doesn''t own all of those cards any more', p_name;
  end if;
  if (select count(*) from public.trades where from_id = u and status = 'open') >= 10 then
    raise exception 'You have 10 offers waiting. Cancel one first.';
  end if;
  insert into public.trades (from_id, to_id, give, want) values (u, f, g, wt) returning id into tid;
  return jsonb_build_object('id', tid);
end $$;

create or replace function public.trade_respond(p_id bigint, p_accept boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u uuid := public._uid();
  t public.trades;
  moved bigint[];
begin
  select * into t from public.trades where id = p_id and to_id = u and status = 'open' for update;
  if not found then raise exception 'That offer is gone'; end if;
  if not p_accept then
    update public.trades set status = 'declined', done_at = now() where id = p_id;
    return jsonb_build_object('status', 'declined');
  end if;
  if not public._are_friends(u, t.from_id) then raise exception 'You''re not friends any more'; end if;
  -- Lock both sides' cards, then check nobody sold or traded them meanwhile
  perform 1 from public.owned_cards where id = any(t.give || t.want) for update;
  if (select count(*) from public.owned_cards where id = any(t.give) and owner = t.from_id) <> cardinality(t.give)
     or (select count(*) from public.owned_cards where id = any(t.want) and owner = u) <> cardinality(t.want) then
    update public.trades set status = 'void', done_at = now() where id = p_id;
    return jsonb_build_object('status', 'void', 'message', 'Some of those cards were sold or traded already, so the offer is off.');
  end if;
  update public.owned_cards set owner = u where id = any(t.give);
  update public.owned_cards set owner = t.from_id where id = any(t.want);
  update public.trades set status = 'accepted', done_at = now() where id = p_id;
  -- Other offers that included these cards can't happen now
  moved := t.give || t.want;
  update public.trades set status = 'void', done_at = now()
  where status = 'open' and id <> p_id and (give && moved or want && moved);
  return jsonb_build_object('status', 'accepted', 'cards', public._cards_json(u));
end $$;

create or replace function public.trade_cancel(p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  update public.trades set status = 'cancelled', done_at = now() where id = p_id and from_id = public._uid() and status = 'open';
  return jsonb_build_object('ok', found);
end $$;

-- Open offers both ways, plus the last week's finished ones
create or replace function public.trades_list()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id,
    'dir', case when t.from_id = public._uid() then 'out' else 'in' end,
    'with', public._name_of(case when t.from_id = public._uid() then t.to_id else t.from_id end),
    'status', t.status,
    'give', (select coalesce(jsonb_agg(jsonb_build_array(o.id, o.card)), '[]'::jsonb) from public.owned_cards o where o.id = any(t.give)),
    'want', (select coalesce(jsonb_agg(jsonb_build_array(o.id, o.card)), '[]'::jsonb) from public.owned_cards o where o.id = any(t.want)),
    'at', floor(extract(epoch from coalesce(t.done_at, t.created_at)) * 1000)
  ) order by t.status <> 'open', coalesce(t.done_at, t.created_at) desc), '[]'::jsonb)
  from public.trades t
  where public._uid() in (t.from_id, t.to_id) and (t.status = 'open' or t.done_at > now() - interval '7 days');
$$;

-- What's waiting for the player: friend requests, challenges and offers
create or replace function public.social_counts()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'requests', (select count(*) from public.friendships f where public._uid() in (f.a, f.b) and not f.accepted and f.requested_by <> public._uid()),
    'challenges', (select count(*) from public.challenges c where c.to_id = public._uid() and not c.seen),
    'trades', (select count(*) from public.trades t where t.to_id = public._uid() and t.status = 'open'));
$$;

-- The player's cards and coins, after a trade changed them
create or replace function public.my_cards()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('cards', public._cards_json(public._uid()),
    'coins', (select coins from public.wallets where id = public._uid()));
$$;

-- ─── ACCESS ─────────────────────────────────────────────────────────────────
-- Functions are callable by everyone unless revoked; the helpers stay private
revoke execute on function public._uid(), public._wallet(uuid), public._stat(public.catalog, text), public._rarity_rank(text),
  public._utc_today(), public._daily_today(), public._daily_month(int), public._elapsed(timestamptz), public._cards_json(uuid),
  public._trophies(uuid), public._make_daily(), public._daily_run(uuid, int), public._lineup_ovr(uuid, text[]),
  public._event(timestamptz), public._event_has(text, public.catalog), public._user_named(text), public._name_of(uuid),
  public._are_friends(uuid, uuid), public._friend(uuid, text)
  from public, anon, authenticated;
revoke execute on function public.game_state(int), public.hl_next(text), public.hl_answer(uuid, text),
  public.who_next(text), public.who_hint(uuid), public.who_answer(uuid, int), public.daily_next(int),
  public.daily_answer(int, text), public.claim_login(), public.open_pack(text, text, text),
  public.sell_copies(text, int), public.sell_all_copies(), public.claim_sets(),
  public.battle_opponent(text, text[]), public.battle_play(uuid) from public, anon;
grant execute on function public.game_state(int), public.hl_next(text), public.hl_answer(uuid, text),
  public.who_next(text), public.who_hint(uuid), public.who_answer(uuid, int), public.daily_next(int),
  public.daily_answer(int, text), public.claim_login(), public.open_pack(text, text, text),
  public.sell_copies(text, int), public.sell_all_copies(), public.claim_sets(),
  public.battle_opponent(text, text[]), public.battle_play(uuid) to authenticated;
revoke execute on function public.friend_request(text), public.friend_respond(text, boolean), public.friend_remove(text),
  public.friends_list(), public.friend_cards(text), public.challenge_send(text, text, int, text[], text),
  public.challenge_inbox(), public.challenge_seen(bigint), public.trade_offer(text, bigint[], bigint[]),
  public.trade_respond(bigint, boolean), public.trade_cancel(bigint), public.trades_list(),
  public.social_counts(), public.my_cards() from public, anon;
grant execute on function public.friend_request(text), public.friend_respond(text, boolean), public.friend_remove(text),
  public.friends_list(), public.friend_cards(text), public.challenge_send(text, text, int, text[], text),
  public.challenge_inbox(), public.challenge_seen(bigint), public.trade_offer(text, bigint[], bigint[]),
  public.trade_respond(bigint, boolean), public.trade_cancel(bigint), public.trades_list(),
  public.social_counts(), public.my_cards() to authenticated;
grant execute on function public.daily_puzzle(int), public.leaderboard(text, int, text), public.game_rules() to anon, authenticated;

-- ─── MOVING EXISTING ACCOUNTS ACROSS ────────────────────────────────────────
-- Once, the first time this file runs, for accounts saved before then: their
-- coins (capped at 50,000), cards, streaks and records come over from the
-- save. Accounts made later start fresh; a guest's progress stays on their
-- device. Running the file again never imports a save.
create table if not exists public.game_meta (key text primary key, value text not null);
alter table public.game_meta enable row level security;
revoke all on public.game_meta from anon, authenticated;

create or replace function public._num(j jsonb, cap int) returns int language sql immutable as $$
  select least(coalesce(public.as_score(j), 0), cap);
$$;

do $migrate$
begin
  if exists (select 1 from public.game_meta where key = 'migrated') then return; end if;
  insert into public.wallets (id, coins, free_packs, hl_best, hl_week, hl_week_best, login_last, login_streak, login_best,
    sets, battle_w, battle_l, battle_streak, battle_best, battle_legend_wins, packs, sold, coins_earned, dailies, daily_perfect,
    hl_rounds, hl_correct, who_best, who_rounds, who_correct)
  select s.id,
    public._num(s.data -> 'coins', 50000),
    public._num(s.data #> '{profile,freePacks,player}', 3),
    public._num(s.data -> 'bestStreak', 100),
    coalesce(s.data #>> '{profile,weekly,week}', ''),
    public._num(s.data #> '{profile,weekly,best}', 100),
    case when s.data #>> '{profile,login,last}' ~ '^\d{4}-\d{2}-\d{2}$' then (s.data #>> '{profile,login,last}')::date end,
    public._num(s.data #> '{profile,login,streak}', 365),
    public._num(s.data #> '{profile,login,best}', 365),
    case when jsonb_typeof(s.data #> '{profile,sets}') = 'object' then s.data #> '{profile,sets}' else '{}'::jsonb end,
    public._num(s.data #> '{profile,battle,w}', 1000),
    public._num(s.data #> '{profile,battle,l}', 1000),
    public._num(s.data #> '{profile,battle,streak}', 100),
    public._num(s.data #> '{profile,battle,best}', 100),
    public._num(s.data #> '{profile,battle,legendWins}', 1000),
    public._num(s.data #> '{profile,stats,packs}', 10000),
    public._num(s.data #> '{profile,stats,sold}', 10000),
    public._num(s.data #> '{profile,stats,coinsEarned}', 1000000),
    public._num(s.data #> '{profile,stats,dailies}', 1000),
    public._num(s.data #> '{profile,stats,dailyPerfect}', 1000),
    public._num(s.data #> '{profile,stats,rounds}', 1000000),
    public._num(s.data #> '{profile,stats,correct}', 1000000),
    public._num(s.data #> '{profile,stats,whoBest}', 100),
    public._num(s.data #> '{profile,stats,whoRounds}', 1000000),
    public._num(s.data #> '{profile,stats,whoCorrect}', 1000000)
  from public.saves s
  on conflict (id) do nothing;

  -- Their cards, when this is the first run (an account with no cards yet)
  insert into public.owned_cards (owner, card, pulled)
  select s.id, c.key, to_timestamp(least(greatest(coalesce((x ->> 'pulled')::float8, 0), 0), 4102444800000) / 1000)
  from public.saves s
  cross join lateral (
    select x from jsonb_array_elements(case when jsonb_typeof(s.data -> 'cards') = 'array' then s.data -> 'cards' else '[]'::jsonb end) x
    limit 1000
  ) xs
  join public.catalog c on c.key = (x ->> 'name') || '|' || (x ->> 'season') || '|' || (x ->> 'team')
  where not exists (select 1 from public.owned_cards o where o.owner = s.id)
    and jsonb_typeof(x -> 'pulled') in ('number', 'null');

  -- Today's Daily, if they'd finished it, so it isn't played twice
  insert into public.daily_runs (owner, num, answers, done, score, finished)
  select s.id, (s.data #>> '{profile,daily,num}')::int, s.data #> '{profile,daily,answers}', true,
    least(public._num(s.data #> '{profile,daily,score}', 10), 10), now()
  from public.saves s
  where jsonb_typeof(s.data #> '{profile,daily,num}') = 'number' and s.data #>> '{profile,daily,done}' = 'true'
    and jsonb_typeof(s.data #> '{profile,daily,answers}') = 'array'
  on conflict do nothing;
  insert into public.game_meta (key, value) values ('migrated', now()::text);
end
$migrate$;
revoke execute on function public._num(jsonb, int) from public, anon, authenticated;
