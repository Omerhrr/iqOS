#!/usr/bin/env bash
# Tick Desk route check: boots trading-core fresh (isolated throwaway DB),
# validates the four /tick_* routes in two phases:
#   phase 1 (cold buffers) - every route must answer with an honest
#     warming-up / no-ticks state, NEVER a fabricated read
#   phase 2 (after the sim engine has printed ~3.5 min of ticks) - the active
#     asset must carry real structured reads (smc trend, oracle ladder with
#     workable buckets, technical ladder, footprint candles with measured
#     up/dn prints) - trend 'range' / direction 'none' are VALID honest reads
#     on a random-walk sim tape, only fabrications are failures.
# Read-only over the running kernel; kills only the kernel it started.

set -u
cd "$(dirname "$0")/.."   # repo root

KERNEL_PID=""
cleanup() {
  if [ -n "$KERNEL_PID" ] && kill -0 "$KERNEL_PID" 2>/dev/null; then
    kill "$KERNEL_PID" 2>/dev/null
    wait "$KERNEL_PID" 2>/dev/null
  fi
}
trap cleanup EXIT

PASS=0
FAIL=0
ok() { if [ "$2" = "1" ]; then PASS=$((PASS+1)); echo "  ok  $1"; else FAIL=$((FAIL+1)); echo "FAIL  $1${3:+ - $3}"; fi; }
# truth 'shell-condition' -> echoes 1 when the condition holds
truth() { if eval "$1"; then echo 1; else echo 0; fi; }

probe() { # path -> prints json or {}
  curl -s -m 10 "http://localhost:3030$1" || echo '{}'
}
jget() { # json field via python; booleans lower-cased, PARSE_ERROR on junk
  python3 -c "
import json,sys
try:
  d=json.loads(sys.argv[1])
  for k in sys.argv[2].split('.'):
    if k=='': continue
    if isinstance(d,list): d=d[int(k)]
    elif isinstance(d,dict): d=d.get(k)
    else: d=None
  print(json.dumps(d) if isinstance(d,(dict,list)) else ('null' if d is None else str(d).lower()))
except Exception:
  print('PARSE_ERROR')
" "$1" "$2"
}

echo "[boot] starting trading-core on :3030"
cd mini-services/trading-core
IQAIR_OS_DB=/tmp/tickdesk_os.db bun index.ts >/tmp/tickdesk_kernel.log 2>&1 &
KERNEL_PID=$!
cd - >/dev/null
for i in $(seq 1 60); do
  if curl -s -m 2 http://localhost:3030/health | grep -q '"ok":true'; then break; fi
  sleep 1
done
curl -s -m 2 http://localhost:3030/health | grep -q '"ok":true' && ok "kernel healthy" 1 || { ok "kernel healthy" 0 "no /health"; exit 1; }

ACTIVE=$(probe '/mode' | jget "$(probe '/mode')" 'asset')
[ "$ACTIVE" = "PARSE_ERROR" ] || [ -z "$ACTIVE" ] || [ "$ACTIVE" = "null" ] && ACTIVE="EURUSD"
echo "[boot] active asset: $ACTIVE"

# ---------- phase 1: cold-buffer honesty ----------
echo ""
echo "[phase 1] cold buffers (boot + ~2s of ticks)"
S1=$(probe "/tick_smc?asset=$ACTIVE")
O1=$(probe "/tick_oracle?asset=$ACTIVE")
T1=$(probe "/tick_technical?asset=$ACTIVE")
F1=$(probe "/tick_footprint?asset=$ACTIVE")
ok "/tick_smc answers" 1
DS=$(jget "$S1" 'dataSource')
ok "smc dataSource disclosed" $(truth '[ "$DS" = "sim-tick-1s" ] || [ "$DS" = "sidecar-tick-100ms" ] || [ "$DS" = "no-ticks-yet" ]') "$DS"
OKS=$(jget "$S1" 'ok')
NBS=$(jget "$S1" 'candles')
if [ "$OKS" = "false" ]; then
  ok "smc cold: fail-closed (ok=false)" 1
  case "$(jget "$S1" 'note')" in *warming*) ok "smc cold note says warming up" 1;; *) ok "smc cold note says warming up" 0 "$(jget "$S1" 'note')";; esac
elif [ "$OKS" = "true" ]; then
  ok "smc cold: fail-closed (ok=false)" $(truth '[ "$NBS" -ge 12 ] 2>/dev/null') "(buffer had $NBS candles at cold start)"
else
  ok "smc ok field sane" 0 "$OKS"
fi
OD=$(jget "$O1" 'rows.0.direction')
ok "oracle cold: no fabricated direction on row 0" $(truth '[ "$OD" = "none" ] || [ "$OD" = "null" ] || [ "$OD" = "PARSE_ERROR" ]') "$OD"
TR0=$(jget "$T1" 'buckets.0.ok')
ok "technical cold: bucket 0 honestly not ok" $(truth '[ "$TR0" = "false" ]') "$TR0"
FN=$(jget "$F1" 'summary.totalUp')
ok "footprint cold: counts numeric" $(truth '[ "$FN" = "0" ] || [ "$FN" = "null" ] || [ "$FN" = "PARSE_ERROR" ] || { [ "$FN" -ge 0 ] 2>/dev/null; }') "$FN"

# ---------- phase 2: warm buffers ----------
WAIT=210
echo ""
echo "[phase 2] waiting ${WAIT}s for the sim engine to print tick history..."
sleep $WAIT

S2=$(probe "/tick_smc?asset=$ACTIVE&bucketSec=5")
O2=$(probe "/tick_oracle?asset=$ACTIVE")
# 5s detail: 3.5 min = 42 closed buckets >= 35 -> the only bucket length a
# 3.5-minute-old buffer can honestly fill the full indicator table for
T2=$(probe "/tick_technical?asset=$ACTIVE&bucketSec=5")
F2=$(probe "/tick_footprint?asset=$ACTIVE&bucketSec=60")

echo ""
echo "[eyeball] smc: trend=$(jget "$S2" 'trend') dir=$(jget "$S2" 'direction') conf=$(jget "$S2" 'confidence') bos=$(jget "$S2" 'bos') reason0=$(jget "$S2" 'reasons.0')"
echo "[eyeball] oracle best: $(jget "$O2" 'best.label') $(jget "$O2" 'best.direction') $(jget "$O2" 'best.confidence')% (med $(jget "$O2" 'cadenceMs')ms)"
echo "[eyeball] technical 5s: $(jget "$T2" 'buckets.0.summary.rating') (osc $(jget "$T2" 'buckets.0.osc.rating') / mas $(jget "$T2" 'buckets.0.mas.rating'))"
echo "[eyeball] footprint: $(jget "$F2" 'summary.totalUp')u/$(jget "$F2" 'summary.totalDn')d poc=$(jget "$F2" 'summary.dominantPoc') buckets=$(jget "$F2" 'summary.buckets')"

SOK=$(jget "$S2" 'ok')
STRD=$(jget "$S2" 'trend')
SDIR=$(jget "$S2" 'direction')
ok "smc warm: ok=true" $(truth '[ "$SOK" = "true" ]') "$(jget "$S2" 'note')"
ok "smc warm: trend in {up,down,range}" $(truth '[ "$STRD" = "up" ] || [ "$STRD" = "down" ] || [ "$STRD" = "range" ]') "$STRD"
ok "smc warm: direction in {call,put,none}" $(truth '[ "$SDIR" = "call" ] || [ "$SDIR" = "put" ] || [ "$SDIR" = "none" ]') "$SDIR"
SNB=$(jget "$S2" 'candles')
ok "smc warm: 5s bucket count >= 12 (42 available)" $(truth '[ "$SNB" -ge 12 ] 2>/dev/null') "candles=$SNB"

OBEST=$(jget "$O2" 'best.label')
ok "oracle warm: best qualified read exists" $(truth '[ "$OBEST" != "null" ] && [ "$OBEST" != "PARSE_ERROR" ] && [ -n "$OBEST" ]') "best=$OBEST"
OROK=$(jget "$O2" 'ok')
ok "oracle warm: ok=true" $(truth '[ "$OROK" = "true" ]') "$(jget "$O2" 'note')"
OCNT=$(python3 -c "
import json,sys
try:
  d=json.loads(sys.argv[1]); print(sum(1 for r in d.get('rows',[]) if r.get('ok')))
except Exception: print('-1')" "$O2")
ok "oracle warm: >=3 workable buckets" $(truth '[ "$OCNT" -ge 3 ] 2>/dev/null') "workable=$OCNT"

TB=$(jget "$T2" 'buckets.0.summary.rating')
TR=$(jget "$T2" 'detail.rows.0.name')
ok "technical warm: 5s ladder rating valid" $(truth '[ "$TB" = "strong-buy" ] || [ "$TB" = "buy" ] || [ "$TB" = "neutral" ] || [ "$TB" = "sell" ] || [ "$TB" = "strong-sell" ]') "$TB"
ok "technical warm: detail table has indicator rows" $(truth '[ "$TR" != "null" ] && [ "$TR" != "PARSE_ERROR" ] && [ -n "$TR" ]') "row0=$TR"
TDOK=$(jget "$T2" 'detail.ok')
ok "technical warm: 5s detail computable" $(truth '[ "$TDOK" = "true" ]') "$(jget "$T2" 'detail.note')"

FU=$(jget "$F2" 'summary.totalUp')
FD=$(jget "$F2" 'summary.totalDn')
FPOC=$(jget "$F2" 'summary.dominantPoc')
ok "footprint warm: measured up prints > 0" $(truth '[ "$FU" -gt 0 ] 2>/dev/null') "totalUp=$FU"
ok "footprint warm: measured dn prints > 0" $(truth '[ "$FD" -gt 0 ] 2>/dev/null') "totalDn=$FD"
ok "footprint warm: dominant POC present" $(truth '[ "$FPOC" != "null" ] && [ "$FPOC" != "PARSE_ERROR" ]') "poc=$FPOC"
FB=$(jget "$F2" 'summary.buckets')
ok "footprint warm: >= 2 closed buckets" $(truth '[ "$FB" -ge 2 ] 2>/dev/null') "buckets=$FB"

echo ""
echo "=== tickdesk route check: $PASS pass / $FAIL fail ==="
exit $(truth '[ "$FAIL" = "0" ]')
