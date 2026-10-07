#!/bin/bash
# IQAIR//OS - self-healing supervisor for trading-core
# Task 58: exponential backoff on crash loops (1s -> 2 -> 4 -> .. 60s cap)
# + 10MB log rotation.
cd /home/z/my-project/mini-services/trading-core
LOG=/home/z/my-project/.zscripts/trading-core.log
DELAY=1
while true; do
  # rotate: keep one .old copy when the log passes 10MB
  if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 10485760 ]; then
    mv "$LOG" "$LOG.old"
  fi
  bun index.ts >> "$LOG" 2>&1
  echo "[$(date '+%H:%M:%S')] trading-core exited ($?), respawning in ${DELAY}s..." >> "$LOG"
  sleep "$DELAY"
  DELAY=$(( DELAY * 2 ))
  [ "$DELAY" -gt 60 ] && DELAY=60
done
