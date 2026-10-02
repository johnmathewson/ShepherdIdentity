-- 20260830112312  create_identity_cards_multi_save
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

-- Multiple saveable identity cards per user.
-- profiles.state->'identityWorksheet' is left intact so the current front-end keeps working;
-- this table is additive and becomes the source of truth once the UI is switched over.

create table if not exists public.identity_cards (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  label             text not null default 'Untitled card',
  identity_statement text,
  callings          text,
  spiritual_gifts   text,
  passion           text,
  vocation          text,
  ministry          text,
  natural_abilities text,
  is_primary        boolean not null default false,
  source            text not null default 'worksheet'
                    check (source in ('worksheet','ai_synthesis','manual','import')),
  sort_order        integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.identity_cards is 'Saved identity cards. A user may hold many; at most one is_primary.';

-- At most one primary card per user
create unique index if not exists identity_cards_one_primary_per_user
  on public.identity_cards (user_id) where is_primary;

create index if not exists identity_cards_user_idx
  on public.identity_cards (user_id, sort_order, created_at);

-- Keep updated_at fresh using the existing house trigger fn
drop trigger if exists identity_cards_set_updated_at on public.identity_cards;
create trigger identity_cards_set_updated_at
  before update on public.identity_cards
  for each row execute function public.set_updated_at();

-- RLS, matching the profiles table's pattern
alter table public.identity_cards enable row level security;

drop policy if exists "Users can view own identity cards"   on public.identity_cards;
drop policy if exists "Users can insert own identity cards" on public.identity_cards;
drop policy if exists "Users can update own identity cards" on public.identity_cards;
drop policy if exists "Users can delete own identity cards" on public.identity_cards;
drop policy if exists "Admins can view all identity cards"  on public.identity_cards;

create policy "Users can view own identity cards"
  on public.identity_cards for select using (auth.uid() = user_id);
create policy "Users can insert own identity cards"
  on public.identity_cards for insert with check (auth.uid() = user_id);
create policy "Users can update own identity cards"
  on public.identity_cards for update using (auth.uid() = user_id);
create policy "Users can delete own identity cards"
  on public.identity_cards for delete using (auth.uid() = user_id);
create policy "Admins can view all identity cards"
  on public.identity_cards for select using (is_admin());
