-- Study Deck — accounts and sync schema.
-- Paste this whole file into the Supabase SQL editor and run it once.
--
-- Row Level Security is the entire defence here. The anon key ships in the
-- page by design: it identifies the project, it does not grant access. What
-- stops one person reading another's decks is the policies below, so nothing
-- in this file is optional.

-- ---------------------------------------------------------------- categories
create table if not exists public.categories (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 60),
  color       text not null default 'c1' check (color ~ '^c[1-8]$'),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- --------------------------------------------------------------------- decks
create table if not exists public.decks (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  cat         text,
  name        text not null check (char_length(name) between 1 and 120),
  note        text not null default '',
  -- [[question, answer, group, distractors, id], ...] — a deck is only ever
  -- read and written whole, so a separate cards table would buy only joins
  cards       jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  constraint cards_is_array check (jsonb_typeof(cards) = 'array'),
  -- a runaway client must not be able to fill the database
  constraint cards_not_huge check (pg_column_size(cards) < 1048576)
);

-- --------------------------------------------------------------- study state
-- progress, starred, best and streak: small, always written together
create table if not exists public.study_state (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  state       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  constraint state_not_huge check (pg_column_size(state) < 262144)
);

-- ------------------------------------------------------------- scan counters
-- One row per user per day. The Gemini free tier is ~20 requests a day in
-- total, so without this the first person to upload a 24-page note set spends
-- six of them and everyone else is locked out.
create table if not exists public.scan_usage (
  user_id     uuid not null references auth.users(id) on delete cascade,
  day         date not null default (now() at time zone 'utc')::date,
  count       integer not null default 0,
  primary key (user_id, day)
);

create index if not exists decks_user_idx      on public.decks (user_id);
create index if not exists categories_user_idx on public.categories (user_id);

-- ------------------------------------------------------------------- the RLS
alter table public.categories  enable row level security;
alter table public.decks       enable row level security;
alter table public.study_state enable row level security;
alter table public.scan_usage  enable row level security;

drop policy if exists "own categories"  on public.categories;
drop policy if exists "own decks"       on public.decks;
drop policy if exists "own study state" on public.study_state;
drop policy if exists "read own usage"  on public.scan_usage;

-- `using` governs what can be read; `with check` governs what can be written.
-- Both are needed: without `with check` a user could insert rows owned by
-- someone else, and without `using` they could read them.
create policy "own categories" on public.categories
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own decks" on public.decks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own study state" on public.study_state
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Counters are read-only to their owner. Only the server, using the service
-- role, may increment them, otherwise the cap is trivially bypassed.
create policy "read own usage" on public.scan_usage
  for select using (auth.uid() = user_id);

-- --------------------------------------------------------- server-side count
-- Called by /api/extract with the service role. Atomic, so two scans started
-- at once cannot both slip under the limit.
create or replace function public.bump_scan_usage(uid uuid, limit_per_day int)
returns table (allowed boolean, used int, remaining int)
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'utc')::date;
  n int;
begin
  insert into scan_usage (user_id, day, count)
       values (uid, today, 1)
  on conflict (user_id, day)
       do update set count = scan_usage.count + 1
     where scan_usage.count < limit_per_day
  returning scan_usage.count into n;

  if n is null then                       -- the where clause blocked the bump
    select scan_usage.count into n from scan_usage
     where scan_usage.user_id = uid and scan_usage.day = today;
    return query select false, coalesce(n, limit_per_day), 0;
  else
    return query select true, n, greatest(limit_per_day - n, 0);
  end if;
end;
$$;

revoke all on function public.bump_scan_usage(uuid, int) from public, anon, authenticated;

-- Housekeeping: soft-deleted rows exist so a deletion can propagate to a
-- device that was offline at the time. After a month they have done their job.
create or replace function public.purge_deleted()
returns void language sql security definer set search_path = public as $$
  delete from decks      where deleted_at is not null and deleted_at < now() - interval '30 days';
  delete from categories where deleted_at is not null and deleted_at < now() - interval '30 days';
$$;
