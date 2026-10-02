-- 20260608191348  social_share_table_and_bucket
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.


-- Cache for generated social-share content. Without this we'd re-bill OpenAI
-- on every admin page visit. Multiple candidate rows per (devotional, variant)
-- so the admin can pick the best one.
create table public.devotional_social_share (
  id              uuid primary key default gen_random_uuid(),
  devotional_id   uuid not null references public.devotionals(id) on delete cascade,
  variant         text not null check (variant in ('instagram_square','instagram_story')),
  candidate_index int  not null default 0,
  caption         text,
  hashtags        text,
  mood_prompt     text,
  image_path      text,
  image_url       text,
  quality         text,
  generated_by    uuid references auth.users(id) on delete set null,
  generated_at    timestamptz not null default now()
);

create index devotional_social_share_devotional_idx
  on public.devotional_social_share (devotional_id);
create index devotional_social_share_lookup_idx
  on public.devotional_social_share (devotional_id, variant, candidate_index);

alter table public.devotional_social_share enable row level security;

-- Admins only — this content isn't surfaced to members directly
create policy devotional_social_share_admin_select on public.devotional_social_share
  for select to authenticated
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

create policy devotional_social_share_admin_modify on public.devotional_social_share
  for all to authenticated
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'))
  with check (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- Storage bucket for the AI-generated backgrounds
insert into storage.buckets (id, name, public)
values ('devotional-graphics', 'devotional-graphics', true)
on conflict (id) do nothing;

-- Public read on the bucket (so the IG-ready PNG can be linked from anywhere)
drop policy if exists "devotional_graphics_public_read" on storage.objects;
create policy "devotional_graphics_public_read"
  on storage.objects for select
  to public
  using (bucket_id = 'devotional-graphics');

-- Service-role bypasses RLS for writes, so no insert policy needed.
-- Admins shouldn't be uploading via the client — only via the edge function.;
