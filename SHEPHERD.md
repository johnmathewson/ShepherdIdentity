# Shepherd Church — static sites and the shared Supabase project

Last verified against production **2026-10-02**. If you are picking this up cold,
read §1 and §2 and you will know where everything is.

---

## 1. Start here

This repo holds **three single-file static sites**. Each folder is one Netlify
site. There is no build step: `index.html` is the application. You edit it and
run `./deploy.sh` in that folder.

| Folder | Live URL | Netlify site | Site ID |
|---|---|---|---|
| `apps-hub/` | https://apps.shepherdchurch.co | `shepherd-apps-hub` | `21a7968b-ea50-424a-9632-36d588401b5c` |
| `shepherd-identity-tool/` | https://shepherd-identity-tool.netlify.app/formation/ | `shepherd-identity-tool` | `86cb04da-6929-426e-8b61-dd71d04e41a9` |
| `identity-discovery-tool/` | https://formationtool.com | `identity-discovery-tool` | `2f989069-b909-4945-b1ef-9ca35c7fbf89` |

```bash
cd apps-hub && ./deploy.sh        # one site
./deploy-all.sh                   # all three, rarely what you want
```

**`supabase/` at the repo root is a mirror, not the source of truth.** The
migrations and edge functions were pulled back off the server on 2026-10-02 so
the repo would stop being the only place they did not exist. They are deployed
through the Supabase dashboard or CLI, not from here.

### The rule this repo keeps breaking

More than once, production has been edited without the change reaching Git, and
then a deploy from a stale checkout has rolled production backwards. Before you
deploy anything:

```bash
curl -s https://shepherd-identity-tool.netlify.app/formation/ | diff - shepherd-identity-tool/index.html
```

If that prints anything, **production is ahead of you**. Pull it down first.
`netlify api listSiteFiles --data '{"site_id":"<id>"}'` tells you exactly what is
deployed, byte for byte, which is the only authoritative answer.

---

## 2. What each site is

**Apps Hub** — the front door. A member signs in once here and taps a tile to
reach any app. It is also the identity provider for the whole ecosystem: it
mints short-lived signed tokens that the other apps trust (§5). Files:
`index.html`, `app.js`, `strip.js`, icons. `strip.js` is the little bar that
every mounted sub-app loads; it is served from the hub, so a change here shows
up in Formation, the Prayer Wall and Care at the same time.

**Shepherd Identity Tool (Formation)** — the member-facing journal and identity
work: prophetic words, dreams, visions, prayer, gifts, the Drawing the Picture
worksheet, identity cards, the AI guide, the devotional reader and the church
board. Served under `/formation/` on every origin so it can be mounted behind
the hub; `_redirects` does the mapping and the page carries `<base href="/formation/">`.

**Identity Discovery Tool** — the public Go Find Jesus version, deliberately on
its **own Supabase project** (`qtykoynnsyvrdkyeviwg`) so that someone signing up
from the open internet never lands in the Shepherd member database. Do not
merge these two.

---

## 3. The Supabase project: `epkuvykamufrrgbacbel`

> **This project is not "the Formation database". Four products share it.**
> Anything you do to it — moving it, renaming it, restoring it — touches all four.

| Product | Tables |
|---|---|
| Formation / Identity | `profiles`, `identity_cards`, `principles`, `resources`, `ai_usage`, `boards`, `board_posts`, `board_responses`, `board_flags`, `app_settings`, `social_photo_assets`, `visitors` |
| Devotionals | `devotionals`, `devotional_email_log`, `devotional_views`, `devotional_notes`, `devotional_social_share` |
| Apps Hub | `hub_apps`, `hub_access`, `hub_team_tags`, `hub_pco_teams`, `hub_lookup_log` |
| Making Room pledge site | `pledges`, `pledge_donations`, `pledge_revisions`, `pledge_email_log`, `pledge_admins`, `pledge_settings`, `pledge_rate_limit` |

Roughly 31 MB, 41 tables, 57 RLS policies, 38 routines, 10 triggers, 3 views,
80 auth users (all email provider), 2 public storage buckets
(`devotional-graphics`, `social-photo-library`).

**`profiles.state` is the single most important column in the system.** It is a
JSON blob holding one person's entire formation journal. It is keyed to
`auth.users.id`. Losing or re-keying `auth.users` loses everyone's work.

### Dead weight still present

`prayer_requests`, `people`, `team_membership`, `prophetic_words`,
`prayer_week_*`, `prayer_pickups`, `notifications` are all **empty**. They are a
port of the Prayer Wall schema from before the Prayer Wall moved to its own
project (`jyhjcsrpaaaddraeowjf`). They still carry ~20 `SECURITY DEFINER` RPCs
callable by `anon`. See §9.

---

## 4. Edge functions

Source mirrored under `supabase/functions/` — all 19, with `MANIFEST.md` giving
versions and `verify_jwt` flags.

`pledge-submit`, `pledge-manage` and `pledge-admin` each ship three files
(`index.ts`, `shared.ts`, `pledge-card.js`). The shared copies have **drifted**
between them — `pledge-manage` has a different `GIVING_URL` and an extra
`unspecified` frequency. Each was exported as deployed rather than collapsed
into one, so the drift is visible. Worth reconciling.

`pco-admin` and `pco-debug` are retired stubs that return HTTP 410.

| Function | What it does |
|---|---|
| `ai-chat` | the AI guide and identity synthesis; Claude with a model fallback chain |
| `audio-transcribe` / `image-transcribe` | journal entry capture by voice or photo |
| `pco-signin` | Planning Center OAuth; **redirect URI is hardcoded**, see §7 |
| `lookup` | email-first sign-in: is this address in Planning Center? Rate limited, never reveals a miss |
| `refresh-tags` | re-derives a person's hub tags from PCO Services teams |
| `handoff` | mints the signed cross-project token (§5) |
| `status` | per-app badge counts for the hub tiles |
| `pco-admin`, `pco-debug`, `apps-activity` | admin and diagnostics |
| `send-devotional-email`, `devotional-unsubscribe` | the daily devotional |
| `generate-social-share` | devotional graphics |
| `pledge-submit`, `pledge-manage`, `pledge-admin`, `pledge-pco-sync`, `pledge-notify` | the Making Room pledge site |

### Secrets

Set in the Supabase dashboard under Edge Functions. **Never in code, never in Git.**

`ANTHROPIC_API_KEY` · `RESEND_API_KEY` · `PLANNING_CENTER_CLIENT_ID` ·
`PLANNING_CENTER_CLIENT_SECRET` · `PCO_PAT_APP_ID` · `PCO_PAT_SECRET` ·
`DEVOTIONAL_APP_URL` · `PLEDGE_SITE_URL` · `PLEDGE_FROM` · `PLEDGE_ASSET_URL`

Plus one per app that trusts the hub, looked up **dynamically** by name
(`handoff/index.ts` builds `HANDOFF_SECRET_${APP}` at runtime, so grepping for
the literal string finds nothing):

`HANDOFF_SECRET_PRAYER_WALL` · `HANDOFF_SECRET_CARE` · `HANDOFF_SECRET_GFJ`

Vault (database-side, for pg_cron): `devotional_service_key`, `shepherd_sync_secret`.

### Cron

| Job | Schedule | Does |
|---|---|---|
| `send-daily-devotional` | `0 11 * * *` | the daily devotional email |
| `pledge-pco-pull` | `*/15 * * * *` | pulls pledges entered in Planning Center Giving |
| `pledge-pco-reconcile` | `15 7 * * *` | nightly reconcile of pledges and gifts |

---

## 5. How sign-in works across projects

One identity, several databases. The hub is the only thing that decides who you are.

1. Member signs in at the hub (magic link / 6-digit code, or Planning Center OAuth).
2. `refresh-tags` derives their tags from **Planning Center Services team membership**
   (member → `#tag`, Team Leader → `#tagadmin`). There are no hashtags in PCO;
   team membership *is* the permission.
3. Tapping a tile calls `handoff`, which signs an HS256 JWT — 60 seconds,
   single-use `jti`, audience = that one app — carrying email, name and tags.
4. The target app's own `sso-handoff` function verifies it with the shared
   secret, burns the nonce, finds-or-creates the user **in its own project**,
   stamps the tags into `app_metadata`, and mints a normal session there.

Apps that trust the hub: Prayer Wall (`jyhjcsrpaaaddraeowjf`), Shepherd Care
(`nrfwdwooyiucyuglzbmx`), Go Find Jesus prayer app (`kugzjuggexyugpfflmyy`).

**The secret is symmetric.** `HANDOFF_SECRET_CARE` here must equal
`HANDOFF_SECRET` on the Care project, and so on. Rotate them in pairs or
sign-in breaks for that app.

---

## 6. Accounts this depends on

Everything below is currently under **personal** accounts. All of it has to move
or be shared for the church to own this.

| Thing | Where | Note |
|---|---|---|
| Supabase | org **Stewardship Asset Group** (`ucrjcmkvirrrfvtcxaca`) | the only org; all 16 projects live here |
| Netlify | account `john-9etc9e8` | 21 sites |
| DNS for `shepherdchurch.co` | **Cloudflare** | `apps.` and `pledge.` are proxied; Cloudflare injects a bot script into every response, so a `curl` of those hosts will never byte-match the deployed file. Fetch the `.netlify.app` origin instead |
| DNS for `nwiprays.com`, `formationtool.com`, `gofindjesus.events` | Netlify | not proxied |
| GitHub | `johnmathewson/ShepherdIdentity`, `johnmathewson/shepherdchurch` | |
| Planning Center | OAuth app + a Personal Access Token | §7 |
| Anthropic, Resend | API keys | Resend sends from `nwiprays.com`, which is domain-verified there |

---

## 7. What breaks if the Supabase project ref changes

The project ref `epkuvykamufrrgbacbel` appears in the URL of every API call,
every edge function and the OAuth redirect. A **new** project means a new ref,
and all of this breaks at once:

1. **Planning Center OAuth.** `pco-signin` hardcodes
   `https://epkuvykamufrrgbacbel.supabase.co/functions/v1/pco-signin` and that
   exact string is registered as the redirect URI in the PCO developer app.
   Both have to change together or every PCO sign-in fails.
2. **`supabaseUrl` and the anon key** baked into all three `index.html` files
   here, plus the pledge site and anything else pointing at this project.
3. **The three `HANDOFF_SECRET_*` pairs** — the other projects' `sso-handoff`
   functions have to keep verifying with the same values.
4. **`auth.users`.** A fresh project starts empty. 80 users with the ids that
   `profiles`, `identity_cards` and every journal row are keyed to. This is the
   one that loses people's work.
5. **Cron + Vault.** `pg_cron` jobs and the two Vault secrets do not travel with
   a data-only export.

### Therefore: transfer, do not rebuild

Supabase can **transfer a project between organizations** (Project Settings →
General → Transfer project). The ref, URL, keys, auth users, secrets, functions,
storage and cron all stay exactly as they are, and nothing in the list above has
to change. You need Owner on both orgs and the target org on a plan that covers
the project.

GitHub works the same way: Settings → Transfer ownership keeps history, issues
and sets up redirects from the old URL.

**Create the Shepherd org/account first, then transfer into it.** Rebuilding
from a dump is a multi-day job with a real chance of losing journals.

---

## 8. Backing up

```bash
git bundle create shepherd.bundle --all     # whole repo + history, one file
git clone shepherd.bundle restored/         # restore
```

The database: Supabase's own backups are the restorable artifact (Dashboard →
Database → Backups; enable PITR if it is not on). A JSON export of the
irreplaceable tables lives in
`Claude-Sync/_Backups/shepherd-migration-2026-10-02/supabase-data/`
— `auth_users`, `profiles`, `identity_cards`, `resources`, the `hub_*` and
`pledge_*` config. That export is **personal journal content in plain text**;
treat the folder accordingly. It is a safety net, not a restore path — there is
no importer for it.

---

## 9. Known debt

- **`apps-hub/netlify.toml` in this repo is a reconstruction, not the real file.**
  The hub has no `_redirects`; every proxy mount lives in `netlify.toml`, and
  the deployed one (854 bytes) cannot be pulled back — Netlify's API returns
  metadata for config files but not content. What was in Git was the original
  67-byte build stub, which on deploy would have silently unmounted Formation,
  Care and Go Find Jesus from `apps.shepherdchurch.co`. `deploy.sh` now refuses
  to run if the proxy rules are missing. **Copy the real file out of the Netlify
  dashboard and replace the reconstruction before the next hub deploy.** The
  verified proxy map is:

  | Path | Proxies to |
  |---|---|
  | `/formation/*` | `shepherd-identity-tool.netlify.app/formation/:splat` |
  | `/care/*` | `shepherd-care.netlify.app/care/:splat` |
  | `/gfj/*` | `gfj-prayer-app.netlify.app/gfj/:splat` |

- **`/prayer` on the hub is an infinite redirect.** It 308s to itself. The
  Prayer Wall mount (HUB.md step 4) was never finished. Either mount it the way
  the other three are, or remove the rule.

- **~20 `SECURITY DEFINER` RPCs callable by `anon`** left over from the Prayer
  Wall port (`claim_prayer_slot`, `pickup_prayer_request`, `add_prophetic_word`,
  `board_*`, …). The board ones are live and intentional; the prayer ones are
  dead and should be dropped with their empty tables.
- **`resources_backup_sermonlib_20260725`** — RLS disabled on a public table.
  Supabase flags it as an ERROR. Zero rows. Drop it.
- Two functions with a mutable `search_path` (`set_updated_at`, `pledge_set_updated_at`).
- Leaked-password protection is off in Auth (low impact — sign-in is magic-link).
- Three commits of work on the Drawing the Picture declaration
  (`8a4bd8d`, `8082d5e`, `a7f9a4b` — naming the missing worksheet step, and a
  back-and-forth refine box) were committed in September but **never reached
  production**, and production has since rewritten that area. They are in history
  if the refine idea is wanted again; they are not in the current file.
- `.live-snapshot/` is a read-only reference from 2026-05-18 and is stale. The
  live files in each site folder are now current; the snapshot is kept only for
  history and can be deleted.
