-- 20260428122409  create_anonymous_prayer_requests_view
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.


CREATE VIEW anonymous_prayer_requests WITH (security_invoker = true) AS
SELECT
  pr.id,
  pr.category,
  pr.title,
  pr.description,
  pr.status,
  pr.created_at,
  pr.updated_at,
  COALESCE((SELECT count(*) FROM prayer_pickups pp WHERE pp.prayer_request_id = pr.id), 0)::int AS pickup_count
FROM prayer_requests pr;

GRANT SELECT ON anonymous_prayer_requests TO anon, authenticated, service_role;
NOTIFY pgrst, 'reload schema';
