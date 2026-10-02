-- 20260428123754  create_signup_and_oauth_rpcs
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.


CREATE OR REPLACE FUNCTION create_visitor_profile(
  p_auth_user_id UUID, p_email TEXT, p_display_name TEXT
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_visitor visitors;
BEGIN
  SELECT * INTO v_visitor FROM visitors WHERE auth_user_id = p_auth_user_id;
  IF v_visitor.id IS NOT NULL THEN
    RETURN json_build_object('id', v_visitor.id, 'display_name', v_visitor.display_name);
  END IF;
  INSERT INTO visitors (auth_user_id, email, display_name)
  VALUES (p_auth_user_id, p_email, p_display_name)
  RETURNING * INTO v_visitor;
  RETURN json_build_object('id', v_visitor.id, 'display_name', v_visitor.display_name);
END; $$;

CREATE OR REPLACE FUNCTION upsert_visitor_from_pc(
  p_planning_center_id TEXT, p_email TEXT, p_display_name TEXT
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_visitor visitors;
BEGIN
  SELECT * INTO v_visitor FROM visitors WHERE planning_center_id = p_planning_center_id;
  IF v_visitor.id IS NOT NULL THEN
    UPDATE visitors SET display_name = p_display_name, email = p_email
    WHERE id = v_visitor.id RETURNING * INTO v_visitor;
    RETURN json_build_object('id', v_visitor.id, 'display_name', v_visitor.display_name, 'email', v_visitor.email);
  END IF;
  SELECT * INTO v_visitor FROM visitors WHERE email = p_email AND planning_center_id IS NULL;
  IF v_visitor.id IS NOT NULL THEN
    UPDATE visitors SET planning_center_id = p_planning_center_id, display_name = p_display_name
    WHERE id = v_visitor.id RETURNING * INTO v_visitor;
    RETURN json_build_object('id', v_visitor.id, 'display_name', v_visitor.display_name, 'email', v_visitor.email);
  END IF;
  INSERT INTO visitors (display_name, email, planning_center_id)
  VALUES (p_display_name, p_email, p_planning_center_id)
  RETURNING * INTO v_visitor;
  RETURN json_build_object('id', v_visitor.id, 'display_name', v_visitor.display_name, 'email', v_visitor.email);
END; $$;

CREATE OR REPLACE FUNCTION upsert_team_member_from_pc(
  p_planning_center_id TEXT, p_email TEXT, p_display_name TEXT
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_member team_members;
BEGIN
  SELECT * INTO v_member FROM team_members WHERE planning_center_id = p_planning_center_id;
  IF v_member.id IS NOT NULL THEN
    UPDATE team_members SET display_name = p_display_name, email = p_email
    WHERE id = v_member.id RETURNING * INTO v_member;
  ELSE
    INSERT INTO team_members (planning_center_id, email, display_name, role, approved)
    VALUES (p_planning_center_id, p_email, p_display_name, 'member', true)
    RETURNING * INTO v_member;
  END IF;
  RETURN json_build_object(
    'id', v_member.id,
    'display_name', v_member.display_name,
    'email', v_member.email,
    'role', v_member.role
  );
END; $$;

NOTIFY pgrst, 'reload schema';
