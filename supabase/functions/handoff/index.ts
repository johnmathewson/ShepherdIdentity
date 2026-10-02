import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SignJWT } from "https://esm.sh/jose@5.9.6";

// POST /functions/v1/handoff  { app: "prayer-wall", next?: "/team" }
// Requires the caller's hub session (Authorization: Bearer <access_token>).
// Returns { url } — a one-shot, 60-second signed handoff into the target app.
// The hub never touches another project's keys; it only signs a claim that
// the target project's sso-handoff function verifies with the shared secret.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!accessToken) return json({ error: "no_session" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // 1. Who is asking? Validate the hub session against this project's Auth.
  const asUser = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await asUser.auth.getUser(accessToken);
  if (userErr || !userData?.user?.email) return json({ error: "invalid_session" }, 401);
  const email = userData.user.email.trim().toLowerCase();
  const name = (userData.user.user_metadata?.display_name as string | undefined) ?? "";

  // 2. What are they asking for?
  let body: { app?: string; next?: string } = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const appKey = (body.app ?? "").trim();
  const next = typeof body.next === "string" && body.next.startsWith("/") ? body.next : "/";
  if (!appKey) return json({ error: "missing_app" }, 400);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: app } = await admin.from("hub_apps").select("*").eq("key", appKey).eq("enabled", true).maybeSingle();
  if (!app) return json({ error: "unknown_app" }, 404);

  // 3. What may they have? Tags come from hub_access (PCO-derived in step 2).
  const { data: access } = await admin.from("hub_access").select("tags").eq("email", email).maybeSingle();
  const tags: string[] = access?.tags ?? [];
  const required: string[] = app.required_tags ?? [];
  const allowed = required.length === 0 || required.some((t) => tags.includes(t));
  if (!allowed) return json({ error: "not_permitted", required }, 403);

  // 4a. Same-project app (no handoff_url): it shares this project's Auth, so just mint a
  //     magic link straight to its landing page. No cross-project token needed.
  if (!app.handoff_url) {
    // Land on the hub origin the person is on when the app is mounted there (mount_path),
    // so they stay inside the one PWA; otherwise the app's own domain.
    const HUBS = new Set(["https://apps.shepherdchurch.co", "https://shepherd-apps-staging.netlify.app"]);
    const from = req.headers.get("origin") ?? "";
    const landing = new URL(HUBS.has(from) && app.mount_path ? `${from}${app.mount_path}/` : app.landing_url);
    if (next !== "/") landing.searchParams.set("next", next);
    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink", email, options: { redirectTo: landing.toString() },
    });
    const actionLink = link?.properties?.action_link;
    if (linkErr || !actionLink) return json({ error: `generate_link: ${linkErr?.message ?? "no_link"}` }, 500);
    return json({ url: actionLink, app: appKey, tags, mode: "same-project" });
  }

  // 4b. Cross-project app: sign the handoff. One secret per target app; the target verifies with the same value.
  const secretName = `HANDOFF_SECRET_${appKey.toUpperCase().replace(/-/g, "_")}`;
  const secret = Deno.env.get(secretName);
  if (!secret) return json({ error: "server_not_configured", secretName }, 500);

  // Which hub origin is the person on? Passed along so the target app lands them back on
  // the same origin (apps.shepherdchurch.co or the staging hub), not its own domain.
  const HUB_ORIGINS = new Set(["https://apps.shepherdchurch.co", "https://shepherd-apps-staging.netlify.app"]);
  const origin = req.headers.get("origin") ?? "";
  const hub = HUB_ORIGINS.has(origin) ? origin : undefined;

  const jti = crypto.randomUUID();
  const token = await new SignJWT({ email, name, tags, app: appKey, next, hub })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("shepherd-hub")
    .setAudience(appKey)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(new TextEncoder().encode(secret));

  const url = `${app.handoff_url}?t=${encodeURIComponent(token)}`;
  return json({ url, app: appKey, tags, expires_in: 60 });
});
