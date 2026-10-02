import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SignJWT } from "https://esm.sh/jose@5.9.6";

// POST /functions/v1/status        (hub session required)
// Everything the home screen shows beyond the tiles, in one call:
//   sunday  — the person's upcoming Planning Center Services assignments (confirm/decline state)
//   apps    — per-app counts from each app's hub-status function (badges, "Needs you" rows)
// Each app is asked with a 60-second token signed with that app's handoff secret and
// audience "<app>:status" — the same trust relationship as sign-in, but a token that can
// only read counts. Apps are queried in parallel and any one failing just returns nothing.

const PCO = "https://api.planningcenteronline.com";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, apikey, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// Planning Center allows ~100 requests / 20 s per token. A Sunday-morning burst of sign-ins
// can trip that; honour Retry-After and try again rather than fail the person's sign-in.
async function pcoFetch(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 || attempt >= 3) return res;
    const wait = Math.min(5000, (parseFloat(res.headers.get("Retry-After") ?? "1") || 1) * 1000);
    await new Promise((r) => setTimeout(r, wait));
  }
}
type Sched = { id: string; attributes?: Record<string, unknown> };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const accessToken = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!accessToken) return json({ error: "no_session" }, 401);
  const url = Deno.env.get("SUPABASE_URL")!;
  const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: `Bearer ${accessToken}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: u } = await asUser.auth.getUser(accessToken);
  const email = (u?.user?.email ?? "").toLowerCase();
  if (!email) return json({ error: "invalid_session" }, 401);

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: access } = await admin.from("hub_access").select("tags, pco_person_id").eq("email", email).maybeSingle();
  const tags: string[] = access?.tags ?? [];
  const personId: string | null = access?.pco_person_id ?? null;

  // --- Planning Center: upcoming schedules ---------------------------------------------
  const sundayP = (async () => {
    if (!personId) return null;
    const id = Deno.env.get("PCO_PAT_APP_ID"), secret = Deno.env.get("PCO_PAT_SECRET");
    if (!id || !secret) return null;
    const res = await pcoFetch(`${PCO}/services/v2/people/${personId}/schedules?filter=future&per_page=25&order=sort_date`, {
      headers: { Authorization: `Basic ${btoa(`${id}:${secret}`)}` },
    });
    if (!res.ok) return null;
    const body = await res.json() as { data?: Sched[] };
    const items = (body.data ?? []).map((s) => {
      const a = s.attributes ?? {};
      return {
        id: s.id, when: a.sort_date as string, dates: a.short_dates as string,
        team: a.team_name as string, position: a.team_position_name as string, service: a.service_type_name as string,
        status: a.status === "C" ? "confirmed" : a.status === "D" ? "declined" : "unconfirmed",
        times: a.position_display_times as string,
      };
    }).filter((x) => x.status !== "declined");
    // The next service day (all assignments on that date) + anything unconfirmed after it.
    const first = items[0]?.when?.slice(0, 10);
    const next = first ? items.filter((x) => x.when?.slice(0, 10) === first) : [];
    const laterUnconfirmed = items.filter((x) => x.when?.slice(0, 10) !== first && x.status === "unconfirmed");
    return { next, later_unconfirmed: laterUnconfirmed.length, unconfirmed_total: items.filter((x) => x.status === "unconfirmed").length };
  })().catch(() => null);

  // --- Apps: fan out to each app's hub-status --------------------------------------------
  const { data: apps } = await admin.from("hub_apps").select("key, status_url, required_tags").eq("enabled", true).not("status_url", "is", null);
  const appPs = (apps ?? []).map(async (app) => {
    const required: string[] = app.required_tags ?? [];
    if (required.length && !required.some((t) => tags.includes(t))) return [app.key, null] as const;
    const secret = Deno.env.get(`HANDOFF_SECRET_${app.key.toUpperCase().replace(/-/g, "_")}`);
    if (!secret) return [app.key, null] as const;
    const token = await new SignJWT({ email, tags }).setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("shepherd-hub").setAudience(`${app.key}:status`).setIssuedAt().setExpirationTime("60s")
      .sign(new TextEncoder().encode(secret));
    try {
      const r = await fetch(`${app.status_url}?t=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(4000) });
      return [app.key, r.ok ? await r.json() : null] as const;
    } catch { return [app.key, null] as const; }
  });

  const [sunday, ...appResults] = await Promise.all([sundayP, ...appPs]);
  return json({ sunday, apps: Object.fromEntries(appResults) });
});
