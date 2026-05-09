import { useState, useEffect, useCallback, useRef, useMemo } from "react";

/* ═══════════════════════════════════════════════════════════════════
   STORAGE
   ═══════════════════════════════════════════════════════════════════ */
function sGet(k, fb) { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : fb; } catch { return fb; } }
function sSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

/* ═══════════════════════════════════════════════════════════════════
   THRESHOLDS
   ═══════════════════════════════════════════════════════════════════ */
const DEFS = {
  staleMinutes: 60, offlineHours: 24,
  battLow: 20, battCritical: 10,
  tempMin: -5, tempMax: 40, humidityMax: 95,
  scaleMin: -2, scaleMax: 50,
  flatlineWindow: 6, spikeZ: 3.0, intervalDriftX: 3, rollingN: 30,
  iaqWarn: 150, iaqCrit: 250, eco2Warn: 1000, eco2Crit: 2000,
  rssiWarn: -85, rssiCrit: -90,
  doorSustainedMin: 30, doorDailyHigh: 50,
  eventBurstPerHour: 20, memDropPct: 15,
  battDrainPerDay: 5,
};
const TMETA = {
  staleMinutes:       { l: "Stale (min)",          g: "Connectivity", d: "Warn if no data this many minutes" },
  offlineHours:       { l: "Offline (hours)",       g: "Connectivity", d: "Critical if no data this long" },
  rssiWarn:           { l: "RSSI warn (dBm)",       g: "Connectivity", d: "Signal strength warning" },
  rssiCrit:           { l: "RSSI critical (dBm)",   g: "Connectivity", d: "Signal strength critical" },
  intervalDriftX:     { l: "Interval drift X",      g: "Connectivity", d: "Flag gap > Nx median" },
  battLow:            { l: "Battery low (%)",       g: "Power",        d: "Warning threshold" },
  battCritical:       { l: "Battery critical (%)",  g: "Power",        d: "Critical threshold" },
  battDrainPerDay:    { l: "Drain alert (%/day)",   g: "Power",        d: "Flag if draining faster" },
  tempMin:            { l: "Temp min (C)",          g: "Environment",  d: "Below = out of range" },
  tempMax:            { l: "Temp max (C)",          g: "Environment",  d: "Above = out of range" },
  humidityMax:        { l: "Humidity max (%)",      g: "Environment",  d: "Above = warning" },
  iaqWarn:            { l: "IAQ warn",              g: "Environment",  d: "Air quality index warning" },
  iaqCrit:            { l: "IAQ critical",          g: "Environment",  d: "Air quality index critical" },
  eco2Warn:           { l: "eCO2 warn (ppm)",       g: "Environment",  d: "Estimated CO2 warning" },
  eco2Crit:           { l: "eCO2 critical (ppm)",   g: "Environment",  d: "Estimated CO2 critical" },
  scaleMin:           { l: "Scale min (lbs)",       g: "Scales",       d: "Below = miscalibrated" },
  scaleMax:           { l: "Scale max (lbs)",       g: "Scales",       d: "Above = suspicious" },
  doorSustainedMin:   { l: "Door open alert (min)", g: "Doors",        d: "Alert if open this long" },
  doorDailyHigh:      { l: "Door opens/day high",   g: "Doors",        d: "Unusual door activity" },
  eventBurstPerHour:  { l: "Event burst (/hr)",     g: "Events",       d: "Too many events per hour" },
  flatlineWindow:     { l: "Flatline samples",      g: "Time Series",  d: "Identical readings to flag" },
  spikeZ:             { l: "Spike z-threshold",     g: "Time Series",  d: "Std devs from rolling mean" },
  rollingN:           { l: "Rolling window",         g: "Time Series",  d: "Samples for rolling stats" },
  memDropPct:         { l: "Memory drop (%)",       g: "System",       d: "Flag if free mem drops by this %" },
};

/* ═══════════════════════════════════════════════════════════════════
   ANALYSIS ENGINE
   ═══════════════════════════════════════════════════════════════════ */
const toBool = v => v === true || v === 1 || String(v).toLowerCase() === "true";
const N = v => { const n = Number(v); return isNaN(n) ? null : n; };
const fKey = k => ({ air_temp:"Temp", air_humid:"Humidity", scale1:"Scale 1", scale2:"Scale 2", scale3:"Scale 3", scale4:"Scale 4", batt_percent:"Battery", iaq:"IAQ", static_iaq:"Static IAQ", eco2:"eCO2", bvoc:"bVOC", gas_resistance:"Gas Res", rssi:"RSSI", memory_free:"Memory" }[k] || k);

function pointChecks(row, T, history) {
  const iss = [];
  if (!row?.timestamp) { iss.push({ s:"critical", t:"no_data", m:"No data received", g:"Connectivity" }); return iss; }
  const ageMin = (Date.now() - new Date(row.timestamp).getTime()) / 60000;
  if (ageMin > T.offlineHours * 60) iss.push({ s:"critical", t:"offline", m:`No data for ${Math.round(ageMin/60)}h`, g:"Connectivity" });
  else if (ageMin > T.staleMinutes) iss.push({ s:"warning", t:"stale", m:`Last data ${fAge(ageMin)} ago`, g:"Connectivity" });

  const b = N(row.batt_percent);
  if (b !== null) {
    if (b <= T.battCritical) iss.push({ s:"critical", t:"battery", m:`Battery critical: ${b}%`, g:"Power" });
    else if (b <= T.battLow) iss.push({ s:"warning", t:"battery", m:`Battery low: ${b}%`, g:"Power" });
    if (b > 100) iss.push({ s:"info", t:"batt_cal", m:`Battery ${b}% (needs calibration)`, g:"Power" });
  }

  const temp = N(row.air_temp);
  if (temp !== null && (temp < T.tempMin || temp > T.tempMax)) iss.push({ s:"warning", t:"temp", m:`Temp out of range: ${temp}C`, g:"Environment" });
  const hum = N(row.air_humid);
  if (hum !== null && hum > T.humidityMax) iss.push({ s:"warning", t:"humidity", m:`Humidity high: ${hum}%`, g:"Environment" });
  const pres = N(row.air_pressure);
  if (pres !== null && pres > 0 && (pres < 800 || pres > 1200))
    iss.push({ s:"warning", t:"pressure", m:`Pressure sensor fault: ${pres} hPa (expected 800-1200)`, g:"Environment" });

  const iaq = N(row.iaq);
  if (iaq !== null && iaq > 0) {
    if (iaq >= T.iaqCrit) iss.push({ s:"critical", t:"iaq", m:`IAQ poor: ${iaq}`, g:"Environment" });
    else if (iaq >= T.iaqWarn) iss.push({ s:"warning", t:"iaq", m:`IAQ moderate: ${iaq}`, g:"Environment" });
  }
  const eco2 = N(row.eco2);
  if (eco2 !== null && eco2 > 0) {
    if (eco2 >= T.eco2Crit) iss.push({ s:"critical", t:"eco2", m:`eCO2 high: ${eco2} ppm`, g:"Environment" });
    else if (eco2 >= T.eco2Warn) iss.push({ s:"warning", t:"eco2", m:`eCO2 elevated: ${eco2} ppm`, g:"Environment" });
  }

  const foodT = N(row.food_temp);
  // Only flag food probe if it was previously connected (history shows a value != -127)
  // Devices that never had a probe always read -127 — suppress to reduce noise
  if (foodT === -127 && history && history.some(r => { const v = N(r.food_temp); return v !== null && v !== -127; }))
    iss.push({ s:"info", t:"food_probe", m:"Food temp probe disconnected (-127)", g:"Environment" });

  const rssi = N(row.rssi);
  if (rssi !== null) {
    if (rssi < T.rssiCrit) iss.push({ s:"critical", t:"rssi", m:`RSSI very weak: ${rssi} dBm`, g:"Connectivity" });
    else if (rssi < T.rssiWarn) iss.push({ s:"warning", t:"rssi", m:`RSSI weak: ${rssi} dBm`, g:"Connectivity" });
  }

  for (let i = 1; i <= 4; i++) {
    const v = N(row[`scale${i}`]);
    if (v !== null) {
      if (v < T.scaleMin) iss.push({ s:"warning", t:"scale_neg", m:`Scale ${i} negative: ${v} lbs`, g:"Scales" });
      if (v > T.scaleMax) iss.push({ s:"warning", t:"scale_high", m:`Scale ${i} high: ${v} lbs`, g:"Scales" });
    }
    if (toBool(row[`scale${i}_disconnect`])) iss.push({ s:"critical", t:"scale_disc", m:`Scale ${i} disconnected`, g:"Scales" });
    if (toBool(row[`scale${i}_suspect`])) iss.push({ s:"warning", t:"scale_susp", m:`Scale ${i} suspect`, g:"Scales" });
  }

  if (!toBool(row.is_event)) {
    if (toBool(row.door1_open)) iss.push({ s:"info", t:"door", m:"Door 1 open", g:"Doors" });
    if (toBool(row.door2_open)) iss.push({ s:"info", t:"door", m:"Door 2 open", g:"Doors" });
  }

  const acc = N(row.accuracy);
  // Only flag per-reading if it changed recently; if all history is 0 the ts-check bsec_stuck covers it
  if (acc === 0 && history && history.some(r => { const v = N(r.accuracy); return v !== null && v > 0; }))
    iss.push({ s:"info", t:"bsec", m:"BSEC uncalibrated (accuracy=0)", g:"System" });

  return iss;
}

function timeSeriesChecks(history, T) {
  const iss = [];
  if (!history || history.length < 3) return iss;
  const sorted = [...history].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const len = sorted.length;
  const spanHours = (new Date(sorted[len-1].timestamp) - new Date(sorted[0].timestamp)) / 3.6e6;

  // ── Interval drift ──
  // Only use gaps >= 1 min so event-driven bursts (seconds apart) don't drag median to ~0
  const gaps = [];
  for (let i = 1; i < len; i++) {
    const g = (new Date(sorted[i].timestamp) - new Date(sorted[i-1].timestamp)) / 60000;
    if (g >= 1) gaps.push(g);
  }
  if (gaps.length > 2) {
    const med = [...gaps].sort((a,b) => a-b)[Math.floor(gaps.length/2)];
    const last = gaps[gaps.length-1];
    if (med > 0 && last > med * T.intervalDriftX)
      iss.push({ s:"warning", t:"interval_drift", m:`Reporting gap ${Math.round(last)}min (${(last/med).toFixed(1)}x median ${Math.round(med)}min)`, g:"Connectivity" });
  }

  // ── Flatline + Spike on ALL numeric fields ──
  const numericFields = ["air_temp","air_humid","scale1","scale2","scale3","scale4","batt_percent","iaq","static_iaq","eco2","gas_resistance","rssi","memory_free"];
  for (const key of numericFields) {
    const vals = sorted.map(r => N(r[key])).filter(v => v !== null);
    if (vals.length < 3) continue;
    // Skip fields that are all zero (sensor not active)
    if (vals.every(v => v === 0)) continue;

    const win = vals.slice(-T.rollingN);
    const mean = win.reduce((a,b) => a+b, 0) / win.length;
    const std = Math.sqrt(win.reduce((a,b) => a + (b-mean)**2, 0) / win.length);

    const tail = vals.slice(-T.flatlineWindow);
    if (tail.length >= T.flatlineWindow && tail.every(v => v === tail[0]) && key !== "batt_percent")
      iss.push({ s:"warning", t:"flatline", m:`${fKey(key)} flatlined at ${tail[0]} for ${tail.length} readings`, g:"Time Series" });

    if (std > 0.001) {
      const latest = vals[vals.length-1];
      const z = Math.abs((latest - mean) / std);
      if (z > T.spikeZ)
        iss.push({ s:"warning", t:"spike", m:`${fKey(key)} spike: ${latest} (z=${z.toFixed(1)}, mean=${mean.toFixed(1)})`, g:"Time Series" });
    }
  }

  // ── All-zero correlation ──
  const last = sorted[len-1];
  const scalesZero = [1,2,3,4].every(i => N(last[`scale${i}`]) === 0);
  const envZero = N(last.air_humid) === 0 && N(last.air_temp) === 0;
  if (scalesZero && envZero)
    iss.push({ s:"critical", t:"all_zero", m:"All sensors zero -- device fault or powered off", g:"System" });

  // ── Battery drain ──
  const batt = sorted.map(r => ({ ts: new Date(r.timestamp).getTime(), v: N(r.batt_percent) })).filter(b => b.v !== null && b.v > 0 && b.v <= 100);
  if (batt.length >= 5) {
    const hrs = (batt[batt.length-1].ts - batt[0].ts) / 3.6e6;
    if (hrs > 1) {
      const drain = ((batt[0].v - batt[batt.length-1].v) / hrs) * 24;
      if (drain > T.battDrainPerDay) {
        const left = batt[batt.length-1].v / drain;
        iss.push({ s: drain > 15 ? "critical" : "warning", t:"batt_drain", m:`Battery draining ${drain.toFixed(1)}%/day, ~${Math.round(left)} days left`, g:"Power" });
      }
    }
  }

  // ── RSSI trend ──
  const rssiVals = sorted.map(r => N(r.rssi)).filter(v => v !== null);
  if (rssiVals.length >= 10) {
    const firstHalf = rssiVals.slice(0, Math.floor(rssiVals.length/2));
    const secondHalf = rssiVals.slice(Math.floor(rssiVals.length/2));
    const avgFirst = firstHalf.reduce((a,b)=>a+b,0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((a,b)=>a+b,0) / secondHalf.length;
    if (avgSecond < avgFirst - 5)
      iss.push({ s:"warning", t:"rssi_trend", m:`RSSI degrading: ${avgFirst.toFixed(0)} -> ${avgSecond.toFixed(0)} dBm over ${Math.round(spanHours)}h`, g:"Connectivity" });
  }

  // ── Memory leak ──
  const memVals = sorted.map(r => N(r.memory_free)).filter(v => v !== null && v > 0);
  if (memVals.length >= 10) {
    const maxMem = Math.max(...memVals.slice(0, 5));
    const recentMem = memVals.slice(-5).reduce((a,b)=>a+b,0) / 5;
    if (maxMem > 0 && ((maxMem - recentMem) / maxMem) * 100 > T.memDropPct)
      iss.push({ s:"warning", t:"mem_leak", m:`Memory dropped ${Math.round(((maxMem-recentMem)/maxMem)*100)}%: ${Math.round(maxMem/1024)}KB -> ${Math.round(recentMem/1024)}KB`, g:"System" });
  }

  // ── BSEC calibration stuck ──
  const accVals = sorted.slice(-20).map(r => N(r.accuracy)).filter(v => v !== null);
  if (accVals.length >= 10 && accVals.every(v => v === 0))
    iss.push({ s:"warning", t:"bsec_stuck", m:`BSEC stuck uncalibrated for ${accVals.length} readings`, g:"System" });

  // ── Door analysis ──
  if (spanHours > 1) {
    const days = spanHours / 24;
    // Door open events
    for (let d = 1; d <= 2; d++) {
      const opens = sorted.filter(r => toBool(r[`door${d}_open`]));
      const opensPerDay = opens.length / Math.max(days, 0.1);

      if (opensPerDay > T.doorDailyHigh)
        iss.push({ s:"warning", t:"door_busy", m:`Door ${d}: ${Math.round(opensPerDay)} opens/day (high)`, g:"Doors" });

      // Check if door is never used (0 opens over >2 days)
      if (opens.length === 0 && days > 2)
        iss.push({ s:"info", t:"door_unused", m:`Door ${d}: no activity in ${Math.round(days)} days`, g:"Doors" });

      // Sustained open: look for consecutive open readings
      let maxConsec = 0, cur = 0;
      for (const r of sorted) {
        if (toBool(r[`door${d}_open`])) cur++; else { maxConsec = Math.max(maxConsec, cur); cur = 0; }
      }
      maxConsec = Math.max(maxConsec, cur);
      if (maxConsec >= 2) {
        // Estimate duration from gap between those readings
        let startIdx = -1;
        for (let i = 0; i < sorted.length; i++) {
          if (toBool(sorted[i][`door${d}_open`])) { if (startIdx === -1) startIdx = i; }
          else { if (startIdx !== -1 && i - startIdx >= maxConsec) break; startIdx = -1; }
        }
        if (startIdx !== -1 && startIdx + maxConsec - 1 < sorted.length) {
          const durMin = (new Date(sorted[Math.min(startIdx + maxConsec - 1, len-1)].timestamp) - new Date(sorted[startIdx].timestamp)) / 60000;
          if (durMin >= T.doorSustainedMin)
            iss.push({ s:"warning", t:"door_sustained", m:`Door ${d} open ~${Math.round(durMin)}min (${maxConsec} readings)`, g:"Doors" });
        }
      }
    }

    // Event rate analysis
    const events = sorted.filter(r => toBool(r.is_event));
    if (events.length > 0) {
      // Check for bursts: events per hour in sliding windows
      const hourBuckets = {};
      for (const e of events) {
        const h = Math.floor(new Date(e.timestamp).getTime() / 3.6e6);
        hourBuckets[h] = (hourBuckets[h] || 0) + 1;
      }
      const maxPerHour = Math.max(...Object.values(hourBuckets));
      if (maxPerHour > T.eventBurstPerHour)
        iss.push({ s:"warning", t:"event_burst", m:`Event burst: ${maxPerHour} events in 1 hour`, g:"Events" });

      // Event rate change: compare first half vs second half
      const midTs = new Date((new Date(sorted[0].timestamp).getTime() + new Date(sorted[len-1].timestamp).getTime()) / 2);
      const firstEvents = events.filter(e => new Date(e.timestamp) < midTs).length;
      const secondEvents = events.filter(e => new Date(e.timestamp) >= midTs).length;
      if (firstEvents > 0 && secondEvents / Math.max(firstEvents, 1) > 3)
        iss.push({ s:"info", t:"event_increase", m:`Event rate increased: ${firstEvents} -> ${secondEvents} (first vs second half)`, g:"Events" });
      if (secondEvents === 0 && firstEvents > 5)
        iss.push({ s:"warning", t:"event_silence", m:`Events stopped: ${firstEvents} in first half, 0 in second`, g:"Events" });
    }

    // Ambient trends: temp/humidity direction over the week
    const tempVals = sorted.map(r => N(r.air_temp)).filter(v => v !== null && v !== 0);
    if (tempVals.length >= 20) {
      const earlyAvg = tempVals.slice(0, 10).reduce((a,b)=>a+b,0) / 10;
      const lateAvg = tempVals.slice(-10).reduce((a,b)=>a+b,0) / 10;
      const delta = lateAvg - earlyAvg;
      if (Math.abs(delta) > 3)
        iss.push({ s:"info", t:"temp_trend", m:`Temp trending ${delta > 0 ? "up" : "down"}: ${earlyAvg.toFixed(1)} -> ${lateAvg.toFixed(1)}C over ${Math.round(spanHours)}h`, g:"Environment" });
    }

    // Gas resistance drift (sensor aging: decreasing resistance over time)
    const gasVals = sorted.map(r => N(r.gas_resistance)).filter(v => v !== null && v > 0);
    if (gasVals.length >= 20) {
      const earlyAvg = gasVals.slice(0, 10).reduce((a,b)=>a+b,0) / 10;
      const lateAvg = gasVals.slice(-10).reduce((a,b)=>a+b,0) / 10;
      if (earlyAvg > 0) {
        const changePct = ((lateAvg - earlyAvg) / earlyAvg) * 100;
        if (Math.abs(changePct) > 50)
          iss.push({ s:"info", t:"gas_drift", m:`Gas resistance ${changePct > 0 ? "increased" : "decreased"} ${Math.abs(changePct).toFixed(0)}% over ${Math.round(spanHours)}h`, g:"Environment" });
      }
    }
  }

  return iss;
}

/* ═══════════════════════════════════════════════════════════════════
   ROOT CAUSE ATTRIBUTION & DATA QUALITY
   ═══════════════════════════════════════════════════════════════════ */
const ISSUE_CLASS = {
  // Hardware indicators
  scale_disc:     { cat:"hardware",     act:"Check scale wiring and load cell connections" },
  food_probe:     { cat:"hardware",     act:"Reconnect food temperature probe" },
  flatline:       { cat:"hardware",     act:"Sensor may be stuck — check wiring or replace" },
  spike:          { cat:"hardware",     act:"Check for loose wiring or electrical interference" },
  battery:        { cat:"hardware",     act:"Replace or recharge battery" },
  batt_drain:     { cat:"hardware",     act:"Battery draining fast — check for power-hungry firmware loop or replace battery" },
  // Software / firmware indicators
  mem_leak:       { cat:"software",     act:"Memory leak — restart device or update firmware" },
  bsec:           { cat:"software",     act:"BSEC library still calibrating — usually resolves on its own" },
  bsec_stuck:     { cat:"software",     act:"BSEC calibration stuck — restart device or update firmware" },
  scale_susp:     { cat:"software",     act:"Firmware flagged suspect reading — may need recalibration" },
  batt_cal:       { cat:"software",     act:"Battery ADC calibration off — firmware issue, not dangerous" },
  // Environmental
  temp:           { cat:"environment",  act:"Check pantry location — direct sunlight? Heating vent nearby?" },
  humidity:       { cat:"environment",  act:"Check for water ingress or poor ventilation" },
  iaq:            { cat:"environment",  act:"Poor air quality — check ventilation around pantry" },
  eco2:           { cat:"environment",  act:"Elevated CO₂ — enclosed space with poor airflow" },
  temp_trend:     { cat:"environment",  act:"Gradual temp shift — seasonal change or new heat source nearby?" },
  gas_drift:      { cat:"environment",  act:"Gas resistance shifting — sensor aging or environment change" },
  // Connectivity
  offline:        { cat:"connectivity", act:"Device not reporting — check power and WiFi/cellular signal" },
  stale:          { cat:"connectivity", act:"Delayed reporting — may be intermittent connectivity" },
  rssi:           { cat:"connectivity", act:"Weak signal — move device or add antenna/repeater" },
  rssi_trend:     { cat:"connectivity", act:"Signal degrading — check for new interference sources" },
  interval_drift: { cat:"connectivity", act:"Irregular reporting — connectivity drops or firmware sleep issues" },
  // Ambiguous (could be HW or SW)
  all_zero:       { cat:"device",       act:"All sensors zero — device crash or total power loss. Restart device." },
  scale_neg:      { cat:"device",       act:"Negative scale — could be miscalibration (SW) or a shifted load cell (HW)" },
  scale_high:     { cat:"device",       act:"Very high scale reading — check for objects on scale or recalibrate" },
  no_data:        { cat:"connectivity", act:"No data at all — verify device is powered on and network is reachable" },
  // Operational (not a malfunction)
  door:           { cat:"operational",  act:"Door is currently open — normal if someone is visiting" },
  door_sustained: { cat:"operational",  act:"Door open a long time — may be propped for stocking" },
  door_busy:      { cat:"operational",  act:"High door activity — popular pantry!" },
  door_unused:    { cat:"operational",  act:"Door not used — check if door sensor is still attached" },
  event_burst:    { cat:"operational",  act:"Event burst — could be stocking or multiple visitors" },
  event_increase: { cat:"operational",  act:"More activity recently — growing usage is good!" },
  event_silence:  { cat:"operational",  act:"Activity dropped off — check if door sensor is working" },
};

const CAT_META = {
  hardware:     { icon:"🔧", label:"Hardware",      color:"#f0883e" },
  software:     { icon:"💻", label:"Software",      color:"#a371f7" },
  environment:  { icon:"🌡",  label:"Environmental", color:"#3fb950" },
  connectivity: { icon:"📡", label:"Connectivity",  color:"#58a6ff" },
  device:       { icon:"⚡", label:"Device-Level",  color:"#f85149" },
  operational:  { icon:"🚪", label:"Operational",   color:"#d29922" },
};

function diagnose(issues, history) {
  const cats = {};
  const actions = [];

  for (const iss of issues) {
    const cls = ISSUE_CLASS[iss.t] || { cat: "unknown", act: iss.m };
    if (!cats[cls.cat]) cats[cls.cat] = [];
    cats[cls.cat].push({ ...iss, action: cls.act });
    actions.push({ issue: iss, ...cls });
  }

  // Cross-sensor correlation: check if multiple scale disconnects happen together
  const discCount = issues.filter(i => i.t === "scale_disc").length;
  let correlation = null;
  if (discCount >= 2) {
    correlation = { type: "multi_scale_fail", cat: "device",
      msg: `${discCount} scales disconnected simultaneously — likely a device-level wiring or power issue, not individual sensors`,
      act: "Check the main wiring harness / I2C bus connecting all load cells" };
  }
  // Check for correlated zero + offline
  const hasAllZero = issues.some(i => i.t === "all_zero");
  const hasOffline = issues.some(i => i.t === "offline" || i.t === "stale");
  if (hasAllZero && hasOffline && !correlation) {
    correlation = { type: "power_failure", cat: "hardware",
      msg: "All sensors zero AND device going offline — likely a power supply failure",
      act: "Check battery connections, charging circuit, and solar panel (if applicable)" };
  }
  // Scale flatline + suspect together = firmware issue
  const hasFlatScale = issues.some(i => i.t === "flatline" && i.m.includes("Scale"));
  const hasSusp = issues.some(i => i.t === "scale_susp");
  if (hasFlatScale && hasSusp && !correlation) {
    correlation = { type: "firmware_scale", cat: "software",
      msg: "Scale flatlined AND firmware flagged suspect — likely a firmware/ADC sampling issue",
      act: "Restart device. If persists, update firmware — the HX711 driver may need a fix" };
  }

  return { cats, actions, correlation };
}

function dataQuality(history, T) {
  if (!history || history.length === 0)
    return { score: 0, freshness: 0, completeness: 0, consistency: 0, details: "No data" };
  const sorted = [...history].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const len = sorted.length;

  // Freshness: how recent is latest? 100 = just now, 0 = offline threshold
  const ageMin = (Date.now() - new Date(sorted[len - 1].timestamp).getTime()) / 60000;
  const freshness = Math.max(0, Math.min(100, Math.round(100 - (ageMin / (T.offlineHours * 60)) * 100)));

  // Completeness: actual readings vs expected (median interval)
  const gaps = [];
  for (let i = 1; i < len; i++) gaps.push((new Date(sorted[i].timestamp) - new Date(sorted[i - 1].timestamp)) / 60000);
  const medInterval = gaps.length > 0 ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 10;
  const spanMin = (new Date(sorted[len - 1].timestamp) - new Date(sorted[0].timestamp)) / 60000;
  const expected = Math.max(1, spanMin / Math.max(medInterval, 1));
  const completeness = Math.min(100, Math.round((len / expected) * 100));

  // Consistency: % of readings where key fields are non-null
  const keyFields = ["air_temp", "air_humid", "scale1", "scale2", "scale3", "scale4", "batt_percent", "rssi"];
  let valid = 0;
  for (const r of sorted) {
    if (keyFields.every(f => N(r[f]) !== null)) valid++;
  }
  const consistency = Math.round((valid / len) * 100);

  const score = Math.round(freshness * 0.4 + completeness * 0.3 + consistency * 0.3);
  return { score, freshness, completeness, consistency };
}

function fAge(m) {
  if (m < 1) return "just now"; if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h ${Math.round(m%60)}m`;
  return `${Math.floor(h/24)}d ${Math.floor(h%24)}h`;
}

function getSev(issues) {
  if (issues.some(i => i.s === "critical")) return "critical";
  if (issues.some(i => i.s === "warning")) return "warning";
  if (issues.some(i => i.s === "info")) return "info";
  return "ok";
}

/* ═══════════════════════════════════════════════════════════════════
   DEMO DATA (1 week, realistic patterns)
   ═══════════════════════════════════════════════════════════════════ */
function genDemo() {
  const now = Date.now();
  const WEEK = 7 * 24 * 60;
  const make = (id, intMin, bT, bB, q = {}) => {
    const count = Math.floor(WEEK / intMin);
    const h = [];
    for (let i = count - 1; i >= 0; i--) {
      const ts = new Date(now - (i * intMin + (Math.random()-0.5) * intMin * 0.2) * 60000);
      const dayFrac = (i * intMin % 1440) / 1440;
      const weekFrac = i / count;
      const isDoorEvent = Math.random() < (q.doorFreq || 0.15);
      const temp = bT + Math.sin(dayFrac * Math.PI * 2) * 3 + (Math.random()-0.5) * 0.5 + (q.tempRise ? (1-weekFrac) * 4 : 0);
      h.push({
        device_id: id, timestamp: ts.toISOString(),
        is_event: isDoorEvent,
        air_temp: +temp.toFixed(2),
        air_humid: +(60 + Math.sin(dayFrac * Math.PI * 2) * 15 + (Math.random()-0.5) * 3).toFixed(1),
        air_pressure: 10,
        gas_resistance: Math.round(80000 + Math.random() * 40000 + (q.gasDrift ? weekFrac * 100000 : 0)),
        iaq: Math.round(30 + Math.random() * (q.iaqHigh ? 200 : 40) + (q.iaqHigh && i < 20 ? 150 : 0)),
        static_iaq: Math.round(25 + Math.random() * 30),
        eco2: Math.round(400 + Math.random() * (q.eco2High ? 1500 : 200)),
        bvoc: +(0.5 + Math.random() * 2).toFixed(2),
        accuracy: q.bsecStuck ? 0 : (Math.random() > 0.3 ? 3 : Math.floor(Math.random() * 3)),
        food_temp: q.foodProbe ? +(2 + Math.random() * 3).toFixed(1) : -127,
        batt_percent: Math.max(0, Math.round(bB - weekFrac * (q.fastDrain ? 40 : 6) + (Math.random()-0.5) * 2)),
        batt_voltage: +(3.3 + (1-weekFrac) * 0.8).toFixed(2),
        rssi: Math.round(-70 - Math.random() * 10 + (q.rssiDegrade ? -weekFrac * 15 : 0)),
        memory_free: Math.round(110000 - (q.memLeak ? weekFrac * 30000 : 0) + (Math.random()-0.5) * 5000),
        scale1: q.flatScale ? 4.57 : +(3 + Math.random() * 4 + Math.sin(i*0.05) * 2).toFixed(2),
        scale2: +(2 + Math.random() * 3 + Math.sin(i*0.07) * 1.5).toFixed(2),
        scale3: +(1 + Math.random() * 3).toFixed(2),
        scale4: +(4 + Math.random() * 5 + (i === 0 && q.spikeS4 ? 35 : 0)).toFixed(2),
        door1_open: isDoorEvent && Math.random() > 0.3,
        door2_open: isDoorEvent && Math.random() > (q.noDoor2 ? 1.0 : 0.5),
        scale1_disconnect: !!(q.disc1 && i < 5),
        scale2_disconnect: false, scale3_disconnect: false, scale4_disconnect: false,
        scale1_suspect: false, scale2_suspect: !!(q.susp2 && i < 10),
        scale3_suspect: false, scale4_suspect: false,
        ...(q.allZero && i < 3 ? { air_temp:0, air_humid:0, scale1:0, scale2:0, scale3:0, scale4:0, iaq:0, eco2:0 } : {}),
      });
    }
    return h;
  };
  return {
    BeaconHill: make("BeaconHill", 10, 5.5, 85, { flatScale: true, tempRise: true }),
    Greenwood: make("Greenwood", 30, 1.2, 18, { allZero: true, fastDrain: true, noDoor2: true, rssiDegrade: true }),
    StPaulChurchPantry: make("StPaulChurchPantry", 15, 8.0, 103, { spikeS4: true, susp2: true, iaqHigh: true, eco2High: true, doorFreq: 0.6, bsecStuck: true }),
    NewSite_Demo: make("NewSite_Demo", 20, 6.0, 65, { disc1: true, memLeak: true, gasDrift: true, foodProbe: true }),
  };
}

/* ═══════════════════════════════════════════════════════════════════
   COLORS + STYLES
   ═══════════════════════════════════════════════════════════════════ */
const C = {
  bg:"#080c10", card:"#0d1117", border:"#1b2332", borderL:"#253040",
  tx:"#c9d1d9", txD:"#6e7681", txM:"#484f58",
  acc:"#58a6ff", accD:"#1f6feb20",
  cr:"#f85149", crB:"#f8514910", crBr:"#f8514930",
  wr:"#d29922", wrB:"#d2992210", wrBr:"#d2992230",
  in:"#58a6ff", inB:"#58a6ff10", inBr:"#58a6ff30",
  ok:"#3fb950", okB:"#3fb95010", okBr:"#3fb95030",
};
const SC = { critical:C.cr, warning:C.wr, info:C.in, ok:C.ok };
const SB = { critical:C.crB, warning:C.wrB, info:C.inB, ok:C.okB };
const SR = { critical:C.crBr, warning:C.wrBr, info:C.inBr, ok:C.okBr };

const GROUPS = ["Scales","Doors","Connectivity","Power","Environment","Events","Time Series","System"];
const GROUP_ICONS = { Connectivity:"📡", Power:"🔋", Environment:"🌡", Scales:"⚖", Doors:"🚪", Events:"⚡", "Time Series":"📈", System:"💾" };

/* ═══════════════════════════════════════════════════════════════════
   SMALL COMPONENTS
   ═══════════════════════════════════════════════════════════════════ */
const Dot = ({ s, sz=8 }) => <span style={{ display:"inline-block", width:sz, height:sz, borderRadius:"50%", backgroundColor:SC[s], boxShadow:`0 0 ${sz}px ${SC[s]}60`, animation:s==="critical"?"blink 1.4s infinite":"none", flexShrink:0 }}/>;
const Tag = ({ s, children }) => <span style={{ display:"inline-flex", padding:"1px 7px", borderRadius:3, fontSize:10, fontWeight:700, letterSpacing:"0.6px", textTransform:"uppercase", color:SC[s], backgroundColor:SB[s], border:`1px solid ${SR[s]}` }}>{children}</span>;
const Metric = ({ label, value, unit, w }) => (
  <div style={{ padding:"6px 10px", borderRadius:5, minWidth:75, backgroundColor: w ? (w==="critical"?C.crB:C.wrB) : `${C.border}50`, border:`1px solid ${w?(w==="critical"?C.crBr:C.wrBr):C.border}` }}>
    <div style={{ fontSize:10, color:C.txM, textTransform:"uppercase", letterSpacing:"0.4px", marginBottom:2 }}>{label}</div>
    <div style={{ fontSize:16, fontWeight:700, color:w?SC[w]:C.tx, fontFamily:"'DM Mono',monospace" }}>{value}<span style={{ fontSize:10, color:C.txM, marginLeft:2 }}>{unit}</span></div>
  </div>
);

/* ═══════════════════════════════════════════════════════════════════
   PANTRY CARD
   ═══════════════════════════════════════════════════════════════════ */
function PantryCard({ id, latest, history, issues, maintSince, T, nicks, onNick, dq, diag }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [nameIn, setNameIn] = useState("");
  const status = getSev(issues);
  const label = nicks[id] || id;
  const totalW = [1,2,3,4].reduce((s,i) => s + (N(latest?.[`scale${i}`]) || 0), 0);

  const grouped = useMemo(() => {
    const g = {};
    for (const iss of issues) { const k = iss.g || "Other"; if (!g[k]) g[k] = []; g[k].push(iss); }
    return g;
  }, [issues]);

  const iaq = N(latest?.iaq);
  const eco2 = N(latest?.eco2);

  return (
    <div style={{ borderRadius:8, border:`1px solid ${SR[status]}`, backgroundColor:C.card, overflow:"hidden" }}>
      <div onClick={() => setOpen(!open)} style={{ padding:"12px 16px", cursor:"pointer", display:"flex", alignItems:"center", gap:10, background:`linear-gradient(90deg, ${SB[status]}, transparent 60%)` }}>
        <Dot s={status} />
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            <span style={{ fontSize:15, fontWeight:700, color:C.tx, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{label}</span>
            {label !== id && <span style={{ fontSize:11, color:C.txM }}>({id})</span>}
          </div>
          <div style={{ fontSize:11, color:C.txD }}>
            {latest?.timestamp ? fAge((Date.now()-new Date(latest.timestamp).getTime())/60000)+" ago" : "No data"}
            {history?.length > 1 && ` | ${history.length} readings | ${Math.round((new Date(history[0].timestamp)-new Date(history[history.length-1].timestamp))/3.6e6)}h span`}
          </div>
        </div>
        <div style={{ display:"flex", gap:5, flexWrap:"wrap", justifyContent:"flex-end" }}>
          <Tag s={status}>{status}</Tag>
          {issues.length > 0 && <Tag s={status === "ok" ? "info" : status}>{issues.length} checks</Tag>}
          {dq && <span style={{fontSize:10,fontWeight:700,color:dq.score>=70?C.ok:dq.score>=40?C.wr:C.cr,fontFamily:"'DM Mono',monospace",padding:"1px 6px",borderRadius:3,backgroundColor:dq.score>=70?C.okB:dq.score>=40?C.wrB:C.crB}}>Q{dq.score}</span>}
          {maintSince && <Tag s="critical">attn {fAge((Date.now()-new Date(maintSince).getTime())/60000)}</Tag>}
        </div>
        <span style={{ color:C.txM, fontSize:14, transition:"transform 0.2s", transform:open?"rotate(180deg)":"none", marginLeft:4 }}>&#9662;</span>
      </div>

      {open && latest && (
        <div style={{ padding:"14px 16px", borderTop:`1px solid ${C.border}` }}>
          {/* Rename */}
          <div style={{ marginBottom:12, display:"flex", gap:8, alignItems:"center" }}>
            {editing ? <>
              <input value={nameIn} onChange={e=>setNameIn(e.target.value)} placeholder="Display name" autoFocus onKeyDown={e=>{if(e.key==="Enter"){onNick(id,nameIn);setEditing(false);}}}
                style={{ padding:"4px 8px", borderRadius:4, border:`1px solid ${C.borderL}`, backgroundColor:C.bg, color:C.tx, fontSize:12, width:200 }}/>
              <button onClick={()=>{onNick(id,nameIn);setEditing(false);}} style={{ padding:"4px 10px", borderRadius:4, border:`1px solid ${C.acc}40`, backgroundColor:C.accD, color:C.acc, fontSize:11, cursor:"pointer" }}>Save</button>
              <button onClick={()=>setEditing(false)} style={{ padding:"4px 10px", borderRadius:4, border:`1px solid ${C.border}`, backgroundColor:"transparent", color:C.txM, fontSize:11, cursor:"pointer" }}>Cancel</button>
            </> :
              <button onClick={()=>{setNameIn(nicks[id]||"");setEditing(true);}} style={{ padding:"3px 8px", borderRadius:4, border:`1px solid ${C.border}`, backgroundColor:"transparent", color:C.txD, fontSize:11, cursor:"pointer" }}>Rename</button>
            }
          </div>

          {/* Metrics */}
          <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:12 }}>
            <Metric label="Weight" value={totalW.toFixed(1)} unit="lbs"/>
            <Metric label="Temp" value={N(latest.air_temp)?.toFixed(1)||"--"} unit="C" w={N(latest.air_temp)<T.tempMin||N(latest.air_temp)>T.tempMax?"warning":null}/>
            <Metric label="Humidity" value={N(latest.air_humid)?.toFixed(0)||"--"} unit="%" w={N(latest.air_humid)>T.humidityMax?"warning":null}/>
            <Metric label="Battery" value={latest.batt_percent??'--'} unit="%" w={N(latest.batt_percent)!==null&&N(latest.batt_percent)<=T.battCritical?"critical":N(latest.batt_percent)!==null&&N(latest.batt_percent)<=T.battLow?"warning":null}/>
            <Metric label="RSSI" value={latest.rssi} unit="dBm" w={N(latest.rssi)<T.rssiCrit?"critical":N(latest.rssi)<T.rssiWarn?"warning":null}/>
            {iaq > 0 && <Metric label="IAQ" value={iaq} unit="" w={iaq>=T.iaqCrit?"critical":iaq>=T.iaqWarn?"warning":null}/>}
            {eco2 > 0 && <Metric label="eCO2" value={eco2} unit="ppm" w={eco2>=T.eco2Crit?"critical":eco2>=T.eco2Warn?"warning":null}/>}
            <Metric label="Memory" value={Math.round(N(latest.memory_free||0)/1024)} unit="KB"/>
          </div>

          {/* Scales */}
          <div style={{ display:"flex", gap:6, marginBottom:12 }}>
            {[1,2,3,4].map(i => {
              const v = N(latest[`scale${i}`]) || 0;
              const disc = toBool(latest[`scale${i}_disconnect`]);
              const susp = toBool(latest[`scale${i}_suspect`]);
              const clr = disc?C.cr:susp?C.wr:v<0?C.wr:C.acc;
              return <div key={i} style={{ flex:1, padding:"5px 8px", borderRadius:4, textAlign:"center", border:`1px solid ${disc?C.crBr:susp?C.wrBr:C.border}`, backgroundColor:disc?C.crB:susp?C.wrB:C.bg }}>
                <div style={{ fontSize:10, color:C.txM }}>S{i}</div>
                <div style={{ fontSize:15, fontWeight:700, color:clr, fontFamily:"'DM Mono',monospace" }}>{v.toFixed(2)}</div>
                {disc && <div style={{ fontSize:9, color:C.cr, fontWeight:700 }}>DISC</div>}
                {susp && <div style={{ fontSize:9, color:C.wr, fontWeight:700 }}>SUSPECT</div>}
              </div>;
            })}
          </div>

          {/* Doors + meta */}
          <div style={{ display:"flex", gap:6, marginBottom:12, flexWrap:"wrap" }}>
            {[1,2].map(i => { const o = toBool(latest[`door${i}_open`]); return <span key={i} style={{ padding:"3px 10px", borderRadius:3, fontSize:11, border:`1px solid ${o?C.wrBr:C.okBr}`, color:o?C.wr:C.ok }}>Door {i}: {o?"OPEN":"Closed"}</span>; })}
            <span style={{ padding:"3px 10px", borderRadius:3, fontSize:11, color:C.txD, border:`1px solid ${C.border}` }}>BSEC acc: {latest.accuracy}</span>
            <span style={{ padding:"3px 10px", borderRadius:3, fontSize:11, color:C.txD, border:`1px solid ${C.border}` }}>{new Date(latest.timestamp).toLocaleString()}</span>
          </div>

          {/* Issues grouped */}
          {issues.length > 0 && (
            <div>
              {GROUPS.filter(g => grouped[g]).map(g => (
                <div key={g} style={{ marginBottom:8 }}>
                  <div style={{ fontSize:10, color:C.acc, textTransform:"uppercase", letterSpacing:"0.5px", marginBottom:4, fontWeight:700 }}>{GROUP_ICONS[g]||""} {g} ({grouped[g].length})</div>
                  {grouped[g].map((iss, idx) => <div key={idx} style={{ padding:"5px 10px", marginBottom:2, borderRadius:4, fontSize:12, borderLeft:`3px solid ${SC[iss.s]}`, color:SC[iss.s], backgroundColor:SB[iss.s] }}>
                    <span style={{ fontWeight:600, fontSize:10, textTransform:"uppercase", opacity:0.7, marginRight:6 }}>{iss.t.replace(/_/g," ")}</span>{iss.m}
                  </div>)}
                </div>
              ))}
            </div>
          )}

          {/* Root cause attribution */}
          {diag && issues.length > 0 && (
            <div style={{marginTop:8,padding:10,borderRadius:6,backgroundColor:C.bg,border:`1px solid ${C.border}`}}>
              <div style={{fontSize:10,fontWeight:700,color:C.acc,textTransform:"uppercase",letterSpacing:"0.5px",marginBottom:6}}>🔍 Root Cause</div>
              {diag.correlation && (
                <div style={{fontSize:12,color:C.tx,marginBottom:6,padding:"4px 8px",borderRadius:4,backgroundColor:`${CAT_META[diag.correlation.cat]?.color||C.acc}10`,borderLeft:`3px solid ${CAT_META[diag.correlation.cat]?.color||C.acc}`}}>
                  <div>{diag.correlation.msg}</div>
                  <div style={{fontSize:11,color:C.txD,marginTop:2}}>→ {diag.correlation.act}</div>
                </div>
              )}
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {Object.entries(diag.cats).map(([cat,iss])=>{
                  const m=CAT_META[cat]||{icon:"❓",label:cat,color:C.txD};
                  return <span key={cat} style={{fontSize:10,padding:"2px 8px",borderRadius:3,color:m.color,backgroundColor:`${m.color}15`,border:`1px solid ${m.color}30`}}>{m.icon} {m.label} ({iss.length})</span>;
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   THRESHOLD EDITOR
   ═══════════════════════════════════════════════════════════════════ */
function ThreshEditor({ T, onChange, onReset }) {
  const groups = {};
  for (const [k, m] of Object.entries(TMETA)) { if (!groups[m.g]) groups[m.g] = []; groups[m.g].push({ k, ...m }); }
  return <div>
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
      <div style={{ fontSize:13, fontWeight:700, color:C.tx }}>Threshold Settings ({Object.keys(TMETA).length})</div>
      <button onClick={onReset} style={{ padding:"3px 10px", borderRadius:4, border:`1px solid ${C.border}`, backgroundColor:"transparent", color:C.txD, fontSize:11, cursor:"pointer" }}>Reset defaults</button>
    </div>
    {Object.entries(groups).map(([g, items]) => <div key={g} style={{ marginBottom:12 }}>
      <div style={{ fontSize:10, color:C.acc, textTransform:"uppercase", letterSpacing:"0.6px", marginBottom:6, fontWeight:700 }}>{g}</div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(190px, 1fr))", gap:6 }}>
        {items.map(({ k, l, d }) => <div key={k} style={{ padding:"6px 10px", borderRadius:4, backgroundColor:C.bg, border:`1px solid ${C.border}` }}>
          <label style={{ fontSize:11, color:C.txD, display:"block", marginBottom:2 }}>{l}</label>
          <input type="number" step="any" value={T[k]} onChange={e=>onChange({...T,[k]:Number(e.target.value)})}
            style={{ width:"100%", padding:"4px 6px", borderRadius:3, border:`1px solid ${C.borderL}`, backgroundColor:C.card, color:C.tx, fontSize:13, fontFamily:"'DM Mono',monospace" }}/>
          <div style={{ fontSize:9, color:C.txM, marginTop:2 }}>{d}</div>
        </div>)}
      </div>
    </div>)}
  </div>;
}

/* ═══════════════════════════════════════════════════════════════════
   ANOMALY LOG
   ═══════════════════════════════════════════════════════════════════ */
function AnomalyLog({ log, nicks }) {
  const [filter, setFilter] = useState("all");
  const [gFilter, setGFilter] = useState("all");
  const filtered = log.filter(e => (filter === "all" || e.s === filter) && (gFilter === "all" || e.g === gFilter));
  const allGroups = [...new Set(log.map(e => e.g).filter(Boolean))];
  return <div>
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8, flexWrap:"wrap", gap:6 }}>
      <div style={{ fontSize:13, fontWeight:700, color:C.tx, textTransform:"uppercase", letterSpacing:"0.6px" }}>Anomaly Log ({filtered.length})</div>
      <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
        {["all","critical","warning","info"].map(f => <button key={f} onClick={()=>setFilter(f)} style={{ padding:"2px 8px", borderRadius:3, fontSize:10, cursor:"pointer", textTransform:"uppercase", border:`1px solid ${filter===f?C.acc:C.border}`, backgroundColor:filter===f?C.accD:"transparent", color:filter===f?C.acc:C.txM }}>{f}</button>)}
        <span style={{ color:C.txM, fontSize:11, padding:"2px 4px" }}>|</span>
        {["all",...allGroups].map(f => <button key={f} onClick={()=>setGFilter(f)} style={{ padding:"2px 8px", borderRadius:3, fontSize:10, cursor:"pointer", border:`1px solid ${gFilter===f?C.acc:C.border}`, backgroundColor:gFilter===f?C.accD:"transparent", color:gFilter===f?C.acc:C.txM }}>{f==="all"?"All Groups":f}</button>)}
      </div>
    </div>
    {filtered.length === 0 ? <div style={{ padding:30, textAlign:"center", color:C.txM }}>No matching entries.</div> :
    <div style={{ maxHeight:350, overflowY:"auto", borderRadius:6, border:`1px solid ${C.border}` }}>
      <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}>
        <thead><tr style={{ backgroundColor:C.card }}>
          {["Time","Pantry","Sev","Group","Type","Details"].map(h => <th key={h} style={{ padding:"6px 8px", textAlign:"left", color:C.txM, fontWeight:600, borderBottom:`1px solid ${C.border}`, position:"sticky", top:0, backgroundColor:C.card }}>{h}</th>)}
        </tr></thead>
        <tbody>
          {filtered.slice(0,300).map((e,i) => <tr key={i} style={{ borderBottom:`1px solid ${C.border}20` }}>
            <td style={{ padding:"5px 8px", color:C.txD, fontFamily:"'DM Mono',monospace", whiteSpace:"nowrap" }}>{new Date(e.at).toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}</td>
            <td style={{ padding:"5px 8px", color:C.tx }}>{nicks[e.dev]||e.dev}</td>
            <td style={{ padding:"5px 8px" }}><Tag s={e.s}>{e.s}</Tag></td>
            <td style={{ padding:"5px 8px", color:C.txD, fontSize:10 }}>{e.g}</td>
            <td style={{ padding:"5px 8px", color:C.txD }}>{e.t}</td>
            <td style={{ padding:"5px 8px", color:SC[e.s] }}>{e.m}</td>
          </tr>)}
        </tbody>
      </table>
    </div>}
  </div>;
}

/* ═══════════════════════════════════════════════════════════════════
   SVG CHART HELPERS
   ═══════════════════════════════════════════════════════════════════ */

// Build time axis label positions (midnight boundaries as %)
function timeAxisLabels(data) {
  if (!data || data.length < 2) return [];
  const t0 = new Date(data[0].timestamp).getTime();
  const t1 = new Date(data[data.length - 1].timestamp).getTime();
  const span = Math.max(t1 - t0, 1);
  const labels = [];
  const d = new Date(t0); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 1);
  while (d.getTime() <= t1) {
    const pct = ((d.getTime() - t0) / span) * 100;
    if (pct > 4 && pct < 96)
      labels.push({ pct, label: d.toLocaleDateString(undefined, { month:"short", day:"numeric" }) });
    d.setDate(d.getDate() + 1);
  }
  return labels;
}

// Wrapper: Y-axis labels left, SVG center, time axis below
function ChartFrame({ children, H, yLabels, timeData, note, legend }) {
  const tLabels = timeAxisLabels(timeData);
  const t0str = timeData?.[0]?.timestamp
    ? new Date(timeData[0].timestamp).toLocaleDateString(undefined, { month:"short", day:"numeric" }) : "";
  return (
    <div>
      {legend && <div style={{display:"flex",gap:12,marginBottom:6,fontSize:10,flexWrap:"wrap"}}>{legend}</div>}
      <div style={{display:"flex",gap:0}}>
        {/* Y-axis labels */}
        <div style={{width:30,flexShrink:0,display:"flex",flexDirection:"column",justifyContent:"space-between",paddingBottom:0,paddingTop:2}}>
          {yLabels.map((l,i) => <span key={i} style={{fontSize:8,color:C.txM,textAlign:"right",paddingRight:4,lineHeight:1}}>{l}</span>)}
        </div>
        <div style={{flex:1,minWidth:0}}>
          <svg viewBox={`0 0 500 ${H}`} style={{width:"100%",height:H,display:"block"}} preserveAspectRatio="none">
            {children}
          </svg>
          {/* Time axis */}
          <div style={{position:"relative",height:14,marginTop:1}}>
            <span style={{position:"absolute",left:0,fontSize:8,color:C.txM,transform:"translateX(-50%)"}}>{t0str}</span>
            {tLabels.map((l,i) => (
              <span key={i} style={{position:"absolute",left:`${l.pct}%`,transform:"translateX(-50%)",fontSize:8,color:C.txM,whiteSpace:"nowrap"}}>{l.label}</span>
            ))}
            <span style={{position:"absolute",right:0,fontSize:8,color:C.txM}}>now</span>
          </div>
          {note && <div style={{fontSize:9,color:C.txM,marginTop:2,textAlign:"right"}}>{note}</div>}
        </div>
      </div>
    </div>
  );
}

// Timestamp-based path builder
function tsPath(data, getVal, W, H, t0, t1, mn, mx) {
  const spanT = Math.max(t1 - t0, 1);
  const rangeV = mx - mn || 1;
  const toX = r => ((new Date(r.timestamp).getTime() - t0) / spanT) * W;
  const toY = v => (H - 2) - (H - 4) * ((v - mn) / rangeV);
  let d = "", gap = true;
  for (const r of data) {
    const v = getVal(r);
    if (v === null) { gap = true; continue; }
    d += `${gap ? "M" : "L"}${toX(r).toFixed(1)},${toY(v).toFixed(1)} `;
    gap = false;
  }
  return d.trim();
}

// Horizontal grid line
function GridLine({ y, W, H }) {
  return <line x1="0" y1={y} x2={W} y2={y} stroke={`${C.border}`} strokeWidth="0.5" opacity="0.7"/>;
}

// Threshold reference line with label
function RefLine({ y, color, W, label }) {
  return <>
    <line x1="0" y1={y} x2={W} y2={y} stroke={color} strokeWidth="0.5" strokeDasharray="3,2" opacity="0.7"/>
    {label && <text x={W - 2} y={y - 2} textAnchor="end" fontSize="7" fill={color} opacity="0.85" vectorEffect="non-scaling-stroke">{label}</text>}
  </>;
}

// Vertical day-boundary lines inside SVG
function DayLines({ data, W, H }) {
  if (!data || data.length < 2) return null;
  const t0 = new Date(data[0].timestamp).getTime();
  const t1 = new Date(data[data.length - 1].timestamp).getTime();
  const span = Math.max(t1 - t0, 1);
  const lines = [];
  const d = new Date(t0); d.setHours(0,0,0,0); d.setDate(d.getDate()+1);
  while (d.getTime() <= t1) {
    const x = ((d.getTime() - t0) / span) * W;
    lines.push(<line key={d.getTime()} x1={x} y1="0" x2={x} y2={H} stroke={C.border} strokeWidth="0.5" opacity="0.5"/>);
    d.setDate(d.getDate()+1);
  }
  return <>{lines}</>;
}

const SCALE_COLORS = [C.acc, C.ok, C.wr, "#a371f7"];

/* ── Scale Chart ── */
function ScaleChart({ history, T }) {
  const data = [...history].reverse();
  if (data.length < 2) return <div style={{color:C.txM,fontSize:11,padding:20,textAlign:"center"}}>Not enough data</div>;
  const allVals = data.flatMap(d => [1,2,3,4].map(i => N(d[`scale${i}`])).filter(v => v !== null));
  if (!allVals.length) return null;
  const mn = Math.min(0, Math.min(...allVals));
  const dataMax = Math.max(...allVals);
  // Auto-scale Y to data; only extend to scaleMax if data is already over half of it
  const mx = dataMax > T.scaleMax * 0.5
    ? Math.max(T.scaleMax * 1.1, dataMax * 1.05)
    : Math.max(dataMax * 1.3, 2);
  const totals = data.map(d => [1,2,3,4].reduce((s,i) => s + (N(d[`scale${i}`])||0), 0));
  const W = 500, H = 100;
  const t0 = new Date(data[0].timestamp).getTime();
  const t1 = new Date(data[data.length-1].timestamp).getTime();
  const toY = v => (H - 2) - (H - 4) * ((v - mn) / (mx - mn || 1));
  const mid = (mn + mx) / 2;
  return (
    <ChartFrame H={H} yLabels={[`${mx.toFixed(0)}`, `${mid.toFixed(0)}`, `${mn.toFixed(0)}`]} timeData={data}
      note={`${data.length} readings`}
      legend={<>
        {[1,2,3,4].map(i=><span key={i} style={{color:SCALE_COLORS[i-1]}}>● S{i}</span>)}
        <span style={{color:"#fff",fontWeight:700}}>● Total</span>
        <span style={{marginLeft:"auto",color:C.txM}}>lbs</span>
      </>}>
      <DayLines data={data} W={W} H={H}/>
      <GridLine y={toY(mid)} W={W} H={H}/>
      {T.scaleMax <= mx && <RefLine y={toY(T.scaleMax)} color={C.wr} W={W} label={`max ${T.scaleMax} lbs`}/>}
      {mn < 0 && <RefLine y={toY(0)} color={C.txM} W={W}/>}
      {/* Individual scales */}
      {[1,2,3,4].map(i => {
        const d = tsPath(data, r => N(r[`scale${i}`]), W, H, t0, t1, mn, mx);
        return d ? <path key={i} d={d} fill="none" stroke={SCALE_COLORS[i-1]} strokeWidth="1" vectorEffect="non-scaling-stroke" strokeLinejoin="round" opacity="0.75"/> : null;
      })}
      {/* Total weight — bold white */}
      {(() => {
        const d = tsPath(data, r => [1,2,3,4].reduce((s,i)=>s+(N(r[`scale${i}`])||0),0), W, H, t0, t1, mn, mx);
        return d ? <path d={d} fill="none" stroke="#ffffff" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" opacity="0.9"/> : null;
      })()}
      {/* Current value dot + label */}
      {(() => {
        const last = data[data.length-1];
        const tot = totals[totals.length-1];
        const x = W, y = toY(tot);
        return <circle cx={x} cy={y} r="3" fill="#fff" vectorEffect="non-scaling-stroke"/>;
      })()}
    </ChartFrame>
  );
}

/* ── Door Timeline ── */
function DoorTimeline({ history }) {
  const data = [...history].reverse();
  if (data.length < 2) return <div style={{color:C.txM,fontSize:11,padding:20,textAlign:"center"}}>Not enough data</div>;
  const W = 500, ROW = 22, GAP = 4, H = ROW * 2 + GAP;
  const t0 = new Date(data[0].timestamp).getTime();
  const t1 = new Date(data[data.length - 1].timestamp).getTime();
  const span = Math.max(t1 - t0, 1);
  const toX = ts => ((new Date(ts).getTime() - t0) / span) * W;

  // Build open-duration runs per door
  function getRuns(doorKey) {
    const runs = [];
    let start = null;
    for (const r of data) {
      if (toBool(r[doorKey])) {
        if (start === null) start = new Date(r.timestamp).getTime();
      } else {
        if (start !== null) { runs.push({ start, end: new Date(r.timestamp).getTime() }); start = null; }
      }
    }
    if (start !== null) runs.push({ start, end: t1 });
    return runs;
  }

  const runs1 = getRuns("door1_open"), runs2 = getRuns("door2_open");
  const count1 = data.filter(r => toBool(r.door1_open)).length;
  const count2 = data.filter(r => toBool(r.door2_open)).length;
  const y1 = 0, y2 = ROW + GAP;

  return (
    <ChartFrame H={H} yLabels={["D1","","D2"]} timeData={data}
      note={`Door 1: ${count1} opens · Door 2: ${count2} opens`}>
      <DayLines data={data} W={W} H={H}/>
      {/* Door row backgrounds */}
      <rect x="0" y={y1} width={W} height={ROW} fill={`${C.border}40`} rx="2"/>
      <rect x="0" y={y2} width={W} height={ROW} fill={`${C.border}40`} rx="2"/>
      {/* Door 1 runs */}
      {runs1.map((r, i) => {
        const x1 = toX(r.start), x2 = toX(r.end);
        const w = Math.max(x2 - x1, 1.5);
        return <rect key={i} x={x1.toFixed(1)} y={y1+2} width={w.toFixed(1)} height={ROW-4} fill={C.acc} rx="1" opacity="0.85" vectorEffect="non-scaling-stroke"/>;
      })}
      {/* Door 2 runs */}
      {runs2.map((r, i) => {
        const x1 = toX(r.start), x2 = toX(r.end);
        const w = Math.max(x2 - x1, 1.5);
        return <rect key={i} x={x1.toFixed(1)} y={y2+2} width={w.toFixed(1)} height={ROW-4} fill={C.ok} rx="1" opacity="0.85" vectorEffect="non-scaling-stroke"/>;
      })}
    </ChartFrame>
  );
}

/* ── Battery Chart ── */
function BatteryChart({ history, T }) {
  const data = [...history].reverse();
  if (data.length < 2) return <div style={{color:C.txM,fontSize:11,padding:20,textAlign:"center"}}>Not enough data</div>;
  const W = 500, H = 70;
  const mn = 0, mx = 100;
  const t0 = new Date(data[0].timestamp).getTime();
  const t1 = new Date(data[data.length - 1].timestamp).getTime();
  const toY = v => (H - 2) - (H - 4) * ((v - mn) / (mx - mn));
  const latestB = N(data[data.length-1]?.batt_percent);
  const lineColor = latestB !== null && latestB <= T.battCritical ? C.cr : latestB !== null && latestB <= T.battLow ? C.wr : C.ok;
  const pathD = tsPath(data, r => N(r.batt_percent), W, H, t0, t1, mn, mx);
  return (
    <ChartFrame H={H} yLabels={["100%","50%","0%"]} timeData={data}
      note={latestB !== null ? `Current: ${latestB}%` : ""}>
      <DayLines data={data} W={W} H={H}/>
      <GridLine y={toY(50)} W={W} H={H}/>
      <RefLine y={toY(T.battLow)} color={C.wr} W={W} label={`warn ${T.battLow}%`}/>
      <RefLine y={toY(T.battCritical)} color={C.cr} W={W} label={`crit ${T.battCritical}%`}/>
      {pathD && <path d={pathD} fill="none" stroke={lineColor} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round"/>}
      {/* Current value dot */}
      {latestB !== null && <circle cx={W} cy={toY(latestB)} r="3" fill={lineColor} vectorEffect="non-scaling-stroke"/>}
    </ChartFrame>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   DIAGNOSTICS TAB
   ═══════════════════════════════════════════════════════════════════ */
function DiagnosticsTab({ analysis, nicks, T }) {
  const devs = Object.keys(analysis);
  const firstWithData = devs.find(id => (analysis[id]?.history?.length ?? 0) > 1) || devs[0] || "";
  const [sel, setSel] = useState(firstWithData);
  useEffect(() => {
    if ((!sel || !analysis[sel]) && devs.length)
      setSel(devs.find(id => (analysis[id]?.history?.length ?? 0) > 1) || devs[0]);
  }, [devs, analysis, sel]);
  const dev = analysis[sel];
  const sdIssues = dev?.issues.filter(i => i.g === "Scales" || i.g === "Doors") || [];
  const otherIssues = dev?.issues.filter(i => i.g !== "Scales" && i.g !== "Doors") || [];
  const panel = (title, children) => (
    <div style={{padding:14,borderRadius:8,backgroundColor:C.card,border:`1px solid ${C.border}`}}>
      <div style={{fontSize:12,fontWeight:700,color:C.tx,marginBottom:12}}>{title}</div>
      {children}
    </div>
  );
  return (
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
        <select value={sel} onChange={e=>setSel(e.target.value)}
          style={{padding:"6px 10px",borderRadius:5,border:`1px solid ${C.border}`,backgroundColor:C.card,color:C.tx,fontSize:13,cursor:"pointer"}}>
          {devs.map(id=><option key={id} value={id}>{nicks[id]||id}</option>)}
        </select>
        {dev && <Tag s={dev.status}>{dev.status}</Tag>}
        {dev && <span style={{fontSize:11,color:C.txM}}>{dev.history.length} readings · {dev.issues.length} findings</span>}
      </div>
      {dev && <>
        {/* ── Device Diagnostics ── */}
        {panel("🔍 Device Diagnostics", <>
          {/* Data quality gauge */}
          <div style={{display:"flex",gap:10,marginBottom:14,flexWrap:"wrap"}}>
            {[
              {l:"Overall",   v:dev.dq.score,        clr:dev.dq.score>=70?C.ok:dev.dq.score>=40?C.wr:C.cr},
              {l:"Freshness", v:dev.dq.freshness,    clr:dev.dq.freshness>=70?C.ok:dev.dq.freshness>=40?C.wr:C.cr},
              {l:"Completeness",v:dev.dq.completeness,clr:dev.dq.completeness>=70?C.ok:dev.dq.completeness>=40?C.wr:C.cr},
              {l:"Consistency",v:dev.dq.consistency,  clr:dev.dq.consistency>=70?C.ok:dev.dq.consistency>=40?C.wr:C.cr},
            ].map(g=>(
              <div key={g.l} style={{flex:1,minWidth:80,padding:"8px 10px",borderRadius:6,backgroundColor:C.bg,border:`1px solid ${C.border}`,textAlign:"center"}}>
                <div style={{fontSize:10,color:C.txM,textTransform:"uppercase",marginBottom:3}}>{g.l}</div>
                <div style={{fontSize:20,fontWeight:700,color:g.clr,fontFamily:"'DM Mono',monospace"}}>{g.v}</div>
                <div style={{fontSize:9,color:C.txM}}>/ 100</div>
              </div>
            ))}
          </div>

          {/* Cross-sensor correlation */}
          {dev.diag.correlation && (
            <div style={{padding:10,borderRadius:6,marginBottom:12,backgroundColor:`${CAT_META[dev.diag.correlation.cat]?.color||C.acc}10`,border:`1px solid ${CAT_META[dev.diag.correlation.cat]?.color||C.acc}30`}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",color:CAT_META[dev.diag.correlation.cat]?.color||C.acc,marginBottom:4}}>
                ⚡ Cross-Sensor Correlation
              </div>
              <div style={{fontSize:12,color:C.tx,marginBottom:4}}>{dev.diag.correlation.msg}</div>
              <div style={{fontSize:11,color:C.txD}}>→ {dev.diag.correlation.act}</div>
            </div>
          )}

          {/* Root cause breakdown by category */}
          {Object.keys(dev.diag.cats).length > 0 ? (
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {Object.entries(dev.diag.cats).map(([cat, issues]) => {
                const meta = CAT_META[cat] || {icon:"❓",label:cat,color:C.txD};
                return (
                  <div key={cat}>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                      <span>{meta.icon}</span>
                      <span style={{fontSize:11,fontWeight:700,color:meta.color,textTransform:"uppercase",letterSpacing:"0.4px"}}>{meta.label}</span>
                      <span style={{fontSize:10,color:C.txM}}>({issues.length})</span>
                    </div>
                    {issues.map((iss,i) => (
                      <div key={i} style={{padding:"6px 10px",marginBottom:3,borderRadius:4,fontSize:12,backgroundColor:C.bg,border:`1px solid ${C.border}`,borderLeft:`3px solid ${meta.color}`}}>
                        <div style={{color:SC[iss.s],fontWeight:600,marginBottom:2}}>
                          <span style={{fontSize:10,textTransform:"uppercase",opacity:0.7,marginRight:6}}>{iss.s}</span>{iss.m}
                        </div>
                        <div style={{fontSize:11,color:C.txD}}>→ {iss.action}</div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{fontSize:12,color:C.ok,padding:10}}>No issues detected — all systems healthy ✓</div>
          )}
        </>)}

        {/* ── Charts ── */}
        {sdIssues.length > 0 && (
          <div style={{padding:10,borderRadius:8,backgroundColor:C.card,border:`1px solid ${C.crBr}`}}>
            <div style={{fontSize:10,color:C.cr,textTransform:"uppercase",letterSpacing:"0.5px",fontWeight:700,marginBottom:6}}>⚖ Scale & Door Findings</div>
            {sdIssues.map((iss,i) => <div key={i} style={{padding:"4px 10px",marginBottom:2,borderRadius:4,fontSize:12,borderLeft:`3px solid ${SC[iss.s]}`,color:SC[iss.s],backgroundColor:SB[iss.s]}}>
              <span style={{fontWeight:600,fontSize:10,textTransform:"uppercase",opacity:0.7,marginRight:6}}>{iss.t.replace(/_/g," ")}</span>{iss.m}
            </div>)}
          </div>
        )}
        {panel("⚖ Scale Readings (lbs)", <ScaleChart history={dev.history} T={T}/>)}
        {panel("🚪 Door Events", <DoorTimeline history={dev.history}/>)}
        {panel("🔋 Battery Trend", <BatteryChart history={dev.history} T={T}/>)}
        {otherIssues.length > 0 && panel("Other Findings", otherIssues.map((iss,i) => (
          <div key={i} style={{padding:"4px 10px",marginBottom:2,borderRadius:4,fontSize:12,borderLeft:`3px solid ${SC[iss.s]}`,color:SC[iss.s],backgroundColor:SB[iss.s]}}>
            <span style={{fontWeight:600,fontSize:10,textTransform:"uppercase",opacity:0.7,marginRight:6}}>{iss.g} · {iss.t.replace(/_/g," ")}</span>{iss.m}
          </div>
        )))}
      </>}
      {!dev && <div style={{padding:40,textAlign:"center",color:C.txM}}>No pantry selected</div>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   DATA EXPLORER TAB
   ═══════════════════════════════════════════════════════════════════ */
function DataExplorerTab({ analysis, nicks }) {
  const devs = Object.keys(analysis);
  const firstWithData = devs.find(id => (analysis[id]?.history?.length ?? 0) > 0) || devs[0] || "";
  const [sel, setSel] = useState(firstWithData);
  useEffect(() => {
    if ((!sel || !analysis[sel]) && devs.length)
      setSel(devs.find(id => (analysis[id]?.history?.length ?? 0) > 0) || devs[0]);
  }, [devs, analysis, sel]);
  const rows = analysis[sel]?.history || [];
  const TH = ({ children, right }) => (
    <th style={{padding:"6px 8px",textAlign:right?"right":"left",color:C.txM,fontWeight:600,borderBottom:`1px solid ${C.border}`,position:"sticky",top:0,backgroundColor:C.card,fontSize:10,whiteSpace:"nowrap"}}>{children}</th>
  );
  const TD = ({ children, mono, color, right, bg }) => (
    <td style={{padding:"5px 8px",color:color||C.tx,fontFamily:mono?"'DM Mono',monospace":"inherit",fontSize:11,textAlign:right?"right":"left",backgroundColor:bg,whiteSpace:"nowrap"}}>{children}</td>
  );
  const scaleCell = (row, i) => {
    const v = N(row[`scale${i}`]);
    const disc = toBool(row[`scale${i}_disconnect`]);
    const susp = toBool(row[`scale${i}_suspect`]);
    return <TD key={i} mono right color={disc?C.cr:susp?C.wr:C.tx} bg={disc?C.crB:susp?C.wrB:undefined}>
      {disc?"DISC":susp?`${v?.toFixed(2)||"--"}⚠`:v?.toFixed(2)??"--"}
    </TD>;
  };
  return (
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
        <select value={sel} onChange={e=>setSel(e.target.value)}
          style={{padding:"6px 10px",borderRadius:5,border:`1px solid ${C.border}`,backgroundColor:C.card,color:C.tx,fontSize:13,cursor:"pointer"}}>
          {devs.map(id=><option key={id} value={id}>{nicks[id]||id}</option>)}
        </select>
        {rows.length > 0 && <span style={{fontSize:11,color:C.txM}}>{rows.length} readings · newest first</span>}
      </div>
      {rows.length > 0 ? (
        <div style={{borderRadius:8,border:`1px solid ${C.border}`,overflow:"hidden"}}>
          <div style={{maxHeight:520,overflowY:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr>
                <TH>Time</TH>
                <TH right>S1</TH><TH right>S2</TH><TH right>S3</TH><TH right>S4</TH>
                <TH right>Total</TH>
                <TH right>D1</TH><TH right>D2</TH>
                <TH right>Temp°C</TH><TH right>Humid%</TH>
                <TH right>Batt%</TH><TH right>RSSI</TH>
              </tr></thead>
              <tbody>
                {rows.map((r, i) => {
                  const total = [1,2,3,4].reduce((s,j) => s+(N(r[`scale${j}`])||0), 0);
                  const d1=toBool(r.door1_open), d2=toBool(r.door2_open);
                  const b=N(r.batt_percent), rssi=N(r.rssi);
                  return <tr key={i} style={{borderBottom:`1px solid ${C.border}20`,backgroundColor:i%2===0?"transparent":`${C.card}40`}}>
                    <TD mono>{new Date(r.timestamp).toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}</TD>
                    {[1,2,3,4].map(j=>scaleCell(r,j))}
                    <TD mono right color={C.acc}>{total.toFixed(2)}</TD>
                    <TD right color={d1?C.wr:C.txM}>{d1?"OPEN":"–"}</TD>
                    <TD right color={d2?C.wr:C.txM}>{d2?"OPEN":"–"}</TD>
                    <TD mono right>{N(r.air_temp)?.toFixed(1)??"--"}</TD>
                    <TD mono right>{N(r.air_humid)?.toFixed(0)??"--"}</TD>
                    <TD mono right color={b!==null&&b<=10?C.cr:b!==null&&b<=20?C.wr:C.tx}>{b??"--"}</TD>
                    <TD mono right color={rssi<-90?C.cr:rssi<-85?C.wr:C.tx}>{rssi??"--"}</TD>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : <div style={{padding:40,textAlign:"center",color:C.txM}}>No data for this pantry</div>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   SIMPLE / OVERVIEW VIEW
   ═══════════════════════════════════════════════════════════════════ */
function friendlyInsight(iss) {
  const map = {
    offline:         "We haven't heard from this pantry in a while — worth a check-in!",
    stale:           "Taking a little longer to report than usual",
    no_data:         "No recent data — might be worth a quick look",
    battery:         "Battery is running low — a recharge would help!",
    batt_cal:        "Battery reading looks a touch off — normal sensor quirk",
    batt_drain:      "Battery draining a bit faster than usual",
    temp:            "Temperature is outside the typical range — interesting!",
    humidity:        "Humidity is a bit high today",
    iaq:             "Air quality sensor noticed something interesting",
    eco2:            "CO₂ levels are a little elevated — good ventilation tip!",
    rssi:            "Signal is a little weak — sensor is doing its best!",
    rssi_trend:      "Signal has been slowly fading — might move the sensor",
    scale_neg:       "One scale dipped below zero — might need a small recalibration",
    scale_high:      "A scale reading looks high — could be a big donation!",
    scale_disc:      "A scale sensor went quiet — worth investigating",
    scale_susp:      "One scale flagged itself — sensor being extra cautious",
    flatline:        "Scale readings have been super consistent lately",
    spike:           "Noticed a big weight change — possibly a fresh delivery!",
    all_zero:        "All sensors read zero — device might need a restart",
    door:            "A door is currently open",
    door_sustained:  "Door has been open for a while — maybe propped open?",
    door_busy:       "Lots of door activity — this pantry is popular today!",
    door_unused:     "One door hasn't been used recently",
    event_burst:     "A flurry of activity detected — busy pantry!",
    event_increase:  "Event activity has been picking up recently",
    event_silence:   "Event activity seems to have quieted down",
    interval_drift:  "Reporting timing has been a little irregular",
    temp_trend:      "Temperature has been gradually shifting",
    gas_drift:       "Air sensor is still warming up and calibrating",
    bsec:            "Air quality sensor is still calibrating",
    bsec_stuck:      "Air quality sensor has been calibrating for a while",
    mem_leak:        "Memory usage trending up — minor technical note",
    food_probe:      "Food temperature probe is disconnected",
  };
  return map[iss.t] || iss.m;
}

const SS = {
  ok:       { emoji:"🟢", label:"All good!",       bg:"#0d1f14", border:"#1e3d26", lc:"#3fb950" },
  info:     { emoji:"💙", label:"Interesting!",    bg:"#0d1825", border:"#1a3050", lc:"#58a6ff" },
  warning:  { emoji:"💛", label:"Worth a look",    bg:"#1a160a", border:"#352d12", lc:"#d29922" },
  critical: { emoji:"🔔", label:"Needs attention", bg:"#1a160a", border:"#352d12", lc:"#e3a008" },
};

function SimplePantryCard({ id, dev, nicks }) {
  const label = nicks[id] || id;
  const sc = SS[dev.status] || SS.ok;
  const latest = dev.latest;
  const totalW = latest ? [1,2,3,4].reduce((s,i)=>s+(N(latest[`scale${i}`])||0),0) : 0;
  const ageMin = latest ? (Date.now()-new Date(latest.timestamp).getTime())/60000 : null;
  const recentOpens = dev.history.slice(0,48).filter(r=>toBool(r.door1_open)||toBool(r.door2_open)).length;
  const insights = dev.issues.filter(i=>i.t!=="no_data").slice(0,2).map(friendlyInsight);
  return (
    <div style={{borderRadius:12,border:`1px solid ${sc.border}`,backgroundColor:sc.bg,padding:18,display:"flex",flexDirection:"column",gap:12}}>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between"}}>
        <div>
          <div style={{fontSize:17,fontWeight:700,color:C.tx}}>{label}</div>
          {label!==id && <div style={{fontSize:10,color:C.txM,marginTop:1}}>{id}</div>}
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:20}}>{sc.emoji}</div>
          <div style={{fontSize:10,fontWeight:700,color:sc.lc,marginTop:2}}>{sc.label}</div>
        </div>
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        <div style={{flex:1,minWidth:72,padding:"8px 10px",borderRadius:8,backgroundColor:`${C.card}90`,textAlign:"center"}}>
          <div style={{fontSize:22,fontWeight:700,color:C.tx,fontFamily:"'DM Mono',monospace"}}>{totalW.toFixed(1)}</div>
          <div style={{fontSize:10,color:C.txM,marginTop:1}}>lbs of food</div>
        </div>
        <div style={{flex:1,minWidth:72,padding:"8px 10px",borderRadius:8,backgroundColor:`${C.card}90`,textAlign:"center"}}>
          <div style={{fontSize:22,fontWeight:700,color:C.tx}}>{recentOpens||"—"}</div>
          <div style={{fontSize:10,color:C.txM,marginTop:1}}>recent opens</div>
        </div>
        <div style={{flex:1,minWidth:72,padding:"8px 10px",borderRadius:8,backgroundColor:`${C.card}90`,textAlign:"center"}}>
          <div style={{fontSize:15,fontWeight:700,color:ageMin===null?C.txM:C.tx}}>{ageMin!==null?fAge(ageMin):"—"}</div>
          <div style={{fontSize:10,color:C.txM,marginTop:1}}>last active</div>
        </div>
      </div>
      {insights.length>0 ? (
        <div style={{display:"flex",flexDirection:"column",gap:4}}>
          <div style={{fontSize:10,color:C.txM,textTransform:"uppercase",letterSpacing:"0.5px",fontWeight:600,marginBottom:2}}>✨ Insights</div>
          {insights.map((msg,i)=><div key={i} style={{fontSize:12,color:C.txD,padding:"5px 10px",borderRadius:6,backgroundColor:`${C.card}80`,borderLeft:`2px solid ${sc.border}`}}>{msg}</div>)}
        </div>
      ) : (
        <div style={{fontSize:12,color:C.ok,padding:"6px 10px",borderRadius:6,backgroundColor:C.okB}}>Everything looks great here! 🎉</div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   MAIN APP
   ═══════════════════════════════════════════════════════════════════ */
export default function PantryMonitor() {
  const [mode, setMode] = useState(sGet("pm-mode","live"));
  const [simpleView, setSimpleView] = useState(sGet("pm-sv",true));
  const [apiBase, setApiBase] = useState(sGet("pm-a","https://pantryapi-web-d8gzfkftgtb5cfhn.westus2-01.azurewebsites.net"));
  const [webhook, setWebhook] = useState("");
  const [T, setT] = useState(DEFS);
  const [nicks, setNicks] = useState({});
  const [pH, setPH] = useState({});
  const [log, setLog] = useState([]);
  const [lastR, setLastR] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState("dashboard");
  const maint = useRef({});
  const seen = useRef(new Set());

  useEffect(() => {
    const t=sGet("pm-t",null); if(t)setT(t);
    const n=sGet("pm-n",null); if(n)setNicks(n);
    const w=sGet("pm-w",null); if(w)setWebhook(w);
    const l=sGet("pm-l",null); if(l)setLog(l);
  }, []);
  useEffect(()=>{sSet("pm-mode",mode);},[mode]);
  useEffect(()=>{sSet("pm-sv",simpleView);},[simpleView]);
  useEffect(()=>{sSet("pm-t",T);},[T]);
  useEffect(()=>{sSet("pm-n",nicks);},[nicks]);
  useEffect(()=>{sSet("pm-a",apiBase);},[apiBase]);
  useEffect(()=>{sSet("pm-w",webhook);},[webhook]);
  useEffect(()=>{if(log.length>0)sSet("pm-l",log.slice(0,1000));},[log]);

  const onNick = useCallback((id,name)=>setNicks(p=>({...p,[id]:name||id})),[]);

  const fetchLive = useCallback(async()=>{
    if(!apiBase) return; setLoading(true); setErr(null);
    try {
      const r = await fetch(`${apiBase.replace(/\/$/,"")}/api/GetLatestPantry?pantryId=all&mode=monitor`, { cache: "no-store" });
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const mapped = {};
      for (const [k,v] of Object.entries(data)) {
        if(v.history) mapped[k] = v.history;
        else if(v.timestamp) mapped[k] = [v];
        else mapped[k] = []; // device in DB but no recent data — will show as offline
      }
      setPH(mapped); setLastR(new Date());
    } catch(e){ setErr(`Fetch failed: ${e.message}`); }
    setLoading(false);
  },[apiBase]);

  const loadDemo = useCallback(()=>{ setPH(genDemo()); setLastR(new Date()); },[]);
  useEffect(()=>{ if(mode==="demo") loadDemo(); },[mode,loadDemo]);
  useEffect(()=>{ if(mode==="live"&&apiBase){ fetchLive(); const iv=setInterval(fetchLive,5*60000); return ()=>clearInterval(iv); } },[mode,apiBase,fetchLive]);

  const analysis = useMemo(()=>{
    const res = {};
    for (const [dev,hist] of Object.entries(pH)) {
      const sorted = [...hist].sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp));
      const latest = sorted[0];
      const pt = latest ? pointChecks(latest, T, sorted) : [{s:"critical",t:"no_data",m:"No data",g:"Connectivity"}];
      const ts = timeSeriesChecks(hist, T);
      const all = [...pt,...ts];
      const diag = diagnose(all, sorted);
      const dq = dataQuality(sorted, T);
      res[dev] = { latest, history:sorted, issues:all, status:getSev(all), diag, dq };
    }
    return res;
  },[pH,T]);

  useEffect(()=>{
    const entries = [];
    for (const [dev,{issues,status}] of Object.entries(analysis)) {
      if(status==="critical"||status==="warning"){ if(!maint.current[dev]) maint.current[dev]=new Date().toISOString(); }
      else delete maint.current[dev];
      for (const iss of issues) {
        const k=`${dev}-${iss.t}-${iss.m.slice(0,40)}`;
        if(!seen.current.has(k)){ seen.current.add(k); entries.push({at:new Date().toISOString(),dev,...iss}); }
      }
    }
    if(entries.length>0){
      setLog(p=>[...entries,...p]);
      if(webhook) fetch(webhook,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({entries:entries.map(e=>({detectedAt:e.at,deviceId:e.dev,severity:e.s,type:e.t,msg:e.m,group:e.g}))}),mode:"no-cors"}).catch(()=>{});
    }
  },[analysis,webhook]);

  const sortedDevs = useMemo(()=>{
    const ord={critical:0,warning:1,info:2,ok:3};
    const sdScore = dev => {
      const iss = analysis[dev].issues;
      if (iss.some(i=>(i.g==="Scales"||i.g==="Doors")&&i.s==="critical")) return 0;
      if (iss.some(i=>(i.g==="Scales"||i.g==="Doors")&&i.s==="warning")) return 1;
      return 2;
    };
    return Object.keys(analysis).sort((a,b)=>{
      const d=(ord[analysis[a].status]??4)-(ord[analysis[b].status]??4);
      return d!==0?d:sdScore(a)-sdScore(b);
    });
  },[analysis]);

  const critN = Object.values(analysis).filter(r=>r.status==="critical").length;
  const warnN = Object.values(analysis).filter(r=>r.status==="warning").length;
  const totalChecks = Object.values(analysis).reduce((s,r)=>s+r.issues.length,0);

  return (
    <div style={{ minHeight:"100vh", backgroundColor:C.bg, color:C.tx, fontFamily:"'DM Sans','Helvetica Neue',sans-serif", padding:"16px 16px 40px" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&family=DM+Mono:wght@400;500&display=swap');
        @keyframes blink{0%,100%{opacity:1}50%{opacity:0.3}}
        *{box-sizing:border-box;margin:0}
        input:focus{outline:1px solid ${C.acc}60}
        ::-webkit-scrollbar{width:5px;height:5px}
        ::-webkit-scrollbar-track{background:${C.bg}}
        ::-webkit-scrollbar-thumb{background:${C.borderL};border-radius:3px}
      `}</style>

      {/* Header */}
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:16, flexWrap:"wrap", gap:10 }}>
        <div>
          <h1 style={{ fontSize:20, fontWeight:700, color:C.tx, letterSpacing:"-0.3px" }}>
            {simpleView ? "🥫 Pantry Overview" : "Pantry Monitor"}
          </h1>
          <div style={{ fontSize:11, color:C.txM, marginTop:2 }}>
            {simpleView
              ? `${sortedDevs.length} pantries online${lastR?` · updated ${fAge((Date.now()-lastR.getTime())/60000)} ago`:""}`
              : `${mode==="demo"?"Demo":"Live"} | ${Object.keys(analysis).length} pantries | ${totalChecks} active findings${lastR?` | refreshed ${fAge((Date.now()-lastR.getTime())/60000)} ago`:""}`
            }
          </div>
        </div>
        <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
          {simpleView ? (
            <>
              {critN>0&&<span style={{fontSize:12,color:"#e3a008"}}>🔔 {critN} need attention</span>}
              {critN===0&&warnN===0&&sortedDevs.length>0&&<span style={{fontSize:12,color:C.ok}}>🟢 All pantries happy</span>}
            </>
          ) : (
            <>
              {critN>0&&<Tag s="critical">{critN} critical</Tag>}
              {warnN>0&&<Tag s="warning">{warnN} warning</Tag>}
              {critN===0&&warnN===0&&sortedDevs.length>0&&<Tag s="ok">all clear</Tag>}
            </>
          )}
          <button onClick={()=>mode==="live"?fetchLive():loadDemo()} disabled={loading}
            style={{ padding:"5px 12px", borderRadius:5, border:`1px solid ${C.border}`, backgroundColor:C.card, color:C.txD, fontSize:11, cursor:"pointer", opacity:loading?0.5:1 }}>
            {loading?"...":"Refresh"}
          </button>
          {/* Subscribe to notifications */}
          <button onClick={()=>setSubscribed(true)} style={{ padding:"5px 12px", borderRadius:5, border:`1px solid ${C.border}`, backgroundColor:C.card, color:C.txD, fontSize:11, cursor:"pointer" }}>
            Subscribe
          </button>
          {/* View toggle */}
          <div style={{ display:"flex", borderRadius:20, border:`1px solid ${C.border}`, backgroundColor:C.card, overflow:"hidden" }}>
            <button onClick={()=>setSimpleView(true)} style={{ padding:"4px 12px", fontSize:11, cursor:"pointer", border:"none", backgroundColor:simpleView?C.accD:"transparent", color:simpleView?C.acc:C.txD, fontWeight:simpleView?700:400 }}>Overview</button>
            <button onClick={()=>setSimpleView(false)} style={{ padding:"4px 12px", fontSize:11, cursor:"pointer", border:"none", backgroundColor:!simpleView?C.accD:"transparent", color:!simpleView?C.acc:C.txD, fontWeight:!simpleView?700:400 }}>Technical</button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display:"flex", gap:2, marginBottom:14, borderBottom:`1px solid ${C.border}`, paddingBottom:1 }}>
        {[{id:"dashboard",l:"Dashboard"},{id:"charts",l:"Diagnostics"},{id:"explorer",l:"Data"},{id:"log",l:`Log (${log.length})`},{id:"settings",l:"Settings"}].map(t=>
          <button key={t.id} onClick={()=>setTab(t.id)} style={{ padding:"6px 14px", fontSize:12, fontWeight:tab===t.id?700:400, cursor:"pointer", border:"none", borderBottom:`2px solid ${tab===t.id?C.acc:"transparent"}`, backgroundColor:"transparent", color:tab===t.id?C.acc:C.txD }}>{t.l}</button>
        )}
      </div>

      {err && <div style={{ marginBottom:12, padding:10, borderRadius:6, backgroundColor:C.crB, border:`1px solid ${C.crBr}`, color:C.cr, fontSize:12 }}>{err}</div>}

      {/* Dashboard */}
      {tab==="dashboard" && <>
        {sortedDevs.length===0 && <div style={{ padding:40, textAlign:"center", color:C.txM }}>No pantries. {mode==="demo"?"Loading...":"Check API URL in Settings."}</div>}
        {simpleView ? (
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))", gap:12 }}>
            {sortedDevs.map(id => <SimplePantryCard key={id} id={id} dev={analysis[id]} nicks={nicks}/>)}
          </div>
        ) : (
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {sortedDevs.map(id => <PantryCard key={id} id={id} latest={analysis[id].latest} history={analysis[id].history} issues={analysis[id].issues} maintSince={maint.current[id]} T={T} nicks={nicks} onNick={onNick} dq={analysis[id].dq} diag={analysis[id].diag}/>)}
            <div style={{ marginTop:14, padding:14, borderRadius:8, backgroundColor:C.card, border:`1px solid ${C.border}` }}>
              <div style={{ fontSize:11, fontWeight:700, color:C.txD, textTransform:"uppercase", letterSpacing:"0.5px", marginBottom:8 }}>Check Coverage ({Object.keys(TMETA).length} thresholds across {GROUPS.length} domains)</div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(260px, 1fr))", gap:3, fontSize:11, color:C.txD }}>
                <div><span style={{color:C.acc}}>Staleness/Offline</span> -- no data beyond expected window</div>
                <div><span style={{color:C.acc}}>RSSI level + trend</span> -- weak signal, degradation over time</div>
                <div><span style={{color:C.acc}}>Interval drift</span> -- reporting gap vs median cadence</div>
                <div><span style={{color:C.acc}}>Battery level + drain</span> -- thresholds + projected days left</div>
                <div><span style={{color:C.acc}}>Temp/Humidity range</span> -- out-of-bounds environment</div>
                <div><span style={{color:C.acc}}>IAQ + eCO2</span> -- air quality index and estimated CO2</div>
                <div><span style={{color:C.acc}}>Gas resistance drift</span> -- sensor aging over the week</div>
                <div><span style={{color:C.acc}}>Temp trend</span> -- rising/falling over analysis window</div>
                <div><span style={{color:C.acc}}>Food probe status</span> -- -127 = disconnected</div>
                <div><span style={{color:C.acc}}>Scale bounds/disc/suspect</span> -- range, hardware, firmware flags</div>
                <div><span style={{color:C.acc}}>Flatline detection</span> -- identical readings across any sensor</div>
                <div><span style={{color:C.acc}}>Spike (z-score)</span> -- outliers on any numeric field</div>
                <div><span style={{color:C.acc}}>All-zero correlation</span> -- multi-sensor zero = device fault</div>
                <div><span style={{color:C.acc}}>Door open patterns</span> -- frequency, sustained open, unused doors</div>
                <div><span style={{color:C.acc}}>Event rate</span> -- bursts, silence, trend shifts</div>
                <div><span style={{color:C.acc}}>Memory trend</span> -- free memory drop (leak detection)</div>
                <div><span style={{color:C.acc}}>BSEC calibration</span> -- accuracy stuck at 0</div>
                <div><span style={{color:C.acc}}>Battery calibration</span> -- readings over 100%</div>
              </div>
            </div>
          </div>
        )}
      </>}

      {/* Diagnostics */}
      {tab==="charts" && <DiagnosticsTab analysis={analysis} nicks={nicks} T={T}/>}

      {/* Data Explorer */}
      {tab==="explorer" && <DataExplorerTab analysis={analysis} nicks={nicks}/>}

      {/* Log */}
      {tab==="log" && <div>
        <AnomalyLog log={log} nicks={nicks}/>
        {log.length>0 && <button onClick={()=>{setLog([]);seen.current.clear();}} style={{ marginTop:10, padding:"5px 12px", borderRadius:4, border:`1px solid ${C.border}`, backgroundColor:"transparent", color:C.txM, fontSize:11, cursor:"pointer" }}>Clear log</button>}
        {log.length===0 && <div style={{ padding:40, textAlign:"center", color:C.txM }}>No anomalies logged yet.</div>}
      </div>}

      {/* Settings */}
      {tab==="settings" && <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
        <div style={{ padding:14, borderRadius:8, backgroundColor:C.card, border:`1px solid ${C.border}` }}>
          <div style={{ fontSize:13, fontWeight:700, color:C.tx, marginBottom:10 }}>Connection</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:10, marginBottom:10 }}>
            <div style={{ flex:"1 1 280px" }}>
              <label style={{ fontSize:11, color:C.txM, display:"block", marginBottom:3 }}>Azure Function Base URL</label>
              <input value={apiBase} onChange={e=>setApiBase(e.target.value)} placeholder="https://pantryapi-web-d8gzfkftgtb5cfhn.westus2-01.azurewebsites.net"
                style={{ width:"100%", padding:"7px 10px", borderRadius:5, border:`1px solid ${C.borderL}`, backgroundColor:C.bg, color:C.tx, fontSize:12, fontFamily:"'DM Mono',monospace" }}/>
            </div>
            <div style={{ flex:"1 1 280px" }}>
              <label style={{ fontSize:11, color:C.txM, display:"block", marginBottom:3 }}>Google Sheets Webhook</label>
              <input value={webhook} onChange={e=>setWebhook(e.target.value)} placeholder="https://script.google.com/macros/s/.../exec"
                style={{ width:"100%", padding:"7px 10px", borderRadius:5, border:`1px solid ${C.borderL}`, backgroundColor:C.bg, color:C.tx, fontSize:12, fontFamily:"'DM Mono',monospace" }}/>
            </div>
          </div>
          <div style={{ display:"flex", gap:6 }}>
            <button onClick={()=>{setMode("live");setTab("dashboard");}} disabled={!apiBase}
              style={{ padding:"6px 14px", borderRadius:5, fontSize:12, cursor:apiBase?"pointer":"not-allowed", border:`1px solid ${mode==="live"?C.ok:C.border}`, backgroundColor:mode==="live"?C.okB:"transparent", color:mode==="live"?C.ok:C.txD, opacity:apiBase?1:0.4 }}>Go Live</button>
            <button onClick={()=>{setMode("demo");setTab("dashboard");}}
              style={{ padding:"6px 14px", borderRadius:5, fontSize:12, cursor:"pointer", border:`1px solid ${mode==="demo"?C.acc:C.border}`, backgroundColor:mode==="demo"?C.accD:"transparent", color:mode==="demo"?C.acc:C.txD }}>Demo Mode</button>
          </div>
        </div>
        <div style={{ padding:14, borderRadius:8, backgroundColor:C.card, border:`1px solid ${C.border}` }}>
          <ThreshEditor T={T} onChange={setT} onReset={()=>setT(DEFS)}/>
        </div>
        <div style={{ padding:14, borderRadius:8, backgroundColor:C.card, border:`1px solid ${C.border}` }}>
          <div style={{ fontSize:13, fontWeight:700, color:C.tx, marginBottom:8 }}>Pantry Nicknames</div>
          <div style={{ fontSize:11, color:C.txM, marginBottom:8 }}>Pantries auto-discovered from API. New devices appear on next refresh.</div>
          <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
            {Object.keys(pH).map(id=><div key={id} style={{display:"flex",gap:8,alignItems:"center"}}>
              <span style={{fontSize:12,color:C.txD,width:180,fontFamily:"'DM Mono',monospace"}}>{id}</span>
              <input value={nicks[id]||""} onChange={e=>onNick(id,e.target.value)} placeholder={id}
                style={{flex:1,padding:"4px 8px",borderRadius:4,border:`1px solid ${C.border}`,backgroundColor:C.bg,color:C.tx,fontSize:12}}/>
            </div>)}
          </div>
        </div>
        <div style={{ padding:14, borderRadius:8, backgroundColor:C.card, border:`1px solid ${C.border}` }}>
          <div style={{ fontSize:13, fontWeight:700, color:C.tx, marginBottom:8 }}>API Contract</div>
          <div style={{ fontSize:12, color:C.txD, lineHeight:1.6 }}>
            <p style={{marginBottom:6}}>Monitor mode: <code style={{color:C.acc,fontFamily:"'DM Mono',monospace",fontSize:11}}>GET /api/GetLatestPantry?pantryId=all&mode=monitor</code></p>
            <p style={{marginBottom:6}}>Returns 1 week of history per device. Existing callers without <code style={{color:C.acc,fontFamily:"'DM Mono',monospace",fontSize:11}}>mode=monitor</code> get the same response as before (single latest record).</p>
            <p>CORS: <code style={{color:C.acc,fontFamily:"'DM Mono',monospace",fontSize:11}}>Access-Control-Allow-Origin: *</code></p>
          </div>
        </div>
      </div>}

      <div style={{ marginTop:20, fontSize:10, color:C.txM, textAlign:"center" }}>
        Pantry Monitor v3 | 30-day analysis window | {Object.keys(TMETA).length} thresholds | 18 check types across {GROUPS.length} domains | auto-refresh 5min
      </div>
    </div>
  );
}
