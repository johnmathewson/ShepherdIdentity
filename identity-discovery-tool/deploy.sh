#!/usr/bin/env bash
# Deploy identity-discovery-tool → https://identity-discovery-tool.netlify.app
# Public "Go Find Jesus" site — uses its own isolated Supabase project.
# Static single-page app. No build step.
set -euo pipefail
cd "$(dirname "$0")"
echo "Deploying identity-discovery-tool (Go Find Jesus public) ..."
netlify deploy --prod --dir=. --site=2f989069-b909-4945-b1ef-9ca35c7fbf89
