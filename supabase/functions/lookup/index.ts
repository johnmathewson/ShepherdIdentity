import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// POST /functions/v1/lookup  { email }        (PUBLIC — no session yet)
// The email gate. Is this address a Planning Center person? If yes, the hub
// shows "Found you" (+ mapped team names, if any) and offers Sign in with
// Planning Center. If no, the hub sends a code. Never says "no such person"
// in a way that differs from "public person". Rate-limited per IP.

const PCO = "https://api.planningcenteronline.com";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Rel = { data?: { id?: string } | null };
type Resource = { id: string; type: string; attributes?: Record<string, unknown>; relationships?: Record<string, Rel> };
type PcoPage = { data?: Resource[]; included?: Resource[] };

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
function pcoHeaders(): HeadersInit {
  const id = Deno.env.get("PCO_PAT_APP_ID"), secret = Deno.env.get("PCO_PAT_SECRET");
  if (!id || !secret) throw new Error("server_not_configured");
  return { Authorization: `Basic ${btoa(`${id}:${secret}`)}`, Accept: "application/json" };
}
async function pcoGetOr404(url: string): Promise<PcoPage | null> {
  const res = await pcoFetch(url, { headers: pcoHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`pco ${res.status}`);
  return await res.json();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: { email?: string } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const email = (body.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "invalid_email" }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Rate limit per IP: high enough for a whole building on one Wi-Fi address signing in on a
  // Sunday morning, low enough to blunt enumeration (each lookup is ~4 PCO calls).
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count } = await admin.from("hub_lookup_log").select("id", { count: "exact", head: true }).eq("ip", ip).gte("at", since);
  if ((count ?? 0) >= 300) return json({ error: "slow_down" }, 429);
  await admin.from("hub_lookup_log").insert({ ip, email });

  try {
    const { data: mapping } = await admin.from("hub_team_tags").select("pco_team_name,pco_team_id,tag").eq("enabled", true);
    const { data: teamsCache } = await admin.from("hub_pco_teams").select("pco_team_id,name,archived").limit(1000);
    const teamName = new Map((teamsCache ?? []).map((t) => [t.pco_team_id, t.name]));
    const archived = new Set((teamsCache ?? []).filter((t) => t.archived).map((t) => t.pco_team_id));

    // Every People record carrying this address (duplicates are common).
    const emails = await pcoGetOr404(`${PCO}/people/v2/emails?where[address]=${encodeURIComponent(email)}&per_page=25`);
    const personIds = new Set<string>();
    for (const e of emails?.data ?? []) { const pid = e.relationships?.person?.data?.id; if (pid) personIds.add(pid); }
    // Which mapped teams do they hold, across all records? Remember which records live in Services.
    const heldTeams = new Set<string>();
    const positions = new Map<string, number>();   // pid → how many team positions it holds
    for (const pid of personIds) {
      const a = await pcoGetOr404(`${PCO}/services/v2/people/${pid}/person_team_position_assignments?include=team_position&per_page=100`);
      positions.set(pid, a ? (a.data ?? []).length : -1);
      const teamIds = new Set<string>();
      for (const inc of a?.included ?? []) {
        const tid = inc.type === "TeamPosition" ? inc.relationships?.team?.data?.id : undefined;
        if (tid) teamIds.add(tid);
      }
      // Team Leaders count as members too (a leader may hold no position).
      if (a) {
        try {
          const l = await pcoGetOr404(`${PCO}/services/v2/people/${pid}/team_leaders?per_page=100`);
          for (const x of l?.data ?? []) { const tid = x.relationships?.team?.data?.id; if (tid) teamIds.add(tid); }
        } catch (_e) { /* non-fatal */ }
      }
      for (const tid of teamIds) {
        if (archived.has(tid)) continue;
        const name = teamName.get(tid) ?? "";
        const rule = (mapping ?? []).find((m) => m.pco_team_id === tid || m.pco_team_name.toLowerCase() === name.toLowerCase());
        if (rule) heldTeams.add(rule.pco_team_name);
      }
    }

    // First name: prefer the record that actually serves (most team positions) — duplicates and
    // shared admin accounts carry the same email but no positions.
    let firstName = "";
    const byActivity = [...personIds].sort((x, y) => (positions.get(y) ?? -1) - (positions.get(x) ?? -1));
    for (const pid of byActivity) {
      const person = await pcoGetOr404(`${PCO}/people/v2/people/${pid}`);
      const fn = String((person?.data as unknown as Resource | undefined)?.attributes?.first_name ?? "");
      if (fn) { firstName = fn; break; }
    }

    // Anyone in Planning Center can use it to sign in; teams only decide what unlocks later.
    // Someone not in PCO gets the same shape as a public person: { found: false }.
    const found = personIds.size > 0;
    return json(found ? { found: true, team: heldTeams.size > 0, first_name: firstName, teams: [...heldTeams] } : { found: false, team: false });
  } catch (e) {
    // On PCO trouble, fall back to the public path rather than blocking sign-in.
    return json({ found: false, team: false, degraded: String((e as Error)?.message ?? e).slice(0, 80) });
  }
});
