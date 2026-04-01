# Pantry Monitor

Real-time monitoring dashboard for community micro-pantry IoT sensors. Auto-discovers pantries, runs 18 anomaly checks over a 7-day window, and logs issues to Google Sheets.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌────────────────┐
│  IoT Devices    │────▶│  Azure IoT Hub   │────▶│  Azure SQL DB  │
│  (field sensors)│     │  + Stream Analyt. │     │  PantryLogs    │
└─────────────────┘     └──────────────────┘     └───────┬────────┘
                                                         │
                                                         ▼
┌─────────────────┐     ┌──────────────────┐     ┌────────────────┐
│  GitHub Pages   │◀───▶│  Azure Function  │◀───▶│  SQL query     │
│  (this repo)    │     │  pantry-status   │     │  auto-discover │
└────────┬────────┘     └──────────────────┘     └────────────────┘
         │
         ▼
┌─────────────────┐
│  Google Sheets  │  (anomaly log via Apps Script webhook)
└─────────────────┘
```

## Setup

### Dashboard (GitHub Pages)

The dashboard deploys automatically via GitHub Actions on every push to `main`.

1. Go to repo **Settings > Pages**
2. Set **Source** to **GitHub Actions**
3. Push to `main` — the site goes live at `https://YOUR_USERNAME.github.io/pantry-monitor/`

### Azure Function

Your existing `PantryAPI-Web` function app stays as-is. Replace only the `pantry-status` function code with `azure-function/pantry-status/index.js`. All existing callers continue to work unchanged.

**New query params (additive only):**
- `?pantryId=all` — auto-discovers all devices from DB
- `?since=7d` — returns records from last 7 days (`24h`, `2h`, `30m`, or ISO datetime)
- `?include=stats` — appends summary stats per device

Deploy via VS Code (Azure Functions extension), Azure CLI, or copy-paste in the Azure Portal under **Functions > pantry-status > Code + Test**.

### Google Sheets Logger (optional)

1. Create a Google Sheet, go to **Extensions > Apps Script**
2. Paste `google-apps-script-logger.gs`, run `setupSheet` once, then deploy as a **Web app** (Execute as: Me, Access: Anyone)
3. Copy the web app URL into the dashboard's **Settings > Google Sheets Webhook** field

## Connect to your API

1. Open the dashboard and click the **Settings** tab
2. Paste your Azure Function base URL: `https://pantryapi-web.azurewebsites.net`
3. Optionally paste the Google Sheets webhook URL
4. Click **Go Live**

The dashboard auto-refreshes every 5 minutes. Settings persist in localStorage.

## Anomaly checks (18 total)

**Point-in-time (latest reading):**
| Check | What it catches |
|-------|----------------|
| Staleness | No data beyond expected interval |
| Offline | No data for 24h+ |
| Battery level | Low/critical thresholds |
| Battery calibration | Readings > 100% |
| Temp range | Outside configurable bounds |
| Humidity | Above threshold |
| IAQ | Air quality index elevated/critical |
| Pressure | Barometric out of range |
| RSSI | Weak signal strength |
| Scale bounds | Negative or impossibly high |
| Scale disconnect | Hardware disconnect flag |
| Scale suspect | Firmware suspect flag |
| Door open | Non-event open status |

**Time-series (7-day window):**
| Check | What it catches |
|-------|----------------|
| Flatline | Sensor stuck reporting same value |
| Spike (z-score) | Statistical outlier vs rolling mean |
| Interval drift | Reporting gap > Nx median |
| All-zero | Every sensor at 0 = device fault |
| Battery drain | Projected days remaining |
| Temp/Humid drift | Rapid change rate (C/hr, %/hr) |
| Door rate | Opens/day above threshold |
| Door stuck | Consecutive open readings > 30min |
| Event burst | Too many events in short window |
| Gas resistance | Declining trend = worsening air |

All thresholds are configurable in the Settings tab.

## Adding new pantries

No code changes needed. When a new device starts writing to `dbo.PantryLogs`, it appears automatically on the next refresh. Optionally assign it a display name in Settings.
