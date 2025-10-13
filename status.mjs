#!/usr/bin/env node

// Status report script
process.env.FORCE_STATUS_REPORT = "true";

// Import and run the main monitor
import("./monitor.mjs")
  .then(() => {
    console.log("✅ Status report completed");
  })
  .catch((error) => {
    console.error("❌ Status report failed:", error);
    process.exit(1);
  });