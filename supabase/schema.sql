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
