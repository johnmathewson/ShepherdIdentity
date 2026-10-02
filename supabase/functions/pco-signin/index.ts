import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// OAuth sign-in bridge for Shepherd Apps.
// PCO tags discovery: tries multiple endpoints because PCO's tag access
// surface is finicky. Whichever one returns data wins.

const PC_TOKEN_URL = "https://api.planningcenteronline.com/oauth/token";
const PC_PEOPLE_URL = "https://api.planningcenteronline.com/people/v2";
const PC_SERVICES_URL = "https://api.planningcenteronline.com/services/v2";
const REDIRECT_URI = "https://epkuvykamufrrgbacbel.supabase.co/functions/v1/pco-signin";

// Direct destination keys for hub-initiated PCO flows. The `team`,
// `submit`, and `prayer_week` entries route through /hub-handoff so the
// magic-link URL-hash tokens establish a real @supabase/ssr cookie
// session on the prayer wall before forwarding to the page the user wanted.
const DESTINATIONS: Record<string, string> = {
  formation: "https://shepherd-identity-tool.netlify.app/",
  hub: "https://shepherd-apps-hub.netlify.app/",
  hub_custom: "https://apps.shepherdchurch.co/",
  hub_staging: "https://shepherd-apps-staging.netlify.app/",
  team: "https://nwiprays.com/hub-handoff?next=team",
  submit: "https://nwiprays.com/hub-handoff?next=submit",
  prayer_week: "https://nwiprays.com/hub-handoff?next=prayer-week",
};

// Map path-style visitor states (e.g. "visitor:/prayer-week") to the
// right hub-handoff destination so the user lands where they started.
// Any unknown path falls back to /submit (the prayer-wall dashboard
// entry) so we never silently bounce visitors to the Identity Tool.
function visitorDestForPath(path: string): string {
  if (path === "/prayer-week") return DESTINATIONS.prayer_week;
  if (path === "/submit") return DESTINATIONS.submit;
  if (path === "/team") return DESTINATIONS.team;
  // Any other visitor path: send them to the prayer wall's submit page,
  // which is the canonical visitor entry. Better than the Identity Tool.
  return DESTINATIONS.submit;
}

function destUrl(state: string | null): string {
  if (!state) return DESTINATIONS.formation;
  // Direct lookup for hub-initiated keys (formation, hub, hub_custom, team,
  // submit, prayer_week).
  if (DESTINATIONS[state]) return DESTINATIONS[state];
  // Visitor flows: "visitor" alone or "visitor:/some/path". The /login
  // page and /prayer-week modal both send these.
  if (state === "visitor" || state.startsWith("visitor:")) {
    const colonIdx = state.indexOf(":");
    if (colonIdx === -1) return DESTINATIONS.submit;
    const rawPath = state.slice(colonIdx + 1);
    let path = rawPath;
    try { path = decodeURIComponent(rawPath); } catch { /* keep raw */ }
    return visitorDestForPath(path);
  }
  return DESTINATIONS.formation;
}

// Append a query param to a URL safely, regardless of whether the URL already
// has a query string. The previous implementation broke on destinations that
// had embedded query strings (e.g. /hub-handoff?next=team).
function errorRedirect(dest: string, detail: string): Response {
  const sep = dest.includes("?") ? "&" : "?";
  const param = `pco_error=${encodeURIComponent(detail.substring(0, 300))}`;
  return Response.redirect(`${dest}${sep}${param}`, 302);
}

async function fetchJson(url: string, token: string): Promise<{ status: number; body: string; data: unknown }> {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.text();
    let data: unknown = null;
    try { data = JSON.parse(body); } catch { /* leave null */ }
    return { status: res.status, body: body.substring(0, 1500), data };
  } catch (e) {
    return { status: 0, body: `EXC: ${String((e as Error)?.message || e)}`, data: null };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      },
    });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");
  const state = url.searchParams.get("state");
  const destination = destUrl(state);

  if (oauthError) return errorRedirect(destination, `oauth_denied: ${oauthError}`);
  if (!code) return errorRedirect(destination, "no_code_from_planning_center");

  const clientId = Deno.env.get("PLANNING_CENTER_CLIENT_ID");
  const clientSecret = Deno.env.get("PLANNING_CENTER_CLIENT_SECRET");
  if (!clientId || !clientSecret) return errorRedirect(destination, "server_not_configured");

  try {
    // 1. Exchange code for PCO access token.
    const tokenRes = await fetch(PC_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) {
      const body = await tokenRes.text().catch(() => "");
      return errorRedirect(destination, `token_exchange_${tokenRes.status}: ${body.substring(0, 200)}`);
    }
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    const grantedScopes: string = tokenData.scope || "";

    // 2. Fetch the PCO person.
    const meRes = await fetch(`${PC_PEOPLE_URL}/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const meBodyText = await meRes.text();
    if (!meRes.ok) {
      return errorRedirect(destination, `profile_fetch_${meRes.status}: ${meBodyText.substring(0, 200)}`);
    }
    const meData = JSON.parse(meBodyText);
    const person = meData.data;
    const pcId = person.id;
    const firstName = person.attributes?.first_name || "";
    const lastName = person.attributes?.last_name || "";
    const displayName = `${firstName} ${lastName}`.trim() || "Friend";

    // 3. Primary email.
    const emailsRes = await fetch(`${PC_PEOPLE_URL}/people/${pcId}/emails`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const emailsData = await emailsRes.json().catch(() => ({ data: [] }));
    const primaryEmail =
      emailsData.data?.find((e: { attributes?: { primary?: boolean; address?: string } }) => e.attributes?.primary)?.attributes?.address ||
      emailsData.data?.[0]?.attributes?.address ||
      "";
    if (!primaryEmail) return errorRedirect(destination, "no_email_on_planning_center_profile");

    // 4. Discover tags.
    let peopleTags: string[] = [];
    const tryEndpoints = [
      { key: "person_include", url: `${PC_PEOPLE_URL}/people/${pcId}?include=tags` },
      { key: "person_tags", url: `${PC_PEOPLE_URL}/people/${pcId}/tags?per_page=100` },
      { key: "field_data", url: `${PC_PEOPLE_URL}/people/${pcId}/field_data?per_page=100` },
    ];
    const tagDebug: Record<string, { status: number; preview: string }> = {};
    for (const ep of tryEndpoints) {
      const r = await fetchJson(ep.url, accessToken);
      tagDebug[ep.key] = { status: r.status, preview: r.body.substring(0, 400) };
      if (peopleTags.length > 0) continue;
      if (r.status !== 200 || !r.data) continue;
      const d = r.data as { data?: unknown; included?: unknown };
      if (Array.isArray(d.included)) {
        const tagsFromInclude = (d.included as Array<{ type?: string; attributes?: { name?: string } }>)
          .filter((it) => it.type === "Tag")
          .map((it) => it.attributes?.name)
          .filter((n): n is string => !!n);
        if (tagsFromInclude.length > 0) { peopleTags = tagsFromInclude; continue; }
      }
      if (Array.isArray(d.data)) {
        const tagsFromData = (d.data as Array<{ type?: string; attributes?: { name?: string; field_definition_id?: unknown } }>)
          .filter((it) => it.type === "Tag" || (it.attributes && "name" in it.attributes))
          .map((it) => it.attributes?.name)
          .filter((n): n is string => !!n);
        if (tagsFromData.length > 0) { peopleTags = tagsFromData; continue; }
      }
    }

    // 5. Probe the org-level tags endpoint as a sanity check.
    const orgTagsProbe = await fetchJson(`${PC_PEOPLE_URL}/tags?per_page=5`, accessToken);

    // 6. Services API (Position assignment is the canonical truth for the Prayer Wall team).
    let servicesTeamNames: string[] = [];
    let servicesPositionNames: string[] = [];
    let debugServicesStatus = 0;
    let debugServicesBody = "";
    try {
      const servicesUrl =
        `${PC_SERVICES_URL}/people/${pcId}/person_team_position_assignments` +
        `?include=team_position,team&per_page=100`;
      const r = await fetchJson(servicesUrl, accessToken);
      debugServicesStatus = r.status;
      debugServicesBody = r.body;
      if (r.status === 200 && r.data) {
        const svcData = r.data as { included?: unknown };
        const svcIncluded: Array<{ type?: string; attributes?: { name?: string } }> =
          Array.isArray(svcData.included) ? (svcData.included as Array<{ type?: string; attributes?: { name?: string } }>) : [];
        servicesTeamNames = svcIncluded.filter((i) => i.type === "Team").map((t) => t.attributes?.name).filter((n): n is string => !!n);
        servicesPositionNames = svcIncluded.filter((i) => i.type === "TeamPosition").map((t) => t.attributes?.name).filter((n): n is string => !!n);
      }
    } catch (_e) { /* non-fatal */ }

    // 7. Final tag pool + Prayer Wall check.
    const pcoTags: string[] = [...peopleTags, ...servicesTeamNames, ...servicesPositionNames];
    const isPrayerTeam = pcoTags.some((t) => /prayer wall/i.test(t));

    // 8. Supabase admin client.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const { data: listData, error: listErr } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listErr) return errorRedirect(destination, `listUsers: ${listErr.message}`);

    const lowerEmail = primaryEmail.toLowerCase();
    let user = listData.users.find((u: { email?: string | null }) => (u.email || "").toLowerCase() === lowerEmail);

    const metadataPatch = {
      display_name: displayName,
      planning_center_id: pcId,
      pco_tags: pcoTags,
      pco_tags_updated_at: new Date().toISOString(),
      is_prayer_team: isPrayerTeam,
      _debug_granted_scopes: grantedScopes,
      _debug_tag_endpoints: tagDebug,
      _debug_org_tags_probe: { status: orgTagsProbe.status, preview: orgTagsProbe.body.substring(0, 600) },
      _debug_services_status: debugServicesStatus,
      _debug_services_body: debugServicesBody,
      _debug_services_team_names: servicesTeamNames,
      _debug_services_position_names: servicesPositionNames,
      _debug_people_tags: peopleTags,
    };

    if (!user) {
      const { data: created, error: createErr } = await supabase.auth.admin.createUser({
        email: primaryEmail,
        email_confirm: true,
        user_metadata: { ...metadataPatch, created_via: "church_center" },
      });
      if (createErr) return errorRedirect(destination, `createUser: ${createErr.message}`);
      user = created.user!;
    } else {
      const merged = { ...(user.user_metadata || {}), ...metadataPatch };
      await supabase.auth.admin.updateUserById(user.id, { user_metadata: merged });
    }

    // 9. Visitor upsert.
    try {
      const { data: existingVisitor } = await supabase.from("visitors").select("id").eq("auth_user_id", user.id).maybeSingle();
      if (!existingVisitor) {
        await supabase.from("visitors").insert({ auth_user_id: user.id, display_name: displayName, email: primaryEmail, planning_center_id: pcId });
      } else {
        await supabase.from("visitors").update({ display_name: displayName, email: primaryEmail, planning_center_id: pcId }).eq("auth_user_id", user.id);
      }
    } catch (e) { console.error("visitors upsert failed:", e); }

    // 10. Team member upsert.
    if (isPrayerTeam) {
      try {
        const { data: existingMember } = await supabase.from("team_members").select("id").eq("auth_user_id", user.id).maybeSingle();
        if (!existingMember) {
          await supabase.from("team_members").insert({ auth_user_id: user.id, display_name: displayName, email: primaryEmail, planning_center_id: pcId, approved: true, role: "member" });
        } else {
          await supabase.from("team_members").update({ display_name: displayName, email: primaryEmail, planning_center_id: pcId, approved: true }).eq("auth_user_id", user.id);
        }
      } catch (e) { console.error("team_members upsert failed:", e); }
    }

    // 11. Magic link to destination app.
    const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
      type: "magiclink",
      email: primaryEmail,
      options: { redirectTo: destination },
    });
    if (linkErr) return errorRedirect(destination, `generateLink: ${linkErr.message}`);
    const actionLink = linkData?.properties?.action_link;
    if (!actionLink) return errorRedirect(destination, "no_action_link_from_supabase");

    return Response.redirect(actionLink, 302);
  } catch (err) {
    return errorRedirect(destination, `unexpected: ${String((err as Error)?.message || err)}`);
  }
});
