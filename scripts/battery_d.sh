#!/usr/bin/env bash
# Call D: fresh boot + standard battery for the why-edge diff.
# Mirrors the cf2983c battery: edge/enginesignal/signaloutcomes/nan_core units
# (bun, in-process = NEW code) + yesterday_e2e + classweek_smoke (node, HTTP).
set -u
cd /home/z/my-project

for p in $(pgrep -f "bun index.ts"); do kill -9 "$p" 2>/dev/null; done
fuser -k 3030/tcp 2>/dev/null
sleep 2
mkdir -p mini-services/trading-core/data

cd mini-services/trading-core
nohup bun index.ts > /home/z/my-project/scripts/kernel-boot.log 2>&1 &
cd /home/z/my-project
healthy=""
for i in $(seq 1 30); do
  sleep 1
  if curl -s -m 2 http://localhost:3030/health | rg -q '"ok"'; then healthy=yes; break; fi
done
[ -z "$healthy" ] && { echo "BOOT FAILED"; tail -20 scripts/kernel-boot.log; exit 1; }
echo "kernel healthy $(curl -s http://localhost:3030/health | rg -o '"uptime":[0-9.]+')"

rc=0
echo "--- edge_unit (bun, in-process)"
bun scripts/edge_unit.ts | tail -1 || rc=1
echo "--- enginesignal_unit (bun, in-process)"
bun scripts/enginesignal_unit.ts | tail -1 || rc=1
echo "--- signaloutcomes_unit (bun, in-process)"
bun scripts/signaloutcomes_unit.ts | tail -1 || rc=1
echo "--- memory_gate_selftest (bun, in-process)"
bun scripts/memory_gate_selftest.ts 2>&1 | tail -2 || rc=1
echo "--- nan_core_unit (bun, in-process)"
bun scripts/nan_core_unit.ts 2>&1 | tail -1 || rc=1
echo "--- yesterday_e2e (node, HTTP)"
node scripts/yesterday_e2e.mjs 2>&1 | tail -3 || rc=1
echo "--- classweek_smoke (node, HTTP)"
node scripts/classweek_smoke.mjs 2>&1 | tail -3 || rc=1

for p in $(pgrep -f "bun index.ts"); do kill -9 "$p" 2>/dev/null; done
echo "BATTERY DONE rc=$rc"
exit $rc
