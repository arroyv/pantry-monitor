// Azure Function: pantry-status/index.js
// 
// EXISTING BEHAVIOR (unchanged):
//   GET /api/pantry-status?pantryId=4015
//   GET /api/pantry-status?pantryId=BeaconHill
//   -> Returns single latest record, same response shape as before.
//
// NEW: Monitor mode
//   GET /api/pantry-status?pantryId=all&mode=monitor
//   -> Returns 1 week of history per device, auto-discovered from DB.
//   
//   GET /api/pantry-status?pantryId=all
//   -> Returns latest record per device (auto-discovered).
//
//   GET /api/pantry-status?pantryId=BeaconHill&mode=monitor
//   -> Returns 1 week of history for one device.
//
// Optional params:
//   history=N  (max records per device, default 1, max 2000; overridden by mode=monitor)
//
// Deploy to: PantryAPI-Web Azure Function App

const sql = require('mssql');

// Aliases: friendly names -> internal device_id.
// Only needed for legacy callers. Auto-discovery doesn't use this.
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

// All columns we ever return
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

module.exports = async function (context, req) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    context.res = { status: 204, headers: CORS };
    return;
  }

  const rawId = (req.query.pantryId || "").trim();
  const mode = (req.query.mode || "").toLowerCase();
  const isMonitor = mode === "monitor";

  // In monitor mode, pull 1 week. Otherwise respect history param or default to 1.
  let historyCount;
  if (isMonitor) {
    historyCount = 2000; // ~1 week at 10min intervals = 1008, 2000 gives headroom
  } else {
    historyCount = Math.min(Math.max(parseInt(req.query.history) || 1, 1), 2000);
  }

  let pool;
  try {
    pool = await sql.connect(process.env["SqlConnectionString"]);

    // ── Resolve device list ──────────────────────────────────────
    let deviceIds;
    const isAll = !rawId || rawId.toLowerCase() === "all";

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

    // ── Fetch data ───────────────────────────────────────────────
    const results = {};

    for (const deviceId of deviceIds) {
      let query;
      const request = pool.request()
        .input('deviceId', sql.NVarChar, deviceId);

      if (isMonitor) {
        // Time-bounded: last 7 days
        query = `
          SELECT ${SELECT_COLS}
          FROM dbo.PantryLogs
          WHERE device_id = @deviceId
            AND timestamp >= DATEADD(day, -7, GETUTCDATE())
          ORDER BY timestamp DESC
        `;
      } else {
        // Row-count bounded (original behavior)
        request.input('count', sql.Int, historyCount);
        query = `
          SELECT TOP (@count) ${SELECT_COLS}
          FROM dbo.PantryLogs
          WHERE device_id = @deviceId
          ORDER BY timestamp DESC
        `;
      }

      const result = await request.query(query);

      if (result.recordset.length === 0) {
        results[deviceId] = { device_id: deviceId, timestamp: null, error: "No data" };
        continue;
      }

      // ── Response shape depends on mode ─────────────────────────
      if (historyCount === 1 && !isMonitor) {
        // LEGACY: single record, flat object (no "history" wrapper)
        results[deviceId] = result.recordset[0];
      } else {
        results[deviceId] = {
          device_id: deviceId,
          latest: result.recordset[0],
          count: result.recordset.length,
          history: result.recordset,
        };
      }
    }

    // Single device without "all": return its data directly (backward compat)
    const body = (!isAll && deviceIds.length === 1)
      ? results[deviceIds[0]]
      : results;

    context.res = { headers: CORS, body };

  } catch (err) {
    context.log.error("DB error:", err.message);
    context.res = {
      status: 500,
      headers: CORS,
      body: { error: "Database error", detail: err.message },
    };
  } finally {
    if (pool) await pool.close();
  }
};
