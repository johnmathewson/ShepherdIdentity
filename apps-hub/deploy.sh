#!/usr/bin/env bash
# Deploy apps-hub → https://apps.shepherdchurch.co
# Static single-page app. No build step.
set -euo pipefail
cd "$(dirname "$0")"
echo "Deploying apps-hub → apps.shepherdchurch.co ..."
# The hub's routing lives entirely in netlify.toml (this site has no _redirects).
# A stub netlify.toml silently unmounts Formation, Care and Go Find Jesus, so
# refuse to deploy one that has no proxy rules in it.
if ! grep -q 'shepherd-identity-tool.netlify.app/formation' netlify.toml; then
  echo "REFUSING TO DEPLOY: netlify.toml has no proxy rules." >&2
  echo "The sub-app mounts would be removed. Get the real file from the" >&2
  echo "Netlify dashboard (shepherd-apps-hub -> published deploy) first." >&2
  exit 1
fi

netlify deploy --prod --dir=. --site=21a7968b-ea50-424a-9632-36d588401b5c
