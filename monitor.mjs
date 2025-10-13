import { setTimeout as wait } from "node:timers/promises";
import { readFileSync, writeFileSync } from "node:fs";

const TARGETS = [
  { 
    name: "Production",
    url: process.env.PROD_MONITOR_URL, 
    expectStatus: 200, 
    expectText: null, 
    timeoutMs: 8000 
  },
  { 
    name: "Staging",
    url: process.env.STAGING_MONITOR_URL, 
    expectStatus: 200, 
    expectText: null, 
    timeoutMs: 8000 
  },
  { 
    name: "Development",
    url: process.env.DEV_MONITOR_URL, 
    expectStatus: 200, 
    expectText: null, 
    timeoutMs: 6000 
  },
].filter(target => target.url);

const RETRIES = 2;
const COOLDOWN_MS = 1000;
const SLOW_THRESHOLD_MS = 2500;
const STATE_FILE = "/tmp/monitor-state.json";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

async function notify(message) {
  if (DISCORD_WEBHOOK_URL) {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: {"content-type":"application/json"},
      body: JSON.stringify({ content: message })
    }).catch(()=>{});
  }
}

async function checkOnce(target) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), target.timeoutMs);
  const started = performance.now();
  try {
    const res = await fetch(target.url, { signal: controller.signal, redirect: "follow" });
    const elapsed = Math.round(performance.now() - started);

    const okStatus = target.expectStatus ? res.status === target.expectStatus : res.ok;
    let okText = true;
    if (target.expectText) {
      const text = await res.text();
      okText = text.toLowerCase().includes(target.expectText.toLowerCase());
    }

    return { 
      name: target.name,
      url: target.url, 
      up: okStatus && okText, 
      status: res.status, 
      ms: elapsed, 
      slow: elapsed > SLOW_THRESHOLD_MS, 
      error: null 
    };
  } catch (err) {
    return { 
      name: target.name,
      url: target.url, 
      up: false, 
      status: 0, 
      ms: null, 
      slow: false, 
      error: err.message || String(err) 
    };
  } finally {
    clearTimeout(t);
  }
}

async function checkWithRetries(target) {
  let last;
  for (let i = 0; i <= RETRIES; i++) {
    last = await checkOnce(target);
    if (last.up) return last;
    if (i < RETRIES) await wait(COOLDOWN_MS);
  }
  return last;
}

function fmt(result) {
  const envName = result.name || "Service";
  if (!result.up) return `❌ DOWN: **${envName}** - ${result.url} (status=${result.status}, error=${result.error ?? "n/a"})`;
  return `✅ OK: **${envName}** - ${result.url} (${result.ms} ms, status=${result.status})`;
}

function formatStatusMessage(results, timestamp, executionTime) {
  const upServices = results.filter(r => r.up);
  const downServices = results.filter(r => !r.up);
  
  let message = "📊 **SERVICE STATUS UPDATES**\n\n";
  
  if (upServices.length > 0) {
    message += "🟢 **Services Up**\n";
    upServices.forEach(service => {
      message += `✅ **${service.name}** - ${service.url} (${service.ms} ms, status=${service.status})\n`;
    });
  }
  
  if (downServices.length > 0) {
    if (upServices.length > 0) message += "\n";
    message += "🔴 **Services Down**\n";
    downServices.forEach(service => {
      message += `❌ **${service.name}** - ${service.url} (status=${service.status}, error=${service.error ?? "n/a"})\n`;
    });
  }
  
  message += `\n⏰ **${timestamp} ART** | 🕐 Execution time: ${executionTime}ms`;
  
  return message;
}

function loadPreviousState() {
  try {
    const data = readFileSync(STATE_FILE, "utf8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function savePreviousState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn("Could not save state:", err.message);
  }
}

function hasChanges(currentResults, previousState) {
  // Only return true if there was a real state change
  for (const result of currentResults) {
    const wasUp = previousState[result.url];
    const isUp = result.up;
    
    // If it's the first time we see this service, consider it a change
    if (wasUp === undefined) {
      return true;
    }
    
    // If there was a state change (UP->DOWN or DOWN->UP)
    if (wasUp !== isUp) {
      return true;
    }
  }
  
  return false;
}

async function main() {
  const startTime = Date.now();
  const results = await Promise.all(TARGETS.map(checkWithRetries));
  const endTime = Date.now();
  const executionTime = endTime - startTime;
  
  const lines = results.map(fmt);
  console.log(new Date().toISOString(), "\n" + lines.join("\n"));

  const previousState = loadPreviousState();
  const shouldNotify = hasChanges(results, previousState);
  
  const currentState = {};
  results.forEach(r => currentState[r.url] = r.up);
  savePreviousState(currentState);

  const forceReport = process.env.FORCE_STATUS_REPORT === "true";
  
  // Create timestamp
  const timestamp = new Date().toLocaleString('en-US', { 
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit', 
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  if (shouldNotify || forceReport) {
    const statusMessage = formatStatusMessage(results, timestamp, executionTime);
    await notify(statusMessage);
    
    if (forceReport) {
      console.log("Manual status report sent to Discord");
    } else {
      console.log("Status notification sent to Discord");
    }
  } else {
    console.log("All services up and no changes detected - no notifications sent");
  }
}

main().catch(async (e) => {
  console.error("Fatal:", e);
  const timestamp = new Date().toLocaleString('en-US', { 
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit', 
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  await notify(`❌ **Monitor failed**: ${e.message || e}\n\n⏰ **${timestamp} ART**`);
  process.exit(1);
});
