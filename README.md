# Shepherd Static Sites

Single-file static sites that make up the Shepherd Church digital ecosystem.
Each folder is one Netlify site, deployed manually via the per-folder
`deploy.sh` (or `netlify deploy --prod`).

## Sites

| Folder | Live URL | Netlify site name | Site ID |
|---|---|---|---|
| `apps-hub/` | https://apps.shepherdchurch.co | `shepherd-apps-hub` | `21a7968b-ea50-424a-9632-36d588401b5c` |
| `shepherd-identity-tool/` | https://shepherd-identity-tool.netlify.app | `shepherd-identity-tool` | `86cb04da-6929-426e-8b61-dd71d04e41a9` |
| `identity-discovery-tool/` | https://identity-discovery-tool.netlify.app | `identity-discovery-tool` | `2f989069-b909-4945-b1ef-9ca35c7fbf89` |

## Architecture context

| Site | Audience | Supabase project |
|---|---|---|
| Apps Hub | Shepherd members (entry point / dashboard) | `epkuvykamufrrgbacbel` |
| Shepherd Identity Tool | Shepherd members (formation / journal) | `epkuvykamufrrgbacbel` |
| Identity Discovery Tool | Public — "Go Find Jesus" | `qtykoynnsyvrdkyeviwg` (isolated) |

The **Apps Hub + Shepherd Identity Tool** share an `auth.users` table and a
`team_members` table with the **prayer wall**
(`github.com/johnmathewson/shepherdchurch`, deployed at
`shepherd-prayer-wall.netlify.app`). Magic-link sign-in with the same email
across all three resolves to the same user.

The **Identity Discovery Tool** is the public-facing Go Find Jesus site —
intentionally on its own Supabase project so anyone signing up there is *not*
mixed with Shepherd member accounts.

## Deploying a single site

```bash
cd apps-hub
./deploy.sh
```

Each `deploy.sh` is a one-liner that runs:

```bash
netlify deploy --prod --dir=. --site=<the-site-id>
```

You must be authenticated to the Netlify CLI (`netlify status` to check, or
`netlify login` to authenticate) under an account that has access to the
`Stewardship Squad` team.

## Deploying all sites

```bash
./deploy-all.sh
```

This runs each site's deploy script in order. Use sparingly — usually you
only edit one site at a time.

## Editing

These are single-file static HTML sites. Auth is wired directly to the
Supabase clients via inline JavaScript modules. There is no build step.

If you change one of these files, **commit and push** before you deploy so
the GitHub history matches what's on Netlify.
