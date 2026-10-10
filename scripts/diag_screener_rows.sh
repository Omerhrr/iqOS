#!/usr/bin/env bash
# Diagnosis: what do screener rows actually carry at tf=1m on a fresh sim boot?
set -u
cd /home/z/my-project
for p in $(pgrep -f "bun index.ts"); do kill -9 "$p" 2>/dev/null; done
fuser -k 3030/tcp 2>/dev/null
sleep 2
mkdir -p mini-services/trading-core/data
cd mini-services/trading-core
nohup bun index.ts > /home/z/my-project/scripts/kernel-boot.log 2>&1 &
cd /home/z/my-project
for i in $(seq 1 30); do sleep 1; curl -s -m 2 http://localhost:3030/health | rg -q '"ok"' && break; done
echo "booted; warming 75s..."
sleep 75
python3 - <<'PY'
import json, urllib.request
def call(path):
    with urllib.request.urlopen("http://localhost:3030" + path, timeout=30) as r:
        return json.loads(r.read())

for tf in ("1m", "5m"):
    try:
        data = call(f"/screener?tf={tf}&limit=8")
        rows = data.get("rows") or []
        print(f"--- tf={tf}: {len(rows)} rows")
        for r in rows[:8]:
            print(f"  {r.get('asset'):<10} dir={r.get('direction'):<4} adx={r.get('adx')} rsi={r.get('rsi')} chg={r.get('changePct')} ouT={r.get('ouTStat')} regime={r.get('regime')}")
    except Exception as e:
        print(f"tf={tf} screener query failed: {e}")
PY
for p in $(pgrep -f "bun index.ts"); do kill -9 "$p" 2>/dev/null; done
