// pledge-manage — donor self-service via the private token from their email.
// Actions: get · update · withdraw · restore · resend_link
import {
  admin, clientIp, cleanPledge, cleanSignature, COMMITMENT_FIELDS, corsHeaders, HttpError, json,
  hashToken, newToken, rateLimit, readJson, safePledge, sendPledgeEmail, logRevision,
} from "./shared.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, req);
  const sb = admin();
  try {
    const body = await readJson(req);
    const action = String(body.action || "");
    const ip = clientIp(req);

    if (action === "resend_link") {
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Please enter a valid email.");
      await rateLimit(sb, `resend:${ip}`, 5, 900);
      const { data: rows } = await sb.from("pledges").select("*").eq("email_lower", email).neq("status", "void").order("created_at", { ascending: false });
      for (const p of rows || []) {
        const token = newToken();
        await sb.from("pledges").update({ manage_token_hash: await hashToken(token) }).eq("id", p.id);
        await sendPledgeEmail(sb, "link", p, token);
      }
      return json({ ok: true }, 200, req);
    }

    const token = String(body.token || "");
    if (!token) throw new HttpError(400, "Missing link token.");
    await rateLimit(sb, `manage:${ip}`, 60, 900);
    const { data: p } = await sb.from("pledges").select("*").eq("manage_token_hash", await hashToken(token)).maybeSingle();
    if (!p) throw new HttpError(404, "That link is no longer valid.");
    if (p.status === "void") throw new HttpError(404, "That pledge is no longer available. Please contact the church.");
    const actor = `donor:${p.email || p.id}`;

    if (action === "get") return json({ ok: true, pledge: safePledge(p) }, 200, req);

    if (action === "update") {
      if (p.status !== "active") throw new HttpError(400, "Restore the pledge before editing it.");
      const next = cleanPledge({ ...p, ...body }, { requireEmail: true });
      const changed = COMMITMENT_FIELDS.some((k) => String((next as any)[k]) !== String(p[k]));
      const patch: Record<string, unknown> = { ...next };
      if (changed) {
        Object.assign(patch, cleanSignature(body), {
          signed_at: new Date().toISOString(), signed_ip: ip,
          signed_user_agent: (req.headers.get("user-agent") || "").slice(0, 300),
        });
      }
      // A commitment change rotates the private link: the old URL stops working and the donor gets a fresh one.
      let nextToken = token;
      if (changed) { nextToken = newToken(); patch.manage_token_hash = await hashToken(nextToken); }
      const { data, error } = await sb.from("pledges").update(patch).eq("id", p.id).select("*").single();
      if (error) throw new HttpError(500, "Could not save changes.");
      await logRevision(sb, p.id, actor, changed ? "updated_commitment" : "updated_contact", p, data);
      await sendPledgeEmail(sb, "updated", data, nextToken, { attachCard: true });
      return json({ ok: true, pledge: safePledge(data), token: nextToken !== token ? nextToken : undefined }, 200, req);
    }

    if (action === "withdraw" || action === "restore") {
      const status = action === "withdraw" ? "withdrawn" : "active";
      const { data, error } = await sb.from("pledges").update({ status }).eq("id", p.id).select("*").single();
      if (error) throw new HttpError(500, "Could not update the pledge.");
      await logRevision(sb, p.id, actor, action, { status: p.status }, { status });
      if (action === "withdraw") await sendPledgeEmail(sb, "withdrawn", data, token);
      return json({ ok: true, pledge: safePledge(data) }, 200, req);
    }

    throw new HttpError(400, "Unknown action.");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error("pledge-manage", e);
    return json({ error: e instanceof HttpError ? e.message : "Something went wrong. Please try again." }, status, req);
  }
});
