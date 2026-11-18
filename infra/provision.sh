#!/usr/bin/env bash
# Creates the Azure resources for the Entrada outage tracker. Run once.
#
#   SUBSCRIPTION=<subscription id> NEIGHBORHOOD_CODE="Entrada 2026" ./infra/provision.sh
#
# Prerequisites: `az login`. SUBSCRIPTION is optional (defaults to your current az subscription).
# Creates, in one resource group:
#   - Static Web App (Free plan)              web app + API
#   - Azure SQL server + free-offer database  reports (serverless, pauses when idle)
#   - Storage account + private "photos" container
# Secrets (SQL password, deployment token) are stored in Azure and never printed.
set -euo pipefail

SUBSCRIPTION="${SUBSCRIPTION:-$(command az account show --query id -o tsv)}"
# Every az call below targets SUBSCRIPTION without changing your default subscription.
az() { command az "$@" --subscription "$SUBSCRIPTION"; }
echo "== Subscription: $(az account show --query name -o tsv) ($SUBSCRIPTION)"

: "${NEIGHBORHOOD_CODE:?Set NEIGHBORHOOD_CODE, e.g. NEIGHBORHOOD_CODE=\"Entrada 2026\" ./infra/provision.sh}"
LOCATION="${LOCATION:-eastus2}"          # Static Web Apps regions: westus2, centralus, eastus2, westeurope, eastasia
RG="${RG:-rg-entrada-outages}"
SUFFIX="${SUFFIX:-$(openssl rand -hex 3)}"
SWA="${SWA:-entrada-outages}"
SQL_SERVER="entrada-outages-$SUFFIX"
SQL_DB="outages"
SQL_ADMIN="outageadmin"
SQL_PASSWORD="$(openssl rand -base64 33 | tr -dc 'A-Za-z0-9' | cut -c1-28)Aa1!"
STORAGE="entradaphotos$SUFFIX"

echo "== Resource group $RG ($LOCATION)"
az group create -n "$RG" -l "$LOCATION" -o none

echo "== Static Web App $SWA (Free)"
az staticwebapp create -n "$SWA" -g "$RG" -l "$LOCATION" --sku Free -o none
HOST="$(az staticwebapp show -n "$SWA" -g "$RG" --query defaultHostname -o tsv)"

echo "== SQL server $SQL_SERVER + free-offer database"
az sql server create -g "$RG" -n "$SQL_SERVER" -l "$LOCATION" -u "$SQL_ADMIN" -p "$SQL_PASSWORD" -o none
# The API runs on Microsoft-managed infrastructure with no fixed IPs, so allow Azure services.
az sql server firewall-rule create -g "$RG" -s "$SQL_SERVER" -n AllowAzureServices \
  --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0 -o none
# Free offer: 100,000 vCore-seconds + 32 GB per month. When that runs out, keep running and bill
# (covered by the subscription's monthly credit) instead of pausing the tracker until next month.
# 15-minute auto-pause delay: each wake-up costs at least 15 min x 0.5 vCore, so short delays stretch the allowance.
az sql db create -g "$RG" -s "$SQL_SERVER" -n "$SQL_DB" \
  --edition GeneralPurpose --compute-model Serverless --family Gen5 --capacity 2 --min-capacity 0.5 \
  --use-free-limit --free-limit-exhaustion-behavior BillOverUsage \
  --auto-pause-delay 15 --backup-storage-redundancy Local -o none

echo "== Storage account $STORAGE + private photos container"
az storage account create -n "$STORAGE" -g "$RG" -l "$LOCATION" --sku Standard_LRS --kind StorageV2 \
  --min-tls-version TLS1_2 --allow-blob-public-access false -o none
STORAGE_CS="$(az storage account show-connection-string -n "$STORAGE" -g "$RG" -o tsv)"
az storage container create -n photos --connection-string "$STORAGE_CS" -o none
# Phones upload photos straight to storage, so allow the app's own address to do that.
az storage cors add --services b --methods GET PUT OPTIONS --origins "https://$HOST" \
  --allowed-headers '*' --exposed-headers '*' --max-age 3600 --connection-string "$STORAGE_CS"

echo "== App settings"
SQL_CS="Server=tcp:$SQL_SERVER.database.windows.net,1433;Database=$SQL_DB;User ID=$SQL_ADMIN;Password=$SQL_PASSWORD;Encrypt=True;Connect Timeout=30;"
az staticwebapp appsettings set -n "$SWA" -g "$RG" -o none --setting-names \
  "NEIGHBORHOOD_CODE=$NEIGHBORHOOD_CODE" \
  "SQL_CONNECTION_STRING=$SQL_CS" \
  "STORAGE_CONNECTION_STRING=$STORAGE_CS"

echo "== Database tables"
if command -v sqlcmd >/dev/null; then
  MYIP="$(curl -fsS https://api.ipify.org)"
  az sql server firewall-rule create -g "$RG" -s "$SQL_SERVER" -n setup-temp --start-ip-address "$MYIP" --end-ip-address "$MYIP" -o none
  sqlcmd -S "tcp:$SQL_SERVER.database.windows.net,1433" -d "$SQL_DB" -U "$SQL_ADMIN" -P "$SQL_PASSWORD" -l 60 -b -i "$(dirname "$0")/../db/schema.sql"
  az sql server firewall-rule delete -g "$RG" -s "$SQL_SERVER" -n setup-temp -o none
  echo "   schema created"
else
  echo "   sqlcmd not found. Open the database in the Azure portal > Query editor, sign in as"
  echo "   $SQL_ADMIN with the password below, and run db/schema.sql."
fi

cat <<EOF

Done.
  Site:      https://$HOST
  SQL login: $SQL_ADMIN on $SQL_SERVER (password is only in the app setting SQL_CONNECTION_STRING)

Next:
  1. Deploy: push to GitHub (see .github/workflows/deploy.yml), or run ./infra/deploy.sh with
     SWA_CLI_DEPLOYMENT_TOKEN from: az staticwebapp secrets list -n $SWA -g $RG --query properties.apiKey -o tsv
  2. Portal > $SWA > Role management > Invite: give yourself the role "admin".
  3. Portal > Cost Management > Budgets: add a monthly budget with an email alert (e.g. \$10).
EOF
