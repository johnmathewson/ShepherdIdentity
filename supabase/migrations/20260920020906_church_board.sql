-- 20260920020906  church_board
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

create table if not exists public.boards (
  key text primary key, name text not null, enabled boolean not null default true, created_at timestamptz default now());
insert into public.boards (key, name) values ('church', 'The Church') on conflict do nothing;

create table if not exists public.board_posts (
  id uuid primary key default gen_random_uuid(),
  board text not null references public.boards(key) default 'church',
  author_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('dream','vision','prophetic','prayer')),
  shared_as text not null check (shared_as in ('named','anon')),
  content text not null check (length(content) between 1 and 6000),
  entry_date date,
  scripture text, tone text, clarity text, context text, source text,
  interpretation text,
  symbols text[],
  source_entry_id text,
  status text not null default 'live' check (status in ('live','hidden','withdrawn','archived')),
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  locked_at timestamptz not null default now() + interval '15 minutes',
  hidden_by uuid, hidden_at timestamptz, hidden_reason text,
  constraint prophetic_is_named check (type <> 'prophetic' or shared_as = 'named')
);
create index if not exists board_posts_feed on public.board_posts (board, status, created_at desc);
create index if not exists board_posts_author on public.board_posts (author_id, created_at desc);

create table if not exists public.board_responses (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.board_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('praying','connects','scripture')),
  ref text,
  created_at timestamptz not null default now(),
  unique (post_id, user_id, kind, ref)
);
create index if not exists board_responses_post on public.board_responses (post_id);

create table if not exists public.board_flags (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.board_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  note text, created_at timestamptz not null default now(),
  resolved_at timestamptz, resolved_by uuid,
  unique (post_id, user_id)
);

alter table public.boards enable row level security;
alter table public.board_posts enable row level security;
alter table public.board_responses enable row level security;
alter table public.board_flags enable row level security;
drop policy if exists "boards readable" on public.boards;
create policy "boards readable" on public.boards for select to authenticated using (enabled);

create or replace function public.is_board_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin')
      or exists (select 1 from hub_access where email = lower(coalesce(auth.jwt()->>'email','')) and '#flockadmin' = any(tags));
$$;

create or replace function public.board_share(
  p_type text, p_shared_as text, p_content text, p_entry_date date, p_scripture text, p_tone text, p_clarity text,
  p_context text, p_source text, p_interpretation text, p_symbols text[], p_source_entry_id text, p_board text default 'church')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not exists (select 1 from boards where key = p_board and enabled) then raise exception 'no such board'; end if;
  insert into board_posts (board, author_id, type, shared_as, content, entry_date, scripture, tone, clarity, context, source, interpretation, symbols, source_entry_id)
  values (p_board, auth.uid(), p_type, p_shared_as, trim(p_content), p_entry_date, nullif(trim(coalesce(p_scripture,'')),''), nullif(p_tone,''), nullif(p_clarity,''),
          nullif(p_context,''), nullif(p_source,''), nullif(trim(coalesce(p_interpretation,'')),''), p_symbols, p_source_entry_id)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.board_edit(p_id uuid, p_content text, p_interpretation text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update board_posts set content = trim(p_content), interpretation = nullif(trim(coalesce(p_interpretation,'')),''), edited_at = now()
  where id = p_id and author_id = auth.uid() and status = 'live' and now() < locked_at;
  if not found then raise exception 'not editable'; end if;
end $$;

create or replace function public.board_withdraw(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update board_posts set status = 'withdrawn' where id = p_id and author_id = auth.uid() and status in ('live','hidden');
  if not found then raise exception 'not yours'; end if;
  delete from board_responses where post_id = p_id;
end $$;

create or replace function public.board_respond(p_post uuid, p_kind text, p_ref text default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_exists boolean;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not exists (select 1 from board_posts where id = p_post and status = 'live') then raise exception 'post not live'; end if;
  if p_kind = 'scripture' and nullif(trim(coalesce(p_ref,'')),'') is null then raise exception 'scripture ref required'; end if;
  select exists (select 1 from board_responses where post_id = p_post and user_id = auth.uid() and kind = p_kind and ref is not distinct from p_ref) into v_exists;
  if v_exists then
    delete from board_responses where post_id = p_post and user_id = auth.uid() and kind = p_kind and ref is not distinct from p_ref; return false;
  else
    insert into board_responses (post_id, user_id, kind, ref) values (p_post, auth.uid(), p_kind, p_ref); return true;
  end if;
end $$;

create or replace function public.board_flag(p_post uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into board_flags (post_id, user_id, note) values (p_post, auth.uid(), p_note) on conflict (post_id, user_id) do update set note = excluded.note, created_at = now();
end $$;

create or replace function public.board_moderate(p_id uuid, p_action text, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_board_admin() then raise exception 'admins only'; end if;
  if p_action = 'hide' then update board_posts set status = 'hidden', hidden_by = auth.uid(), hidden_at = now(), hidden_reason = p_reason where id = p_id and status = 'live';
  elsif p_action = 'unhide' then update board_posts set status = 'live', hidden_by = null, hidden_at = null, hidden_reason = null where id = p_id and status = 'hidden';
  elsif p_action = 'archive' then update board_posts set status = 'archived', hidden_by = auth.uid(), hidden_at = now(), hidden_reason = p_reason where id = p_id;
  else raise exception 'unknown action'; end if;
  update board_flags set resolved_at = now(), resolved_by = auth.uid() where post_id = p_id and resolved_at is null;
end $$;

create or replace function public.board_feed(p_board text default 'church', p_type text default null, p_scope text default 'board', p_limit int default 50, p_before timestamptz default null)
returns table (
  id uuid, type text, shared_as text, author_name text, is_mine boolean, content text, entry_date date, scripture text, tone text, clarity text,
  context text, source text, interpretation text, symbols text[], source_entry_id text, status text, created_at timestamptz, edited_at timestamptz,
  can_edit boolean, hidden_reason text,
  praying int, connects int, scriptures int, my_praying boolean, my_connects boolean, my_scriptures text[], scripture_refs text[],
  connect_posts jsonb, flags int)
language sql stable security definer set search_path = public as $$
  select p.id, p.type, p.shared_as,
    case when p.shared_as = 'named' then coalesce(nullif(pr.display_name,''), split_part(u.email,'@',1)) end as author_name,
    p.author_id = auth.uid() as is_mine,
    p.content, p.entry_date, p.scripture, p.tone, p.clarity, p.context, p.source,
    p.interpretation, p.symbols, p.source_entry_id, p.status, p.created_at, p.edited_at,
    (p.author_id = auth.uid() and p.status = 'live' and now() < p.locked_at) as can_edit,
    case when p.author_id = auth.uid() or is_board_admin() then p.hidden_reason end as hidden_reason,
    (select count(*)::int from board_responses r where r.post_id = p.id and r.kind = 'praying'),
    (select count(*)::int from board_responses r where r.post_id = p.id and r.kind = 'connects'),
    (select count(*)::int from board_responses r where r.post_id = p.id and r.kind = 'scripture'),
    exists (select 1 from board_responses r where r.post_id = p.id and r.kind = 'praying' and r.user_id = auth.uid()),
    exists (select 1 from board_responses r where r.post_id = p.id and r.kind = 'connects' and r.user_id = auth.uid()),
    (select coalesce(array_agg(r.ref), '{}') from board_responses r where r.post_id = p.id and r.kind = 'scripture' and r.user_id = auth.uid()),
    (select coalesce(array_agg(distinct r.ref), '{}') from board_responses r where r.post_id = p.id and r.kind = 'scripture'),
    (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'type', c.type, 'author', case when c.shared_as='named' then coalesce(nullif(cp.display_name,''), split_part(cu.email,'@',1)) end, 'excerpt', left(c.content, 90))), '[]'::jsonb)
       from board_responses r join board_posts c on c.id::text = r.ref and c.status = 'live'
       left join profiles cp on cp.id = c.author_id left join auth.users cu on cu.id = c.author_id
       where r.post_id = p.id and r.kind = 'connects'),
    case when is_board_admin() then (select count(*)::int from board_flags f where f.post_id = p.id and f.resolved_at is null) else 0 end
  from board_posts p
  left join profiles pr on pr.id = p.author_id
  left join auth.users u on u.id = p.author_id
  where p.board = p_board
    and (p_type is null or p.type = p_type)
    and (case when p_scope = 'mine' then p.author_id = auth.uid() and p.status <> 'withdrawn'
              else p.status = 'live' or (p.status = 'hidden' and is_board_admin()) end)
    and (p_before is null or p.created_at < p_before)
  order by p.created_at desc
  limit least(p_limit, 100);
$$;

create or replace function public.board_themes(p_board text default 'church') returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'symbols', (select coalesce(jsonb_agg(jsonb_build_object('name', s, 'n', n) order by n desc), '[]'::jsonb) from (
       select s, count(*) n from board_posts p, unnest(p.symbols) s
       where p.board = p_board and p.status = 'live' and p.created_at > now() - interval '30 days' group by s having count(*) >= 2 order by n desc limit 6) x),
    'scriptures', (select coalesce(jsonb_agg(jsonb_build_object('ref', r, 'n', n) order by n desc), '[]'::jsonb) from (
       select coalesce(nullif(p.scripture,''), r.ref) r, count(*) n from board_posts p left join board_responses r on r.post_id = p.id and r.kind = 'scripture'
       where p.board = p_board and p.status = 'live' and p.created_at > now() - interval '30 days' and coalesce(nullif(p.scripture,''), r.ref) is not null
       group by 1 having count(*) >= 2 order by n desc limit 4) y),
    'month_count', (select count(*) from board_posts p where p.board = p_board and p.status = 'live' and p.created_at > now() - interval '30 days'));
$$;

grant execute on function public.is_board_admin(), public.board_share(text,text,text,date,text,text,text,text,text,text,text[],text,text),
  public.board_edit(uuid,text,text), public.board_withdraw(uuid), public.board_respond(uuid,text,text), public.board_flag(uuid,text),
  public.board_moderate(uuid,text,text), public.board_feed(text,text,text,int,timestamptz), public.board_themes(text) to authenticated;
