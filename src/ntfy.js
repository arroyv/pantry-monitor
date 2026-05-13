const NTFY_SERVER = "https://ntfy.sh";

const PANTRY_TOPIC_MAP = {
  HallerLakePantry: "pantry-monitor-HallerLake",
  Greenwood: "pantry-monitor-GreenWood",
  BeaconHill: "pantry-monitor-BeaconHill",
  StPaulChurchPantry: "pantry-monitor-StPaulChurch",
};

const BATTERY_TYPES = new Set(["battery", "batt_drain", "pressure"]);

// Persists across 5-min polls; cleared on page reload
const _alerted = new Set();

export async function notifyBatteryIssues(pantryId, issues) {
  console.log(
    `[ntfy] ${pantryId} — issues:`,
    issues.map((i) => i.t),
  );
  const topic = PANTRY_TOPIC_MAP[pantryId];
  console.log(`[ntfy] ${pantryId} — topic resolved to:`, topic);
  if (!topic) return; // unmapped pantry, skip silently

  const batteryIssues = issues.filter((i) => BATTERY_TYPES.has(i.t));

  for (const issue of batteryIssues) {
    const key = `${pantryId}::${issue.t}::${issue.s}`;
    if (_alerted.has(key)) continue; // already sent this session

    try {
      await fetch(`${NTFY_SERVER}/${topic}`, {
        method: "POST",
        headers: {
          Title: `${issue.s} - ${issue.t}`,
        },
        body: issue.m,
      });
      _alerted.add(key);
      console.log(`[ntfy] Sent: ${key}`);
    } catch (err) {
      console.error(`[ntfy] Failed for ${pantryId}:`, err);
    }
  }
}
