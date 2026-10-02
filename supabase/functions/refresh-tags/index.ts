import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// POST /functions/v1/refresh-tags        (hub session required)
// Re-derives the caller's hub tags from Planning Center Services and upserts
// hub_access. Called by the hub on open. Access model:
//   member of a mapped Services team  → hub_team_tags.tag
//   Team Leader of that team          → hub_team_tags.admin_tag
// Looks the person up by ANY email on their PCO record (not just primary), so
// john@….co and john@….com resolve to the same person.

const PCO = "https://api.planningcenteronline.com";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Rel = { data?: { id?: string; type?: string } | null };
type Resource = { id: string; type: string; attributes?: Record<string, unknown>; relationships?: Record<string, Rel> };
type PcoPage = { data?: Resource[]; included?: Resource[]; links?: { next?: string } };

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
  if (!id || !secret) throw new Error("server_not_configured: PCO_PAT_APP_ID / PCO_PAT_SECRET");
  return { Authorization: `Basic ${btoa(`${id}:${secret}`)}`, Accept: "application/json" };
}

async function pcoGet(url: string): Promise<PcoPage> {
  const res = await pcoFetch(url, { headers: pcoHeaders() });
  if (!res.ok) throw new Error(`pco ${res.status} ${url.replace(PCO, "")}: ${(await res.text()).slice(0, 200)}`);
  return await res.json();
}

async function pcoGetAll(url: string): Promise<Resource[]> {
  const out: Resource[] = [];
  let next: string | undefined = url;
  while (next) {
    const page = await pcoGet(next);
    out.push(...(page.data ?? []));
    next = page.links?.next;
  }
  return out;
}

// Every PCO person id carrying this email address. People often has duplicate
// records for one human (one with the old email, one with the new), so we
// return all of them and let the caller merge.
async function findPersonIdsByEmail(email: string): Promise<string[]> {
  const page = await pcoGet(`${PCO}/people/v2/emails?where[address]=${encodeURIComponent(email)}&per_page=25`);
  const ids = new Set<string>();
  for (const e of page.data ?? []) { const pid = e.relationships?.person?.data?.id; if (pid) ids.add(pid); }
  return [...ids];
}

// Services returns 404 for a person who has never been added to Services.
// That's "no teams", not an error.
async function pcoGetOr404(url: string): Promise<PcoPage | null> {
  const res = await pcoFetch(url, { headers: pcoHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`pco ${res.status} ${url.replace(PCO, "")}: ${(await res.text()).slice(0, 200)}`);
  return await res.json();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const accessToken = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!accessToken) return json({ error: "no_session" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const asUser = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } }, auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await asUser.auth.getUser(accessToken);
  if (userErr || !userData?.user?.email) return json({ error: "invalid_session" }, 401);
  const email = userData.user.email.trim().toLowerCase();

  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    // 1. Mapping + (possibly stale) team cache.
    const { data: mapping } = await admin.from("hub_team_tags").select("*").eq("enabled", true);
    const { data: cached } = await admin.from("hub_pco_teams").select("pco_team_id,name,archived,synced_at").limit(1000);
    const stale = !cached?.length || cached.some((t) => Date.now() - new Date(t.synced_at).getTime() > 24 * 3600 * 1000);
    let teamsById = new Map<string, string>((cached ?? []).map((t) => [t.pco_team_id, t.name]));
    let archived = new Set<string>((cached ?? []).filter((t) => t.archived).map((t) => t.pco_team_id));
    if (stale) {
      const teams = await pcoGetAll(`${PCO}/services/v2/teams?per_page=100`);
      teamsById = new Map(teams.map((t) => [t.id, String(t.attributes?.name ?? "")]));
      archived = new Set(teams.filter((t) => !!t.attributes?.archived_at).map((t) => t.id));
      const rows = teams.map((t) => ({
        pco_team_id: t.id, name: String(t.attributes?.name ?? ""),
        archived: !!t.attributes?.archived_at, synced_at: new Date().toISOString(),
      }));
      if (rows.length) await admin.from("hub_pco_teams").upsert(rows);
    }

    // 2. Who is this in PCO? Always resolve by email (catches newly merged/duplicate records),
    //    and keep any previously stored id in the set too.
    const { data: existing } = await admin.from("hub_access").select("pco_person_id").eq("email", email).maybeSingle();
    const personIds = new Set<string>(await findPersonIdsByEmail(email));
    if (existing?.pco_person_id) personIds.add(existing.pco_person_id);
    if (personIds.size === 0) {
      await admin.from("hub_access").upsert({ email, tags: [], teams: [], source: "pco", pco_synced_at: new Date().toISOString() });
      return json({ email, found_in_pco: false, tags: [], teams: [] });
    }

    // 3. Team memberships (via positions) and team leaderships, merged across every matching record.
    //    NOTE: no `filter=not_archived` — PCO drops live teams under that filter (seen 2026-09-18 with
    //    Prayer Team). Archived teams are excluded via hub_pco_teams.archived instead.
    const memberTeamIds = new Set<string>();
    const leaderTeamIds = new Set<string>();
    const inServices: string[] = [];
    for (const pid of personIds) {
      const assignments = await pcoGetOr404(
        `${PCO}/services/v2/people/${pid}/person_team_position_assignments?include=team_position&per_page=100`,
      );
      if (!assignments) continue;               // this record was never added to Services
      inServices.push(pid);
      for (const inc of assignments.included ?? []) {
        if (inc.type === "TeamPosition") { const tid = inc.relationships?.team?.data?.id; if (tid) memberTeamIds.add(tid); }
      }
      try {
        const leaders = await pcoGetOr404(`${PCO}/services/v2/people/${pid}/team_leaders?per_page=100`);
        for (const l of leaders?.data ?? []) { const tid = l.relationships?.team?.data?.id; if (tid) leaderTeamIds.add(tid); }
      } catch (_e) { /* endpoint shape may differ; membership still works */ }
    }
    // Remember the record that actually lives in Services (falls back to the first match).
    const personId = inServices[0] ?? [...personIds][0];

    // 4. Derive tags from the mapping (case-insensitive name match; remember the id once seen).
    const tags = new Set<string>();
    const teams: Array<{ id: string; name: string; leader: boolean }> = [];
    const allIds = new Set([...memberTeamIds, ...leaderTeamIds]);
    for (const tid of allIds) {
      if (archived.has(tid)) continue;
      const name = teamsById.get(tid) ?? "";
      const leader = leaderTeamIds.has(tid);
      teams.push({ id: tid, name, leader });
      const rule = (mapping ?? []).find((m) => m.pco_team_id === tid || m.pco_team_name.toLowerCase() === name.toLowerCase());
      if (!rule) continue;
      tags.add(rule.tag);
      if (leader && rule.admin_tag) tags.add(rule.admin_tag);
      if (!rule.pco_team_id) await admin.from("hub_team_tags").update({ pco_team_id: tid }).eq("pco_team_name", rule.pco_team_name);
    }

    const row = { email, tags: [...tags], teams, source: "pco", pco_person_id: personId, pco_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    const { error: upErr } = await admin.from("hub_access").upsert(row);
    if (upErr) return json({ error: `hub_access: ${upErr.message}` }, 500);
    return json({ email, found_in_pco: true, pco_person_id: personId, pco_person_ids: [...personIds], in_services: inServices, tags: [...tags], teams });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
