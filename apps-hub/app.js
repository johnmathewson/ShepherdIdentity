/* Shepherd Apps hub — sign-in flow + home. Plain JS, no build step.
   Identity lives on the Identity Tool Supabase project; tags come from
   Planning Center Services teams via refresh-tags; other apps are entered
   through /handoff (cross-project SSO) or a same-project magic link. */

const HUB_URL  = "https://epkuvykamufrrgbacbel.supabase.co";
const HUB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVwa3V2eWthbXVmcnJnYmFjYmVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2NzQ4NzIsImV4cCI6MjA4OTI1MDg3Mn0.EBKnKeOzNcZGbzpQIX7Uzz76j780XQ9N8sCNBJyojeE";
const PCO_CLIENT_ID = "b108ec172f700a7830451d2548f16a6afe1a6979f901755ad252783686857ec1";
const PCO_STATE = location.hostname === "apps.shepherdchurch.co" ? "hub_custom" : "hub_staging";
const CHURCH_CENTER = "https://shepherd-church-nwi.churchcenter.com";
const RETURNING_AFTER_DAYS = 30;

// ---- catalog -------------------------------------------------------------
const ICONS = {
  worship: '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  gfj: '<svg viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><circle cx="12" cy="12" r="4"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 21c-4.5-3.6-8-6.7-8-10.5A4.5 4.5 0 0 1 12 8a4.5 4.5 0 0 1 8 2.5c0 3.8-3.5 6.9-8 10.5z"/></svg>',
  calendar: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4M8 14h3M13 14h3M8 18h3"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 2l8 3v6c0 5-3.4 9-8 11-4.6-2-8-6-8-11V5l8-3z"/><path d="M9 12l2 2 4-4"/></svg>',
  people: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><circle cx="17" cy="9" r="2.5"/><path d="M2.5 20c.5-4 3.3-6 6.5-6s6 2 6.5 6M15.5 14.5c2.8 0 5 1.6 5.5 5"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path d="M4 19V6a2 2 0 0 1 2-2h5v17H6a2 2 0 0 1-2-2z"/><path d="M20 19V6a2 2 0 0 0-2-2h-5v17h5a2 2 0 0 0 2-2z"/></svg>',
  pen: '<svg viewBox="0 0 24 24"><path d="M4 20l4-1 10-10-3-3L5 16l-1 4z"/><path d="M13 7l3 3"/></svg>',
  compass: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.2L4 20l.9-4.6A8 8 0 1 1 21 12z"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M3 12l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/></svg>',
  groups: '<svg viewBox="0 0 24 24"><circle cx="8" cy="9" r="3"/><circle cx="16" cy="9" r="3"/><path d="M2 20c.5-3.5 3-5.5 6-5.5s5.5 2 6 5.5M12 20c.5-3.5 3-5.5 6-5.5"/></svg>',
  services: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>',
  events: '<svg viewBox="0 0 24 24"><path d="M4 21V9l8-6 8 6v12"/><path d="M9 21v-7h6v7"/></svg>',
  reg: '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h3v16H5V5h3l1-2z"/><path d="M9 12l2 2 4-4"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12l4 4L19 6"/></svg>',
};

// Team tiles: shown when the person holds `tag`; `admin` adds the chip.
// `open` is how the tile gets in: {handoff:{app,next}} | {href} | null (not built yet).
const TEAM_APPS = [
  { key: "worship",    name: "Worship",       sub: "Set lists, charts, rehearsals",     icon: "worship",  tag: "#worship",     admin: "#worshipadmin",     open: null },
  { key: "gfj",        name: "Go Find Jesus", sub: "Freedom sessions · chairs · video", icon: "gfj",      tag: "#gofindjesus", admin: "#gofindjesusadmin", open: { handoff: { app: "gfj", next: "/" } } },
  { key: "prayerteam", name: "Prayer Team",   sub: "Requests waiting for pickup",       icon: "heart",    tag: "#prayerteam",                              open: { handoff: { app: "prayer-wall", next: "/requests" } } },
  { key: "prayerroom", name: "Prayer Room",   sub: "Book time in the room",             icon: "calendar", tag: "#prayerteam",                              open: { handoff: { app: "prayer-wall", next: "/room" } } },
  { key: "safety",     name: "Safety",        sub: "Rosters, check-ins, incident log",  icon: "shield",   tag: "#safety",                                  open: null },
  { key: "flock",      name: "The Flock",     sub: "Care & follow-up list",             icon: "people",   tag: "#flock",       admin: "#flockadmin",       open: { handoff: { app: "care", next: "/" } } },
  { key: "fold",       name: "The Fold",      sub: "Teaching guide & student hub",      icon: "book",     tag: "#thefold",                                 open: { href: "https://hub.thefoldnwi.com/" } },
];
const PUBLIC_APPS = [
  { key: "assessment", name: "Prayer Assessment", sub: "Find your prayer language",        icon: "pen",     open: { href: "https://shepherd-prayer-assessment.netlify.app/" } },
  { key: "formation",  name: "Formation",         sub: "Know who you are · identity card", icon: "compass", open: { handoff: { app: "formation", next: "/" } } },
  { key: "request",    name: "Prayer Request",    sub: "Send one to the team",             icon: "chat",    open: { handoff: { app: "prayer-wall", next: "/requests/new" } } },
  { key: "pledge",     name: "The Pledge",        sub: "Building campaign",                icon: "home",    open: { href: "https://pledge.shepherdchurch.co/" } },
];
const CHURCH_CENTER_LINKS = [
  ["Giving", "heart", "/giving"], ["Groups", "groups", "/groups"], ["Services", "services", "/services"],
  ["Events", "events", "/calendar"], ["Registration", "reg", "/registrations"], ["Check-in", "check", "/check-ins"],
];

// ---- helpers --------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const sb = supabase.createClient(HUB_URL, HUB_ANON);
const SCREENS = ["s-returning", "s-email", "s-found", "s-code", "s-landing", "s-home"];
function show(id) { SCREENS.forEach((s) => { $(s).hidden = s !== id; }); window.scrollTo(0, 0); }
function initials(name, email) { const n = (name || "").trim(); if (n) return n.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase(); return (email || "?")[0].toUpperCase(); }
function firstName(name, email) { const n = (name || "").trim(); return n ? n.split(/\s+/)[0] : (email || "").split("@")[0]; }
function greeting() { const h = new Date().getHours(); return h < 12 ? "Good morning," : h < 17 ? "Good afternoon," : "Good evening,"; }
function fnUrl(name) { return `${HUB_URL}/functions/v1/${name}`; }
async function callFn(name, body, token) {
  const headers = { "Content-Type": "application/json", apikey: HUB_ANON };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(fnUrl(name), { method: "POST", headers, body: JSON.stringify(body || {}) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${name} ${res.status}`);
  return json;
}
function showErr(id, msg) { const el = $(id); el.textContent = msg; el.hidden = !msg; }

// ---- deep links ------------------------------------------------------------
// /?next=/prayer/requests  → after sign-in, hand off into that app at that path.
// Mounted apps live at /<prefix>/ on this origin (HUB.md §9b); the prefix picks the app.
const MOUNTS = { "/prayer": "prayer-wall", "/gfj": "gfj", "/care": "care", "/formation": "formation" };
(function captureNext() {
  const n = new URLSearchParams(location.search).get("next");
  if (n && n.startsWith("/") && !n.startsWith("//")) sessionStorage.setItem("hub-next", n);
})();
function takeNext() {
  const n = sessionStorage.getItem("hub-next"); if (!n) return null;
  sessionStorage.removeItem("hub-next");
  const prefix = Object.keys(MOUNTS).find((p) => n === p || n.startsWith(p + "/"));
  return prefix ? { app: MOUNTS[prefix], next: n.slice(prefix.length) || "/" } : null;
}

// ---- state ----------------------------------------------------------------
let pendingEmail = sessionStorage.getItem("hub-email") || "";
let lookupResult = null;
let access = { tags: [], teams: [], synced: null, source: null };
let status = { sunday: null, apps: {} };   // from /status: PCO schedules + per-app counts

// ---- sign-in: email ----------------------------------------------------------
$("f-email").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("email").value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showErr("email-err", "That doesn't look like an email address.");
  showErr("email-err", "");
  $("email-go").disabled = true; $("email-go").textContent = "One sec…";
  pendingEmail = email; sessionStorage.setItem("hub-email", email);
  try {
    lookupResult = await callFn("lookup", { email });
  } catch { lookupResult = { found: false, team: false }; }
  $("email-go").disabled = false; $("email-go").textContent = "Continue";
  if (lookupResult.found) renderFound(); else await sendCode();
});

function pcoAuthUrl() {
  const auth = new URL("https://api.planningcenteronline.com/oauth/authorize");
  auth.searchParams.set("client_id", PCO_CLIENT_ID);
  auth.searchParams.set("redirect_uri", fnUrl("pco-signin"));
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", "people services");
  auth.searchParams.set("state", PCO_STATE);
  return auth.toString();
}
function renderFound() {
  const r = lookupResult;
  const first = r.first_name || firstName("", pendingEmail);
  $("found-first").textContent = first + ".";
  const n = (r.teams || []).length;
  $("found-sub").textContent = n
    ? `You're on ${n} team${n === 1 ? "" : "s"}. Sign in with Planning Center to unlock ${n === 1 ? "it" : "them"}.`
    : "You're in Planning Center — sign in with it and you're done.";
  $("found-av").textContent = initials(first, pendingEmail);
  $("found-name").textContent = first;
  $("found-email").textContent = `${pendingEmail} · Planning Center`;
  $("found-chips").innerHTML = (r.teams || []).map((t) => `<i>${t}</i>`).join("");
  $("pco-go").href = pcoAuthUrl();
  show("s-found");
}
$("found-code").onclick = () => sendCode();
$("found-back").onclick = () => { $("email").value = ""; show("s-email"); };

// ---- sign-in: code -------------------------------------------------------------
let resendAt = 0, resendTimer = null;
const RESEND_SECS = 60;   // matches Supabase's "minimum interval per user"
async function sendCode() {
  const { error } = await sb.auth.signInWithOtp({ email: pendingEmail, options: { shouldCreateUser: true, emailRedirectTo: location.origin + "/" } });
  if (error) {
    // Supabase refuses a second email within the per-user interval. The first one is on
    // its way — say so instead of failing silently, and let them type it.
    const rate = /rate limit|over_email_send/i.test(error.message || "") || error.status === 429;
    if (!rate) { show("s-email"); return showErr("email-err", error.message); }
    $("code-email").textContent = pendingEmail; $("code-pco").href = pcoAuthUrl();
    show("s-code"); showErr("code-err", "We already sent a code a moment ago — check your email (and spam). You can ask for another in a minute.");
    resendAt = Date.now() + RESEND_SECS * 1000; tickResend(); codeEl.focus();
    return;
  }
  $("code-email").textContent = pendingEmail;
  $("code-pco").href = pcoAuthUrl();
  codeEl.value = "";
  showErr("code-err", "");
  show("s-code");
  codeEl.focus();
  resendAt = Date.now() + RESEND_SECS * 1000; tickResend();
}
function tickResend() {
  clearInterval(resendTimer);
  const el = $("resend");
  resendTimer = setInterval(() => {
    const left = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
    if (left > 0) { el.textContent = `Resend in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`; el.style.cursor = "default"; }
    else { el.textContent = "Resend code"; el.style.cursor = "pointer"; clearInterval(resendTimer); }
  }, 250);
}
$("resend").onclick = () => { if (Date.now() >= resendAt) sendCode(); };
// One field, not six boxes: Supabase's code length is a project setting (this project has
// used 8), and iOS autofill pastes the whole thing. Accept 6-8 digits; submit on the 8th
// automatically, or on Enter/Sign in for shorter codes.
const codeEl = $("code");
codeEl.addEventListener("input", () => {
  codeEl.value = codeEl.value.replace(/\D/g, "").slice(0, 8);
  if (codeEl.value.length === 8) $("f-code").requestSubmit();
});
$("f-code").addEventListener("submit", async (e) => {
  e.preventDefault();
  const token = codeEl.value.trim();
  if (token.length < 6) return showErr("code-err", "Enter the whole code from the email.");
  $("code-go").disabled = true; $("code-go").textContent = "Signing you in…";
  const { error } = await sb.auth.verifyOtp({ email: pendingEmail, token, type: "email" });
  $("code-go").disabled = false; $("code-go").textContent = "Sign in";
  if (error) return showErr("code-err", "That code didn't work. Check the newest email, or resend.");
  // onAuthStateChange → landing
});
$("code-back").onclick = () => show("s-email");

// ---- landing → home ---------------------------------------------------------
async function land(session) {
  show("s-landing");
  try {
    const r = await callFn("refresh-tags", {}, session.access_token);
    access = { tags: r.tags || [], teams: r.teams || [], synced: new Date(), source: r.found_in_pco ? "pco" : "none" };
  } catch (e) {
    // PCO hiccup: fall back to whatever the hub already knows.
    const { data } = await sb.from("hub_access").select("tags,teams,pco_synced_at,source").eq("email", session.user.email.toLowerCase()).maybeSingle();
    access = { tags: data?.tags || [], teams: data?.teams || [], synced: data?.pco_synced_at ? new Date(data.pco_synced_at) : null, source: data?.source || null };
  }
  const pending = takeNext();
  if (pending) {
    $("landing-sub").textContent = "Opening where you left off…";
    try { const r = await callFn("handoff", pending, session.access_token); location.href = r.url; return; }
    catch (_e) { /* fall through to home */ }
  }
  renderHome(session);
}

// ---- home -----------------------------------------------------------------------
function tile(app, lit) {
  const isTeam = !!app.tag;
  const admin = isTeam && app.admin && access.tags.includes(app.admin);
  // Unbuilt apps always say "Coming soon", even for admins; the Admin chip only means something once the app exists.
  const badge = !app.open ? `<span class="soon">Coming soon</span>` : (admin ? `<span class="chip">Admin</span>` : "");
  return `<button class="tile" type="button" data-key="${app.key}" data-tags="${[app.tag, app.admin].filter(Boolean).join(" ")}" ${app.open ? "" : "disabled"}>
    ${badge}<span class="ic">${ICONS[app.icon]}</span><div><b>${app.name}</b><span>${app.sub}</span></div></button>`;
}
function renderHome(session) {
  const u = session.user;
  const name = u.user_metadata?.display_name || (lookupResult?.first_name ? lookupResult.first_name : "");
  const via = u.user_metadata?.planning_center_id ? "via Planning Center" : "via email code";
  $("me-name").textContent = name || u.email; $("me-via").textContent = via; $("me-av").textContent = initials(name, u.email);
  $("greet").textContent = greeting(); $("first").textContent = firstName(name, u.email) + ".";
  $("home-date").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }).replace(",", " ·");

  const myTeamApps = TEAM_APPS.filter((a) => access.tags.includes(a.tag));
  $("sec-team").hidden = myTeamApps.length === 0;
  $("serve").hidden = myTeamApps.length > 0;
  $("team-grid").innerHTML = myTeamApps.map((a) => tile(a)).join("");
  $("team-count").textContent = `${myTeamApps.length} tool${myTeamApps.length === 1 ? "" : "s"}`;
  const teamNames = access.teams.filter((t) => t.name).map((t) => t.name);
  $("home-sub").textContent = myTeamApps.length
    ? `You serve on ${teamNames.length} team${teamNames.length === 1 ? "" : "s"}${teamNames.length ? " — " + teamNames.join(", ") : ""}.`
    : "Everything here is open to you.";
  $("public-grid").innerHTML = PUBLIC_APPS.map((a) => tile(a)).join("");
  $("cc-grid").innerHTML = CHURCH_CENTER_LINKS.map(([n, ic, p]) => `<a href="${CHURCH_CENTER}${p}" target="_blank" rel="noopener">${ICONS[ic]}${n}</a>`).join("");

  // access drawer
  $("access-sub").textContent = access.tags.length ? `· ${access.tags.length} tag${access.tags.length === 1 ? "" : "s"} from Planning Center` : (via === "via Planning Center" ? "· no team tags" : "· email sign-in, no team tags");
  $("tags").innerHTML = access.tags.map((t) => `<code role="button" tabindex="0" aria-pressed="false">${t}</code>`).join("");
  $("access-hint").hidden = access.tags.length === 0;
  $("access-copy").textContent = access.tags.length
    ? "Tags come from your Planning Center teams and refresh every time you open this page. If something's missing, ask your team lead to add you to the team — it shows up here on your next visit."
    : `You're signed in as ${u.email}. Team tools appear once you're on a serve team in Planning Center — nothing to set up on your end.`;
  $("synced").textContent = access.synced ? `Last checked ${relTime(access.synced)}` : "Not checked yet";

  $("serve-pco").href = pcoAuthUrl();
  $("serve-join").href = `${CHURCH_CENTER}/people/forms`;

  try { $("install").hidden = !!localStorage.getItem("hub-install-dismissed") || window.matchMedia("(display-mode: standalone)").matches; } catch { $("install").hidden = true; }
  show("s-home");
  loadStatus(session);
}

// ---- status: This Sunday, Needs you, badges ------------------------------------
async function loadStatus(session) {
  try { status = await callFn("status", {}, session.access_token); } catch { status = { sunday: null, apps: {} }; }
  renderSunday(); renderNeeds(); renderBadges();
}
// PCO's sort_date is the church's LOCAL wall-clock time with a misleading "Z" suffix
// ("2026-09-20T10:30:00Z" means 10:30 AM Central). Never let the browser convert it —
// read the pieces as-is. Times come from position_display_times, already formatted by PCO.
function wallClock(iso) { const [y, m, d, hh, mm] = iso.match(/\d+/g).map(Number); return new Date(y, m - 1, d, hh || 0, mm || 0); }
function fmtDay(iso) { const d = wallClock(iso); const today = new Date(); const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
  const day = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  return diff === 0 ? `Today · ${day}` : diff === 1 ? `Tomorrow · ${day}` : diff < 7 ? `This ${d.toLocaleDateString(undefined, { weekday: "long" })} · ${day.split(", ").slice(1).join(", ")}` : day; }
function fmtTime(iso) { const d = wallClock(iso); return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).replace(":00", "").replace(" ", "").toLowerCase(); }
function renderSunday() {
  const s = status.sunday; const box = $("sunday");
  if (!s || !s.next?.length) { box.hidden = true; return; }
  const first = s.next[0];
  const pending = s.next.filter((x) => x.status === "unconfirmed").length;
  $("sunday-k").textContent = fmtDay(first.when);
  $("sunday-time").textContent = first.times || fmtTime(first.when);
  $("sunday-sub").textContent = `${first.service || "Service"} · you're on ${s.next.length === 1 ? "once" : s.next.length + " times"}`;
  $("sunday-rows").innerHTML = s.next.map((x) => `<div><span class="wh"><b>${x.team}${x.position ? " · " + x.position : ""}</b><span>${x.times || x.dates || ""}</span></span><span class="st ${x.status === "confirmed" ? "ok" : "pend"}">${x.status === "confirmed" ? "Set" : "Confirm"}</span></div>`).join("");
  const more = s.unconfirmed_total - pending;
  $("sunday-cta").textContent = pending ? `Confirm in Planning Center${more > 0 ? ` (+${more} more)` : ""}` : (more > 0 ? `${more} later date${more === 1 ? "" : "s"} to confirm` : "");
  $("sunday-cta").href = `${CHURCH_CENTER}/services`;
  $("sunday-cta").parentElement.hidden = !(pending || more > 0);
  box.hidden = false;
}
function needsRows() {
  const rows = [];
  const pw = status.apps?.["prayer-wall"];
  if (pw?.prayerteam?.awaiting) rows.push({ key: "prayerteam", title: `${pw.prayerteam.awaiting} prayer request${pw.prayerteam.awaiting === 1 ? "" : "s"} waiting for pickup`, sub: `Prayer Team${pw.prayerteam.oldest_days ? ` · oldest is ${pw.prayerteam.oldest_days} day${pw.prayerteam.oldest_days === 1 ? "" : "s"}` : " · just came in"}`, go: "Open" });
  const care = status.apps?.care;
  if (care?.flock?.new_visitors) rows.push({ key: "flock", title: `${care.flock.new_visitors} new visitor${care.flock.new_visitors === 1 ? "" : "s"} to welcome`, sub: "The Flock", go: "Open" });
  return rows;
}
function renderNeeds() {
  const rows = needsRows(); const sec = $("sec-needs");
  sec.hidden = rows.length === 0; if (!rows.length) return;
  $("needs-count").textContent = String(rows.length);
  $("needs-rows").innerHTML = rows.map((r) => `<button type="button" data-open="${r.key}"><div class="t"><b>${r.title}</b><span>${r.sub}</span></div><span class="go">${r.go}</span></button>`).join("");
}
function renderBadges() {
  const counts = { prayerteam: status.apps?.["prayer-wall"]?.prayerteam?.awaiting || 0, flock: status.apps?.care?.flock?.new_visitors || 0 };
  document.querySelectorAll(".tile .n").forEach((n) => n.remove());
  for (const [key, n] of Object.entries(counts)) {
    const t = document.querySelector(`.tile[data-key="${key}"]`); if (!t || !n) continue;
    const b = document.createElement("span"); b.className = "n"; b.textContent = n > 99 ? "99+" : String(n); t.prepend(b);
  }
}
document.addEventListener("click", (e) => {
  const r = e.target.closest("[data-open]"); if (!r) return;
  document.querySelector(`.tile[data-key="${r.dataset.open}"]`)?.click();
});
function relTime(d) { const s = Math.round((Date.now() - d.getTime()) / 1000); if (s < 60) return "just now"; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`; return d.toLocaleDateString(); }

// tile taps
document.addEventListener("click", async (e) => {
  const t = e.target.closest(".tile[data-key]"); if (!t || t.disabled) return;
  const app = [...TEAM_APPS, ...PUBLIC_APPS].find((a) => a.key === t.dataset.key); if (!app?.open) return;
  if (app.open.href) { location.href = app.open.href; return; }
  const { data: { session } } = await sb.auth.getSession(); if (!session) return show("s-email");
  t.dataset.busy = "1"; const label = t.querySelector("b"), was = label.textContent; label.textContent = "Opening…";
  try {
    const r = await callFn("handoff", app.open.handoff, session.access_token);
    location.href = r.url;
  } catch (err) {
    label.textContent = was; delete t.dataset.busy;
    alert(err.message === "not_permitted" ? "Your Planning Center team doesn't include this tool yet." : `Couldn't open ${app.name}: ${err.message}`);
  }
});
// tag → tile highlight
$("tags").addEventListener("click", (e) => {
  const c = e.target.closest("code"); if (!c) return;
  const on = c.getAttribute("aria-pressed") !== "true";
  $("tags").querySelectorAll("code").forEach((x) => x.setAttribute("aria-pressed", "false"));
  document.querySelectorAll(".tile").forEach((x) => x.classList.remove("lit"));
  $("s-home").classList.toggle("hl", on);
  if (!on) return;
  c.setAttribute("aria-pressed", "true");
  document.querySelectorAll(`.tile[data-tags~="${c.textContent.trim()}"]`).forEach((x) => x.classList.add("lit"));
  $("h-team").scrollIntoView({ behavior: "smooth", block: "start" });
});
document.querySelector(".access").addEventListener("toggle", function () { if (!this.open) { $("s-home").classList.remove("hl"); document.querySelectorAll(".tile").forEach((x) => x.classList.remove("lit")); } });
// refresh
$("refresh").onclick = async () => {
  const b = $("refresh"); if (b.dataset.state === "busy") return;
  const { data: { session } } = await sb.auth.getSession(); if (!session) return show("s-email");
  b.dataset.state = "busy"; b.textContent = "Checking Planning Center…";
  try { const r = await callFn("refresh-tags", {}, session.access_token); access = { tags: r.tags || [], teams: r.teams || [], synced: new Date(), source: r.found_in_pco ? "pco" : "none" }; renderHome(session); b.dataset.state = "done"; b.textContent = "Up to date"; }
  catch (e) { b.dataset.state = "idle"; b.textContent = "Refresh from Planning Center"; alert(`Couldn't reach Planning Center: ${e.message}`); return; }
  setTimeout(() => { b.dataset.state = "idle"; b.textContent = "Refresh from Planning Center"; }, 1800);
};
$("signout").onclick = async () => { await sb.auth.signOut(); sessionStorage.removeItem("hub-email"); lookupResult = null; $("email").value = ""; show("s-email"); };
$("me-btn").onclick = () => { const d = document.querySelector(".access"); d.open = true; d.scrollIntoView({ behavior: "smooth" }); };
$("installX").onclick = () => { $("install").hidden = true; try { localStorage.setItem("hub-install-dismissed", "1"); } catch {} };
// Install: Android/Chrome expose a real prompt; iOS has no API, so we show the two Safari steps.
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; $("installSub").textContent = "Tap to install."; });
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.MSStream;
if (isIOS) $("installSub").textContent = "Two taps in Safari — tap to see how.";
$("installGo").onclick = async () => {
  if (installPrompt) { installPrompt.prompt(); const r = await installPrompt.userChoice.catch(() => null); if (r?.outcome === "accepted") $("install").hidden = true; return; }
  $("installSteps").hidden = !$("installSteps").hidden;
};

// Coming back from an app via the back gesture restores the page from the
// back-forward cache exactly as we left it — with a tile stuck on "Opening…".
window.addEventListener("pageshow", (e) => {
  if (!e.persisted) return;
  document.querySelectorAll(".tile[data-busy]").forEach((t) => {
    const app = [...TEAM_APPS, ...PUBLIC_APPS].find((a) => a.key === t.dataset.key);
    if (app) t.querySelector("b").textContent = app.name;
    delete t.dataset.busy;
  });
});

// ---- returning ------------------------------------------------------------------
$("ret-continue").onclick = async () => { const { data: { session } } = await sb.auth.getSession(); if (session) land(session); else show("s-email"); };
$("ret-switch").onclick = async () => { await sb.auth.signOut(); show("s-email"); };

// ---- boot -------------------------------------------------------------------------
(async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get("pco_error")) { show("s-email"); showErr("email-err", `Planning Center sign-in didn't complete (${params.get("pco_error")}). Try again, or use a code.`); history.replaceState({}, "", location.pathname); }

  // A session arriving in the URL hash (magic link / PCO) fires SIGNED_IN below.
  sb.auth.onAuthStateChange((evt, session) => {
    if (evt === "SIGNED_IN" && session && $("s-home").hidden && $("s-landing").hidden) { history.replaceState({}, "", location.pathname); land(session); }
  });

  const { data: { session } } = await sb.auth.getSession();
  if (!session) { if (!params.get("pco_error")) show("s-email"); return; }
  const last = new Date(session.user.last_sign_in_at || 0);
  const days = (Date.now() - last.getTime()) / 86400000;
  if (days > RETURNING_AFTER_DAYS) {
    const name = session.user.user_metadata?.display_name || session.user.email;
    $("ret-name").innerHTML = `${firstName(name, session.user.email)} <span class="u">${(name.split(/\s+/)[1] || "").replace(/\.$/, "")}.</span>`;
    $("ret-sub").textContent = `${session.user.user_metadata?.planning_center_id ? "Signed in with Planning Center" : "Signed in with your email"} · ${session.user.email}`;
    show("s-returning");
  } else {
    land(session);
  }
})();
