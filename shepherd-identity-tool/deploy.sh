#!/usr/bin/env bash
# Deploy shepherd-identity-tool → https://shepherd-identity-tool.netlify.app
# Static single-page app. No build step.
set -euo pipefail
cd "$(dirname "$0")"
echo "Deploying shepherd-identity-tool ..."
netlify deploy --prod --dir=. --site=86cb04da-6929-426e-8b61-dd71d04e41a9
