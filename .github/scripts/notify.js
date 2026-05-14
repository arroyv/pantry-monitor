const API_URL =
  "https://pantryapi-web-d8gzfkftgtb5cfhn.westus2-01.azurewebsites.net/api/GetLatestPantry?pantryId=all&mode=monitor";
const NTFY_SERVER = "https://ntfy.sh";

const PANTRY_TOPIC_MAP = {
  HallerLakePantry: "pantry-monitor-HallerLake",
  Greenwood: "pantry-monitor-GreenWood",
  BeaconHill: "pantry-monitor-BeaconHill",
  StPaulChurchPantry: "pantry-monitor-StPaulChurch",
};

const BATT_LOW = 20;
const BATT_CRITICAL = 10;
const PRES_MIN = 800;
const PRES_MAX = 1200;

async function sendAlert(topic, title, priority, tags, body) {
  await fetch(`${NTFY_SERVER}/${topic}`, {
    method: "POST",
    headers: {
      Title: title,
      Priority: priority,
      Tags: tags,
      "Content-Type": "text/plain",
    },
    body,
  });
  console.log(`[ntfy] Sent: ${title}`);
}

async function checkBattery(pantryId, topic, data) {
  const batt = Number(data.batt_percent);
  if (isNaN(batt)) return;

  if (batt <= BATT_CRITICAL) {
    await sendAlert(
      topic,
      `CRITICAL Battery - ${pantryId}`,
      "urgent",
      "rotating_light,battery",
      `Battery at ${batt}%. Replace immediately!`,
    );
  } else if (batt <= BATT_LOW) {
    await sendAlert(
      topic,
      `Warning Battery - ${pantryId}`,
      "high",
      "warning,battery",
      `Battery at ${batt}%. Replace soon.`,
    );
  } else {
    console.log(`[ok] ${pantryId} battery healthy at ${batt}%`);
  }
}

async function checkPressure(pantryId, topic, data) {
  const pres = Number(data.air_pressure);
  if (isNaN(pres) || pres <= 0) return;

  if (pres < PRES_MIN || pres > PRES_MAX) {
    await sendAlert(
      topic,
      `Warning Pressure - ${pantryId}`,
      "high",
      "warning,sos",
      `Pressure sensor fault: ${pres} hPa (expected ${PRES_MIN}-${PRES_MAX})`,
    );
  } else {
    console.log(`[ok] ${pantryId} pressure normal at ${pres} hPa`);
  }
}

async function main() {
  const res = await fetch(API_URL);
  const data = await res.json();

  for (const [pantryId, topic] of Object.entries(PANTRY_TOPIC_MAP)) {
    const pantry = data[pantryId];
    if (!pantry) {
      console.log(`[skip] ${pantryId} — no data`);
      continue;
    }

    await checkBattery(pantryId, topic, pantry);
    await checkPressure(pantryId, topic, pantry);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
