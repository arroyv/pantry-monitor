const API_URL =
  "https://pantryapi-web-d8gzfkftgtb5cfhn.westus2-01.azurewebsites.net/api/GetLatestPantry?pantryId=all&mode=monitor";
const NTFY_SERVER = "https://ntfy.sh";

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

async function sendAlert(topic, title, body) {
  await fetch(`${NTFY_SERVER}/${topic}`, {
    method: "POST",
    headers: {
      Title: title,
      "Content-Type": "text/plain",
    },
    body,
  });
  console.log(`[ntfy] Sent: ${title}`);
}

async function checkBattery(pantryId, topic, data, history) {
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
      `Battery has been at 0% for the last 24 hours. Check power immediately.`);
  } else if (batt <= THRESHOLDS.BATT_CRITICAL) {
    await sendAlert(
      topic,
      `MINOR Battery Issue - ${pantryId}`,
      `Battery at ${batt}%. Replace soon.`,
    );
  } else if (batt <= THRESHOLDS.BATT_LOW) {
    await sendAlert(
      topic,
      `Warning Battery Issue - ${pantryId}`,
      `Battery at ${batt}%. Worth an attention.`,
    );
  } else if (batt > 100) {
    await sendAlert(
      topic,
      `Calibration Required - ${pantryId}`,
      `Battery reading at ${batt}% — exceeds 100%`
    );
  }
  else {
    console.log(`[ok] ${pantryId} battery healthy at ${batt}%`);
  }
}

async function checkCalibration(pantryId, topic, data, history) {
  const acc = Number(data.accuracy);
  const wasPreviouslyCalibrated = history.some(r => Number(r.accuracy) > 0);

  if (acc === 0 && wasPreviouslyCalibrated) {
    await sendAlert(
      topic,
      `Calibration Required - ${pantryId}`,
      `Sensor accuracy is 0, calibration needed.`
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
      `Scale(s) ${failingScales.join(', ')} reading negative. Recalibration needed.`
    );
  }
}


async function main() {
  const res = await fetch(API_URL);
  const data = await res.json();

  for (const [pantryId, topic] of Object.entries(PANTRY_TOPIC_MAP)) {
    const pantry = data[pantryId].latest;
    const history = data[pantryId].history;
    if (!pantry) {
      continue;
    }

    await checkBattery(pantryId, topic, pantry, history);
    await checkCalibration(pantryId, topic, pantry, history);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
