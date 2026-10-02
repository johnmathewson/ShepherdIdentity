#!/usr/bin/env bash
# Deploy hub/ → https://shepherd-apps-staging.netlify.app (STAGING)
set -euo pipefail
cd "$(dirname "$0")"
netlify deploy --prod --dir=. --site=cd6d9930-9ed5-4ca9-80b7-4ba5e43a844c
