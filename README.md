# Web Services Monitor 🔍

Automated uptime monitoring system that runs on GitHub Actions and sends Discord notifications when services go down or recover.

## Features

- Monitors multiple environments (Production, Staging, Development) every 5 minutes
- Sends notifications when status changes (down ↔ up)
- Clear environment labeling in notifications

## How it notifies

- The monitor compares the current status of each endpoint with the previous run.
- It sends a Discord message only when there is a state change (UP → DOWN or DOWN → UP).
- If there is no previous state (e.g., first run in CI) and any service is DOWN, it sends a full status report so outages are not missed.

## Configuration

Environment variables (via local shell, `.env`, or GitHub Actions secrets): See `.env.example` for a template.

## License

Copyright (c) 2025 my-pathways. All rights reserved.

This software is proprietary and confidential. No license is granted for use, modification, or distribution.