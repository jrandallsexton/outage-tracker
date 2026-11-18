# Entrada Outage Tracker

A phone-friendly web app that lets Entrada residents report internet outages in two taps
(**My internet is DOWN** → **It's BACK**), with optional photo proof, so the neighborhood can hand the ISP one
evidence-backed report instead of 751 phone calls.

## How it works

| Part | Where | Notes |
|---|---|---|
| Phone app | `src/web` | Vite + TypeScript, no framework (~17 KB gzipped incl. all addresses). Installable to the home screen. |
| API | `src/api` | C# Azure Functions (.NET 10 isolated), hosted as the Static Web App's built-in API. |
| Database | `db/schema.sql` | Azure SQL free offer (serverless; pauses when idle). |
| Photos | Blob Storage | Phones upload straight to a private container using 30-minute links. Shrunk to ~250 KB first. |
| Address list | `data/` → `src/data/addresses.json` | Built from the Google Maps screenshots in `media/`. See `data/review.md`. |

Design choices that keep reports from being lost:

- **Set up once.** The address and neighborhood code are kept in this browser's storage, *and* in a cookie the server sets
  (iPhone Safari wipes storage set by page scripts after 7 days without a visit, but not cookies the server sets),
  *and* can be restored from a personal setup link (`/?home=<address-id>&code=<code>`).
- **Saved on the phone first.** Every tap goes into an on-phone queue (IndexedDB) and is sent when there's signal.
  Residents report while their home internet is down, often on weak cellular.
- **Safe to retry.** Report ids are generated on the phone, and each send carries the report's full state, so retries never create duplicates.
- **Wakes the database early.** Opening the app pings the API so a paused database is awake by the time someone taps.

Privacy: the public summary (`/#summary`) shows only outage times and home counts. Addresses, notes and photos
are visible only to admins on `/admin.html`.

## Run it locally (no Azure needed)

```bash
cd src/web
npm install
npm run dev          # http://localhost:5173 - uses a fake in-memory API (dev/mock-api.ts)
```

Neighborhood code in dev: `entrada`. You're automatically an admin at `/admin.html`.
To test the offline queue, open `/__mock/offline?on=1` in another tab (and `?on=0` to restore).

API tests: `dotnet test src/api.Tests`

## Deploy to Azure

**Releases are automatic:** every push to `main` runs `.github/workflows/deploy.yml`, which checks the address list,
runs the API tests, builds both parts and deploys. Pull requests are built and tested but never deployed.

One-time setup of a new environment:

```bash
az login
SUBSCRIPTION=<subscription id> NEIGHBORHOOD_CODE="<pick a code>" ./infra/provision.sh
# Give GitHub Actions the deployment token (never printed):
az staticwebapp secrets list -n entrada-outages -g rg-entrada-outages --subscription <subscription id> \
  --query properties.apiKey -o tsv | gh secret set AZURE_STATIC_WEB_APPS_API_TOKEN
```

`infra/deploy.sh` can still deploy straight from a machine if GitHub is unavailable.

Then in the Azure portal:

1. **Static Web App → Role management → Invite**: invite yourself (and any helpers) with the role `admin`.
2. **Cost Management → Budgets**: add a monthly budget with an email alert.

Expected cost: Static Web Apps Free plan $0; SQL free offer $0 unless the monthly allowance is used up
(it then bills normally instead of going offline); photo storage a few cents a month.

## Admin settings (Static Web App → Environment variables)

| Setting | Purpose |
|---|---|
| `NEIGHBORHOOD_CODE` | The shared code residents enter once. Case, spaces and dashes are ignored. Change it here if it leaks. |
| `SQL_CONNECTION_STRING` | Database connection. |
| `STORAGE_CONNECTION_STRING` | Photo storage connection. |

## Updating the address list

Edit `data/addresses-raw.csv`, run `node scripts/build-addresses.mjs`, and redeploy. Both the app and the API
use the generated `src/data/addresses.json`.
