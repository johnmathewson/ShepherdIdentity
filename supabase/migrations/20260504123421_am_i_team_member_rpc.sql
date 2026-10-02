-- 20260504123421  am_i_team_member_rpc
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

-- am_i_team_member: returns the current user's team-member + admin status.
--
-- Canonical source: team_members (matched by auth_user_id OR email, approved=true).
-- Transitional fallback: auth.users.raw_user_meta_data.is_prayer_team — used by
-- the legacy pco-signin edge function. Once every PC team member has a row in
-- team_members we can drop the metadata fallback.
--
-- SECURITY DEFINER so we can read team_members regardless of its RLS, but the
-- function only ever reveals the *current* user's status (auth.uid() / their
-- own email), so there is no information leak across users.
create or replace function public.am_i_team_member()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_meta_team boolean := false;
  v_in_team boolean := false;
  v_is_admin boolean := false;
begin
  if v_uid is null then
    return jsonb_build_object('is_team_member', false, 'is_admin', false);
  end if;

  select email,
         coalesce((raw_user_meta_data->>'is_prayer_team')::boolean, false)
    into v_email, v_meta_team
    from auth.users
    where id = v_uid;

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
    'is_team_member', v_in_team or v_meta_team,
    'is_admin',       v_is_admin
  );
end;
$$;

revoke all on function public.am_i_team_member() from public;
grant execute on function public.am_i_team_member() to authenticated;
