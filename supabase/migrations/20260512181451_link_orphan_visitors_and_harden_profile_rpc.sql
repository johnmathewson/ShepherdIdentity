-- 20260512181451  link_orphan_visitors_and_harden_profile_rpc
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

-- 1. Harden create_visitor_profile: when a visitor row already exists by
--    email but has no auth_user_id (created via PCO flow or pre-Supabase),
--    link it instead of trying to INSERT a duplicate. Mirrors the same
--    "link-by-email" pattern the magic-link callback uses for team_members.
--    Before this, the INSERT collided with the UNIQUE(email) constraint and
--    the callback returned /login?error=server_error — users saw their
--    magic link "expire immediately."
CREATE OR REPLACE FUNCTION public.create_visitor_profile(
  p_auth_user_id uuid,
  p_email text,
  p_display_name text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_visitor visitors;
BEGIN
  -- Path 1: already linked.
  SELECT * INTO v_visitor FROM visitors WHERE auth_user_id = p_auth_user_id;
  IF v_visitor.id IS NOT NULL THEN
    RETURN json_build_object('id', v_visitor.id, 'display_name', v_visitor.display_name);
  END IF;

  -- Path 2: row exists by email but unlinked. Link it now so the
  -- caller's auth session resolves to the same visitor and any prior
  -- bookings stay attached.
  SELECT * INTO v_visitor
    FROM visitors
    WHERE lower(email) = lower(p_email) AND auth_user_id IS NULL
    LIMIT 1;
  IF v_visitor.id IS NOT NULL THEN
    UPDATE visitors SET auth_user_id = p_auth_user_id WHERE id = v_visitor.id;
    RETURN json_build_object('id', v_visitor.id, 'display_name', v_visitor.display_name);
  END IF;

  -- Path 3: net-new visitor.
  INSERT INTO visitors (auth_user_id, email, display_name)
  VALUES (p_auth_user_id, p_email, p_display_name)
  RETURNING * INTO v_visitor;
  RETURN json_build_object('id', v_visitor.id, 'display_name', v_visitor.display_name);
END;
$function$;

-- 2. Backfill: link the two real orphan visitor rows to their auth.users
--    by email so existing bookings show as "Mine" again immediately.
--    Sample data rows (sample-*@shepherdchurch.example) are left alone.
UPDATE visitors v
   SET auth_user_id = au.id
  FROM auth.users au
 WHERE v.auth_user_id IS NULL
   AND v.email NOT LIKE 'sample-%@shepherdchurch.example'
   AND lower(v.email) = lower(au.email);
