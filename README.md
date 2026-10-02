# Shepherd Static Sites

Single-file static sites for the Shepherd Church digital ecosystem. Each folder
is one Netlify site, deployed with its own `deploy.sh`. There is no build step.

**→ Read [SHEPHERD.md](SHEPHERD.md) first.** It is the full map: what each site
is, the shared Supabase project, how sign-in works across projects, which
accounts everything depends on, and what breaks if the project ref changes.

| Folder | Live URL | Netlify site | Site ID |
|---|---|---|---|
| `apps-hub/` | https://apps.shepherdchurch.co | `shepherd-apps-hub` | `21a7968b-ea50-424a-9632-36d588401b5c` |
| `shepherd-identity-tool/` | https://shepherd-identity-tool.netlify.app/formation/ | `shepherd-identity-tool` | `86cb04da-6929-426e-8b61-dd71d04e41a9` |
| `identity-discovery-tool/` | https://formationtool.com | `identity-discovery-tool` | `2f989069-b909-4945-b1ef-9ca35c7fbf89` |

```bash
cd apps-hub && ./deploy.sh      # deploy one site
./deploy-all.sh                 # all three
```

## Before you deploy

Production has been edited directly more than once, and deploying a stale
checkout rolls it backwards. Check first:

```bash
curl -s https://shepherd-identity-tool.netlify.app/formation/ | diff - shepherd-identity-tool/index.html
```

Silence means you are current. Anything else means production is ahead of you —
pull it down before you touch it. `netlify api listSiteFiles --data '{"site_id":"<id>"}'`
is the authoritative list of what is actually deployed.

Note that `apps.shepherdchurch.co` and `pledge.shepherdchurch.co` sit behind
Cloudflare, which injects a bot-detection script into every response. A `curl`
of those will never match the deployed bytes — fetch the `.netlify.app` origin
instead.

## Which Supabase project

| Site | Audience | Supabase project |
|---|---|---|
| Apps Hub | Shepherd members — entry point and identity provider | `epkuvykamufrrgbacbel` |
| Shepherd Identity Tool | Shepherd members — formation and journal | `epkuvykamufrrgbacbel` |
| Identity Discovery Tool | Public — Go Find Jesus | `qtykoynnsyvrdkyeviwg` (deliberately isolated) |

`epkuvykamufrrgbacbel` also carries the devotionals and the Making Room pledge
site, and it issues the signed tokens that the Prayer Wall, Shepherd Care and
the Go Find Jesus prayer app trust. It is not just the Formation database.

## Mirrors, not sources

`supabase/migrations/` and `supabase/functions/` were
pulled back off the server on 2026-10-02 so they exist somewhere other than
Supabase. They are deployed through the dashboard or CLI, not from here.

`.live-snapshot/` is a read-only reference from 2026-05-18 and is stale.
