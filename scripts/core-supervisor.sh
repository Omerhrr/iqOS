#!/bin/bash
# IQAIR//OS - self-healing supervisor for trading-core
cd /home/z/my-project/mini-services/trading-core
while true; do
  bun index.ts >> /home/z/my-project/.zscripts/trading-core.log 2>&1
  echo "[$(date '+%H:%M:%S')] trading-core exited ($?), respawning in 1s..." >> /home/z/my-project/.zscripts/trading-core.log
  sleep 1
done
