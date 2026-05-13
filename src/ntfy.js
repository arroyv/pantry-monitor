const NTFY_SERVER = "https://ntfy.sh";

const PANTRY_TOPIC_MAP = {
  HallerLakePantry: "pantry-monitor-HallerLake",
  Greenwood: "pantry-monitor-GreenWood",
  BeaconHill: "pantry-monitor-BeaconHill",
  StPaulChurchPantry: "pantry-monitor-StPaulChurch",
};

const BATTERY_TYPES = new Set(["battery", "batt_drain"]);

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
          Title: `${issue.s === "critical" ? "🔴 CRITICAL" : "🟡 Warning"} — ${pantryId}`,
          Priority: issue.s === "critical" ? "urgent" : "high",
          Tags:
            issue.s === "critical"
              ? "rotating_light,battery"
              : "warning,battery",
          "Content-Type": "text/plain",
        },
        body: issue.m, // e.g. "Battery critical: 8%" or "Battery draining 18%/day, ~2 days left"
      });
      _alerted.add(key);
      console.log(`[ntfy] Sent: ${key}`);
    } catch (err) {
      console.error(`[ntfy] Failed for ${pantryId}:`, err);
    }
  }
}
