#!/usr/bin/env bash
# Deploy all three sites in sequence.
# Use sparingly — typically you only edit one at a time.
set -euo pipefail
cd "$(dirname "$0")"

for site in apps-hub shepherd-identity-tool identity-discovery-tool; do
  echo
  echo "──────────────────────────────────────────────────"
  echo "  Deploying $site"
  echo "──────────────────────────────────────────────────"
  ( cd "$site" && ./deploy.sh )
done

echo
echo "All deploys complete."
