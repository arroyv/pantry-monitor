import { readFileSync, writeFileSync } from "fs";
const API_URL =
  "https://pantryapi-web-d8gzfkftgtb5cfhn.westus2-01.azurewebsites.net/api/GetLatestPantry?pantryId=all&mode=monitor";
const NTFY_SERVER = "https://ntfy.sh";
const STATE_FILE = ".github/scripts/state.json";

// For now, everytimes new pantry is logged or added, we have to manually add it to this map. In the future, we can consider auto-discovering pantry topics based on device_id or other metadata.
const PANTRY_TOPIC_MAP = {
  HallerLakePantry: "pantry-monitor-HallerLake",
  Greenwood: "pantry-monitor-GreenWood",
  BeaconHill: "pantry-monitor-BeaconHill",
  StPaulChurchPantry: "pantry-monitor-StPaulChurch",
};

const THRESHOLDS = {
  BATT_LOW: 20,
  BATT_CRITICAL: 10,
  HOURS_24: 24 * 60 * 60 * 1000,
}

function loadState() {
  try {
    const state = readFileSync(STATE_FILE, "utf-8");
    return JSON.parse(state);
  } catch (err) {
    return {};
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function shouldNotify(state, key) {
  const lastSent = state[key];
  if (!lastSent) 
    return true; 

  return Date.now() - new Date(lastSent).getTime() >= THRESHOLDS.HOURS_24;
}

async function sendAlert(topic, title, body, state) {
  if (!shouldNotify(state, `${topic}::${title}`)) {
    console.log(`[ntfy] Skipping alert for ${topic} - sent within last 24 hours`);
    return;
  }

  try {
    await fetch(`${NTFY_SERVER}/${topic}`, {
      method: "POST",
      headers: {
        Title: title,
        "Content-Type": "text/plain",
      },
      body,
    });
    console.log(`[ntfy] Sent: ${title}`);

    state[`${topic}::${title}`] = new Date().toISOString();
  } catch (err) {
    console.error(`[error] Failed to send alert for ${topic}:`, err);
  }
}

async function checkBattery(pantryId, topic, data, history, state) {
  const batt = Number(data.batt_percent);
  if (isNaN(batt)) return;

  const lastSeen = new Date(data.timestamp).getTime();
  const last24Hours = history.filter(entry => new Date(entry.timestamp) >= new Date(lastSeen - THRESHOLDS.HOURS_24));
  if (last24Hours.length === 0) {
    console.warn(`[warn] No data in the last 24 hours for ${pantryId}. Skipping battery check.`);
    return;
  }
  
  const allZero = last24Hours.every(entry => Number(entry.batt_percent) === 0);

  if (allZero) {
    await sendAlert(
      topic,
      `CRITICAL Battery Issue - ${pantryId}`,
      `Battery has been at 0% for the last 24 hours. Check power immediately.`,
      state);
  } else if (batt <= THRESHOLDS.BATT_CRITICAL) {
    await sendAlert(
      topic,
      `MINOR Battery Issue - ${pantryId}`,
      `Battery at ${batt}%. Replace soon.`,
      state
    );
  } else if (batt <= THRESHOLDS.BATT_LOW) {
    await sendAlert(
      topic,
      `Warning Battery Issue - ${pantryId}`,
      `Battery at ${batt}%. Worth an attention.`,
      state
    );
  } else if (batt > 100) {
    await sendAlert(
      topic,
      `Calibration Required - ${pantryId}`,
      `Battery reading at ${batt}% — exceeds 100%`,
      state
    );
  }
  else {
    console.log(`[ok] ${pantryId} battery healthy at ${batt}%`);
  }
}

async function checkCalibration(pantryId, topic, data, history, state) {
  const acc = Number(data.accuracy);
  const wasPreviouslyCalibrated = history.some(r => Number(r.accuracy) > 0);

  if (acc === 0 && wasPreviouslyCalibrated) {
    await sendAlert(
      topic,
      `Calibration Required - ${pantryId}`,
      `Sensor accuracy is 0, calibration needed.`,
      state
    );  
  }

  const failingScales = [];
  for (let i = 1; i <= 4; i++) {
    const scale = Number(data[`scale${i}`]);
    if (isNaN(scale)) continue;

    if (scale < -2) {
      failingScales.push(`Scale ${i} (${scale} lbs)`);
    } 
  }

  if (failingScales.length > 0) {
    await sendAlert(
      topic,
      `Calibration Required - ${pantryId}`,
      `Scale(s) ${failingScales.join(', ')} reading negative. Recalibration needed.`,
      state
    );
  }
}


async function main() {
  const res = await fetch(API_URL);
  const data = await res.json();
  const state = loadState();

  for (const [pantryId, topic] of Object.entries(PANTRY_TOPIC_MAP)) {
    const pantry = data[pantryId];
    if (!pantry) {
      console.warn(`[skip] ${pantryId} — not found in API response`);
      continue;
    }

    const latest = pantry.latest;
    const history = pantry.history;
    if (!latest) {
      continue;
    }

    await checkBattery(pantryId, topic, latest, history, state);
    await checkCalibration(pantryId, topic, latest, history, state);
  }
  saveState(state);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
