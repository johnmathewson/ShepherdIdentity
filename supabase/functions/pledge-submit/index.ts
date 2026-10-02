// pledge-submit — public: records a new online pledge, emails the signed card.
import {
  admin, clientIp, cleanPledge, cleanSignature, corsHeaders, HttpError, json,
  hashToken, newRefCode, newToken, rateLimit, readJson, safePledge, sendPledgeEmail, logRevision,
} from "./shared.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, req);
  const sb = admin();
  try {
    const body = await readJson(req);
    const ip = clientIp(req);

    // Honeypot: bots fill the hidden "website" field. Pretend it worked.
    if (typeof body.website === "string" && body.website.trim()) {
      return json({ ok: true, pledge: { ref_code: "MR-THANKS", donor_name: body.donor_name, email: body.email, amount_total: 0, term_years: 5, frequency: "monthly" }, token: "x" }, 200, req);
    }

    await rateLimit(sb, `submit:${ip}`, 5, 3600);

    const p = cleanPledge(body, { requireEmail: true });
    const sig = cleanSignature(body);
    const token = newToken();
    const row = {
      ...p, ...sig,
      ref_code: await newRefCode(sb),
      status: "active", source: "online",
      signed_at: new Date().toISOString(),
      signed_ip: ip,
      signed_user_agent: (req.headers.get("user-agent") || "").slice(0, 300),
      manage_token_hash: await hashToken(token),
    };
    const { data, error } = await sb.from("pledges").insert(row).select("*").single();
    if (error) throw new HttpError(500, "Could not save your pledge. Please try again.");

    await logRevision(sb, data.id, `donor:${data.email}`, "created", null, data);
    const mail = await sendPledgeEmail(sb, "confirm", data, token, { attachCard: true });

    return json({ ok: true, pledge: safePledge(data), token, email_sent: mail.ok }, 200, req);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error("pledge-submit", e);
    return json({ error: e instanceof HttpError ? e.message : "Something went wrong. Please try again." }, status, req);
  }
});
