-- 20260512191009  link_auth_user_id_in_upsert_visitor_from_pc
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

-- Harden the PCO-sign-in visitor upsert so the resulting visitor row is
-- linked to an existing auth.users by email at the moment of creation.
-- Without this, PCO sign-ins kept producing visitor rows with auth_user_id
-- = NULL, and any later magic-link sign-in for the same person would have
-- to rely on create_visitor_profile to backfill the link. Belt-and-
-- suspenders: catch it at the source too. COALESCE preserves any
-- already-set auth_user_id (we never overwrite a valid link).
CREATE OR REPLACE FUNCTION public.upsert_visitor_from_pc(
  p_planning_center_id text,
  p_email text,
  p_display_name text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_visitor visitors;
  v_auth_user_id uuid;
BEGIN
  -- Find the matching auth.users by email (if any) so we can link as we go.
  SELECT id INTO v_auth_user_id
    FROM auth.users
    WHERE lower(email) = lower(p_email)
    LIMIT 1;

  -- Path 1: exists by planning_center_id → update profile, (re)link if missing.
  SELECT * INTO v_visitor FROM visitors WHERE planning_center_id = p_planning_center_id;
  IF v_visitor.id IS NOT NULL THEN
    UPDATE visitors
       SET display_name  = p_display_name,
           email         = p_email,
           auth_user_id  = COALESCE(visitors.auth_user_id, v_auth_user_id)
     WHERE id = v_visitor.id
     RETURNING * INTO v_visitor;
    RETURN json_build_object('id', v_visitor.id, 'display_name', v_visitor.display_name, 'email', v_visitor.email);
  END IF;

  -- Path 2: exists by email but no PCO id → backfill PCO id, link if missing.
  SELECT * INTO v_visitor FROM visitors WHERE email = p_email AND planning_center_id IS NULL;
  IF v_visitor.id IS NOT NULL THEN
    UPDATE visitors
       SET planning_center_id = p_planning_center_id,
           display_name       = p_display_name,
           auth_user_id       = COALESCE(visitors.auth_user_id, v_auth_user_id)
     WHERE id = v_visitor.id
     RETURNING * INTO v_visitor;
    RETURN json_build_object('id', v_visitor.id, 'display_name', v_visitor.display_name, 'email', v_visitor.email);
  END IF;

  -- Path 3: net-new visitor → set auth_user_id at insert time.
  INSERT INTO visitors (display_name, email, planning_center_id, auth_user_id)
  VALUES (p_display_name, p_email, p_planning_center_id, v_auth_user_id)
  RETURNING * INTO v_visitor;
  RETURN json_build_object('id', v_visitor.id, 'display_name', v_visitor.display_name, 'email', v_visitor.email);
END;
$function$;
