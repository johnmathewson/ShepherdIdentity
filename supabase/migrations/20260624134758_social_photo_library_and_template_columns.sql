-- 20260624134758  social_photo_library_and_template_columns
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.


-- Photo library: curated church photos that admins upload. Tagged so the
-- generator can suggest a relevant photo for each devotional, and the
-- admin can override the suggestion before saving.
create table public.social_photo_assets (
  id             uuid primary key default gen_random_uuid(),
  image_path     text not null,
  image_url      text not null,
  title          text,
  tags           text[] not null default '{}',
  uploaded_by    uuid references auth.users(id) on delete set null,
  uploaded_at    timestamptz not null default now(),
  active         boolean not null default true,
  sort_order     int not null default 0
);

create index social_photo_assets_active_idx on public.social_photo_assets (active, sort_order);
create index social_photo_assets_tags_idx on public.social_photo_assets using gin (tags);

alter table public.social_photo_assets enable row level security;

create policy social_photo_assets_admin_select on public.social_photo_assets
  for select to authenticated
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

create policy social_photo_assets_admin_modify on public.social_photo_assets
  for all to authenticated
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'))
  with check (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- Dedicated storage bucket. Separate from devotional-graphics so we don't
-- mix admin-curated library assets with one-off generated images.
insert into storage.buckets (id, name, public)
values ('social-photo-library', 'social-photo-library', true)
on conflict (id) do nothing;

drop policy if exists "social_photo_library_public_read" on storage.objects;
create policy "social_photo_library_public_read"
  on storage.objects for select to public
  using (bucket_id = 'social-photo-library');

drop policy if exists "social_photo_library_admin_insert" on storage.objects;
create policy "social_photo_library_admin_insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'social-photo-library'
    and exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin')
  );

drop policy if exists "social_photo_library_admin_delete" on storage.objects;
create policy "social_photo_library_admin_delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'social-photo-library'
    and exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin')
  );

-- Extend devotional_social_share with template_id (which design template
-- the admin picked) and photo_id (link to selected library photo).
alter table public.devotional_social_share
  add column if not exists template_id text default 'dark_sage'
    check (template_id in ('dark_sage','cream','photo')),
  add column if not exists photo_id uuid references public.social_photo_assets(id) on delete set null;
