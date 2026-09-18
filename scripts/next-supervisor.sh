#!/bin/bash
# IQAIR//OS - self-healing supervisor for the Next.js dev server
cd /home/z/my-project
while true; do
  bun run dev >> /home/z/my-project/.zscripts/next-supervisor.log 2>&1
  echo "[$(date '+%H:%M:%S')] next dev exited ($?), respawning in 2s..." >> /home/z/my-project/.zscripts/next-supervisor.log
  sleep 2
done
