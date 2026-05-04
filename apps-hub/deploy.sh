#!/usr/bin/env bash
# Deploy apps-hub → https://apps.shepherdchurch.co
# Static single-page app. No build step.
set -euo pipefail
cd "$(dirname "$0")"
echo "Deploying apps-hub → apps.shepherdchurch.co ..."
netlify deploy --prod --dir=. --site=21a7968b-ea50-424a-9632-36d588401b5c
