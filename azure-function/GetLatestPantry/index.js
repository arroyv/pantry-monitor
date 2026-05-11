// Azure Function: pantry-status/index.js
//
// ═══════════════════════════════════════════════════════════════════
//  BACKWARD COMPATIBLE
//  Existing callers get the EXACT same response shape as before.
//  New "mode=monitor" param enables the dashboard's extended format.
// ═══════════════════════════════════════════════════════════════════
//
// EXISTING (unchanged response shape):
//   GET /api/pantry-status?pantryId=4015
//   GET /api/pantry-status?pantryId=BeaconHill
//   → { pantryId, deviceId, timestamp, weight, temperature,
//       doorStatus, battery, isAnomaly, statusMessage }
//
// NEW (for the monitoring dashboard):
//   GET /api/pantry-status?pantryId=all&mode=monitor
//   → auto-discovers all devices, returns 7 days of full history
//
//   GET /api/pantry-status?pantryId=4015&mode=monitor
//   → 7 days of history for one device
//
//   GET /api/pantry-status?pantryId=all
//   → latest record per device (auto-discovered), full column set
//
// ═══════════════════════════════════════════════════════════════════

const sql = require('mssql');

// Aliases: friendly IDs → internal device_id in DB
const ALIASES = {
  "4015": "BeaconHill",
  "beaconhill": "BeaconHill",
  "greenwood": "Greenwood",
  "stpaul": "StPaulChurchPantry",
  "stpaulchurchpantry": "StPaulChurchPantry",
};

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const SELECT_COLS = `
  id, device_id, timestamp, is_event,
  air_temp, air_humid, air_pressure,
  gas_resistance, iaq, static_iaq, eco2, bvoc, accuracy,
  food_temp,
  door1_open, door2_open,
  batt_voltage, batt_percent,
  rssi, memory_free,
  scale1, scale2, scale3, scale4,
  device_ts, bsec_stability, bsec_runin, time_sync_error,
  scale1_disconnect, scale2_disconnect, scale3_disconnect, scale4_disconnect,
  scale1_samples, scale2_samples, scale3_samples, scale4_samples,
  scale1_suspect, scale2_suspect, scale3_suspect, scale4_suspect
`;

const PANTRY_TOPICS = {
    "HallerLakePantry": "pantry-monitor-HallerLake",
    "StPaulChurchPantry": "pantry-monitor-StPaulChurch",
    "GreenWood": "pantry-monitor-GreenWood",
    "BeaconHill": "pantry-monitor-BeaconHill"
};

// Sends a push notifications to the ntfy topics via ntfy.sh 
async function sendNotifications(pantryId, message) {
    const topic = PANTRY_TOPICS[pantryId];

    if (!topic) {
      console.warn('No topic found for pantry:', pantryId);
      return;
    }

    try {
      const res = await fetch(`https://ntfy.sh/${topic}`, {
        method: "POST",
        body: message
      });

      if (!res.ok) {
        console.error(`${res.status}: Failed to send notification for ${pantryId} - ${res.statusText}`);
      }
    }catch (err) {
      console.error(`Error sending notification for ${pantryId}:`, err);
    }
  }

// Build the ORIGINAL response shape so existing callers don't break
function legacyResponse(row, pantryId, internalDeviceId) {
  const totalWeight = (row.scale1 || 0) + (row.scale2 || 0)
                    + (row.scale3 || 0) + (row.scale4 || 0);
  return {
    pantryId: pantryId,
    deviceId: internalDeviceId,
    timestamp: row.timestamp,
    weight: totalWeight,
    temperature: row.air_temp,
    doorStatus: (row.door1_open || row.door2_open) ? "Open" : "Closed",
    battery: row.batt_percent,
    isAnomaly: false,
    statusMessage: "OK"
  };
}

module.exports = async function (context, req) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    context.res = { status: 204, headers: CORS };
    return;
  }

  const rawId = (req.query.pantryId || "").trim();
  const mode = (req.query.mode || "").toLowerCase();
  const isMonitor = mode === "monitor";
  const isAll = rawId.toLowerCase() === "all";

  // ── Validate (preserve original 400 behavior) ─────────────────
  if (!rawId) {
    context.res = {
      status: 400,
      headers: CORS,
      body: { error: "Missing pantryId. Use ?pantryId=4015 or ?pantryId=all" }
    };
    return;
  }

  // Legacy single-device call without monitor mode?
  // This is the path existing callers take.
  const isLegacyCall = !isAll && !isMonitor && !req.query.history;

  const historyCount = isMonitor
    ? 5000   // ~30 days at 10min = 4320, with headroom
    : Math.min(Math.max(parseInt(req.query.history) || 1, 1), 5000);

  let pool;
  try {
    pool = await sql.connect(process.env["SqlConnectionString"]);

    // ── Resolve devices ───────────────────────────────────────────
    let deviceIds;

    if (isAll) {
      const disc = await pool.request().query(
        `SELECT DISTINCT device_id FROM dbo.PantryLogs`
      );
      deviceIds = disc.recordset.map(r => r.device_id);
    } else {
      const resolved = ALIASES[rawId.toLowerCase()] || rawId;
      deviceIds = [resolved];
    }

    if (deviceIds.length === 0) {
      context.res = { status: 404, headers: CORS, body: { error: "No devices found" } };
      return;
    }

    // ── Query each device in parallel ────────────────────────────
    const queryDevice = async (deviceId) => {
      const request = pool.request()
        .input('deviceId', sql.NVarChar, deviceId);

      let query;
      if (isMonitor) {
        request.input('count', sql.Int, historyCount);
        query = `
          SELECT TOP (@count) ${SELECT_COLS}
          FROM dbo.PantryLogs
          WHERE device_id = @deviceId
            AND timestamp >= DATEADD(day, -30, GETUTCDATE())
          ORDER BY timestamp DESC
        `;
      } else {
        request.input('count', sql.Int, historyCount);
        query = `
          SELECT TOP (@count) ${SELECT_COLS}
          FROM dbo.PantryLogs
          WHERE device_id = @deviceId
          ORDER BY timestamp DESC
        `;
      }

      const result = await request.query(query);

      if (result.recordset.length === 0)
        return [deviceId, { device_id: deviceId, timestamp: null, error: "No data" }];

      if (historyCount === 1 && !isMonitor)
        return [deviceId, result.recordset[0]];

      return [deviceId, {
        device_id: deviceId,
        latest: result.recordset[0],
        count: result.recordset.length,
        history: result.recordset,
      }];
    };

    // Legacy single-device path returns early (unchanged behavior)
    if (isLegacyCall) {
      const result = await pool.request()
        .input('deviceId', sql.NVarChar, deviceIds[0])
        .query(`SELECT TOP (1) ${SELECT_COLS} FROM dbo.PantryLogs WHERE device_id = @deviceId ORDER BY timestamp DESC`);
      if (result.recordset.length === 0) {
        context.res = { status: 404, headers: CORS, body: { error: "No data found" } };
        return;
      }
      context.res = { headers: CORS, body: legacyResponse(result.recordset[0], rawId, deviceIds[0]) };
      return;
    }

    const pairs = await Promise.all(deviceIds.map(queryDevice));
    const results = Object.fromEntries(pairs);

    for (const [deviceId, data] of Object.entries(results)) {
      console.log("Sending test notification for device:", deviceId);
      await sendNotifications(deviceId, 'Test notification from GetLatestPantry function');
      // const latest = data.latest || data;

      // if (!latest || !latest.timestamp) {
      //   continue;
      // }

      // if (latest.batt_percent != null && latest.batt_percent > 20) { // change this threshold!
      //   await sendNtfyAlert(context, deviceId, `${deviceId} battery is low: ${latest.batt_percent}%.`);
      // }
    }

    // "all" or multi-device: return keyed object
    context.res = { headers: CORS, body: results };

  } catch (err) {
    context.log.error("DB error:", err.message);
    context.res = {
      status: 500,
      headers: CORS,
      // Original returned just a string for errors
      body: isLegacyCall ? "Database Error" : { error: "Database error", detail: err.message },
    };
  } finally {
    if (pool) await pool.close();
  }
};
