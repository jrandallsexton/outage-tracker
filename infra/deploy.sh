#!/usr/bin/env bash
# Builds the web app and API and deploys both to the Static Web App.
#
#   SWA_CLI_DEPLOYMENT_TOKEN='<token from provision.sh>' ./infra/deploy.sh
set -euo pipefail
: "${SWA_CLI_DEPLOYMENT_TOKEN:?Set SWA_CLI_DEPLOYMENT_TOKEN (printed by provision.sh, or: az staticwebapp secrets list ...)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "== Address list"
node "$ROOT/scripts/build-addresses.mjs"

echo "== API tests"
dotnet test "$ROOT/src/api.Tests" --nologo -v quiet

echo "== Web app"
(cd "$ROOT/src/web" && npm ci && npm run build)

echo "== API"
rm -rf "$ROOT/build/api"
dotnet publish "$ROOT/src/api" -c Release -o "$ROOT/build/api" --nologo -v quiet

echo "== Deploy (production)"
npx -y @azure/static-web-apps-cli@2.1.0 deploy "$ROOT/src/web/dist" \
  --api-location "$ROOT/build/api" --api-language dotnet-isolated --api-version 10.0 \
  --env production
