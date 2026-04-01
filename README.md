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

## Deploy in 3 steps

### Step 1: Dashboard (GitHub Pages)

**Time: ~5 minutes**

1. Create a new GitHub repo named `pantry-monitor`

2. Clone it and copy all files from this project into it:
   ```bash
   git clone https://github.com/YOUR_USERNAME/pantry-monitor.git
   cd pantry-monitor
   # copy all files from this project into the repo root
   ```

3. If your repo name is different from `pantry-monitor`, update the base path in `vite.config.js`:
   ```js
   base: '/your-repo-name/',
   ```

4. Push to GitHub:
   ```bash
   git add .
   git commit -m "Initial deploy"
   git push origin main
   ```

5. Enable GitHub Pages:
   - Go to repo **Settings > Pages**
   - Under "Build and deployment", select **Source: GitHub Actions**
   - The included `.github/workflows/deploy.yml` handles the rest

6. After the action runs (~1 min), your dashboard is live at:
   ```
   https://YOUR_USERNAME.github.io/pantry-monitor/
   ```

**To test locally first:**
```bash
npm install
npm run dev
# opens at http://localhost:5173/pantry-monitor/
```

### Step 2: Azure Function (update existing)

**Time: ~10 minutes. Zero breaking changes.**

Your existing `PantryAPI-Web` function app stays as-is. You're replacing the code in the `pantry-status` function only. All existing callers (using `?pantryId=4015` etc.) continue to work unchanged.

**What's new (additive only):**
- `?pantryId=all` -- auto-discovers all devices from DB
- `?since=7d` -- returns all records from last 7 days (also: `24h`, `2h`, `30m`, or ISO datetime)
- `?include=stats` -- appends summary stats per device
- Existing `?pantryId=4015` and `?history=N` behavior is identical

**Option A: Deploy via VS Code (recommended)**

1. Open the `azure-function/` folder in VS Code
2. Install the Azure Functions extension if you haven't
3. In the Azure panel, find your `PantryAPI-Web` function app
4. Right-click the `pantry-status` function
5. Select "Deploy to Function App..."
6. Confirm overwrite

**Option B: Deploy via Azure CLI**

```bash
cd azure-function

# Login if needed
az login

# Deploy to your existing function app
az functionapp deployment source config-zip \
  --resource-group PantryGroup \
  --name PantryAPI-Web \
  --src pantry-status.zip
```

**Option C: Copy-paste in Azure Portal**

1. Go to portal.azure.com > PantryAPI-Web > Functions > pantry-status
2. Click "Code + Test"
3. Replace `index.js` with the contents of `azure-function/pantry-status/index.js`
4. If `function.json` doesn't already exist with the right bindings, replace it too
5. Save

**Verify it works:**
```bash
# Existing behavior (should return same as before)
curl "https://pantryapi-web.azurewebsites.net/api/pantry-status?pantryId=4015"

# New: all devices, last 7 days
curl "https://pantryapi-web.azurewebsites.net/api/pantry-status?pantryId=all&since=7d"

# New: with stats
curl "https://pantryapi-web.azurewebsites.net/api/pantry-status?pantryId=all&since=7d&include=stats"
```

### Step 3: Google Sheets Logger (optional)

**Time: ~5 minutes**

1. Create a new Google Sheet (or use an existing one)

2. Go to **Extensions > Apps Script**

3. Delete any existing code and paste the contents of `google-apps-script-logger.gs`

4. Run the `setupSheet` function once:
   - Click the function dropdown, select `setupSheet`
   - Click Run
   - Authorize when prompted (it needs permission to edit the spreadsheet)
   - This creates the "AnomalyLog" and "Summary" sheets with headers and formatting

5. Deploy as a web app:
   - Click **Deploy > New deployment**
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click Deploy
   - Copy the web app URL

6. Paste the URL into the dashboard's Settings > Google Sheets Webhook field

Anomalies will now auto-log to the sheet with timestamps, severity, and details. The Summary sheet shows live counts.

## Connect the dashboard to your API

1. Open the dashboard (GitHub Pages URL or localhost)
2. Click the **Settings** tab
3. Paste your Azure Function base URL: `https://pantryapi-web.azurewebsites.net`
4. Optionally paste the Google Sheets webhook URL
5. Click **Go Live**

The dashboard auto-refreshes every 5 minutes. All settings persist in your browser's localStorage.

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

## File structure

```
pantry-monitor/
├── .github/workflows/deploy.yml   # GitHub Pages auto-deploy
├── azure-function/
│   └── pantry-status/
│       ├── index.js                # Azure Function (backward-compatible)
│       └── function.json           # HTTP trigger bindings
├── google-apps-script-logger.gs    # Google Sheets webhook receiver
├── src/
│   ├── main.jsx                    # React entry point
│   └── PantryMonitor.jsx           # Dashboard component (single file)
├── index.html
├── vite.config.js
├── package.json
└── README.md
```
