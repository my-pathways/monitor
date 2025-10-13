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

function detectChanges(currentResults, previousState) {
  const changes = [];
  
  for (const result of currentResults) {
    const wasUp = previousState[result.url];
    const isUp = result.up;
    
    if (wasUp === undefined) {
      if (!isUp) {
        changes.push({ type: "initial_down", result });
      }
      continue;
    }
    
    if (wasUp !== isUp) {
      if (isUp) {
        changes.push({ type: "recovered", result });
      } else {
        changes.push({ type: "went_down", result });
      }
    }
  }
  
  return changes;
}

async function main() {
  const results = await Promise.all(TARGETS.map(checkWithRetries));
  const lines = results.map(fmt);
  console.log(new Date().toISOString(), "\n" + lines.join("\n"));

  const previousState = loadPreviousState();
  const changes = detectChanges(results, previousState);
  
  const currentState = {};
  results.forEach(r => currentState[r.url] = r.up);
  savePreviousState(currentState);

  const forceReport = process.env.FORCE_STATUS_REPORT === "true";
  
  if (changes.length > 0) {
    const messages = [];
    
    for (const change of changes) {
      switch (change.type) {
        case "initial_down":
          messages.push(`🚨 **INITIAL CHECK - SERVICE DOWN**\n${fmt(change.result)}`);
          break;
        case "went_down":
          messages.push(`🔴 **SERVICE WENT DOWN**\n${fmt(change.result)}`);
          break;
        case "recovered":
          messages.push(`🟢 **SERVICE RECOVERED**\n${fmt(change.result)}`);
          break;
      }
    }
    
    if (messages.length > 0) {
      await notify(messages.join("\n\n"));
    }
  } else if (forceReport) {
    // Send current status report when manually requested
    const statusMessage = [
      "📊 **CURRENT STATUS REPORT**",
      "",
      ...results.map(fmt)
    ].join("\n");
    
    await notify(statusMessage);
    console.log("Manual status report sent to Discord");
  } else {
    console.log("No status changes detected - no notifications sent");
  }
}

main().catch(async (e) => {
  console.error("Fatal:", e);
  await notify(`❌ Monitor failed: ${e.message || e}`);
  process.exit(1);
});
