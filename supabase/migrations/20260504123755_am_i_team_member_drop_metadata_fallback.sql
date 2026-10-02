-- 20260504123755  am_i_team_member_drop_metadata_fallback
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

-- Drop the user_metadata.is_prayer_team transitional fallback. As of this
-- migration, every metadata-flagged user is already represented in
-- team_members (verified: 4/4 metadata-flagged users have team_members rows,
-- 0 needed backfill). team_members is now the sole source of truth.
create or replace function public.am_i_team_member()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_in_team boolean := false;
  v_is_admin boolean := false;
begin
  if v_uid is null then
    return jsonb_build_object('is_team_member', false, 'is_admin', false);
  end if;

  select email into v_email from auth.users where id = v_uid;

  select
    exists (
      select 1 from public.team_members
      where (auth_user_id = v_uid
             or (v_email is not null and lower(email) = lower(v_email)))
        and approved = true
    ),
    exists (
      select 1 from public.team_members
      where (auth_user_id = v_uid
             or (v_email is not null and lower(email) = lower(v_email)))
        and approved = true
        and role = 'admin'
    )
    into v_in_team, v_is_admin;

  return jsonb_build_object(
    'is_team_member', v_in_team,
    'is_admin',       v_is_admin
  );
end;
$$;

revoke all on function public.am_i_team_member() from public;
grant execute on function public.am_i_team_member() to authenticated;
