#!/usr/bin/env bash
# IQAIR//OS - MODE phase verification (human <-> no-human-in-the-loop)
# 1. gate: armed bot on 5s candles is BLOCKED in human mode (mode-gate rejection)
# 2. auto: switching to NO-HUMAN mode lifts the gate -> the bot trades
# 3. auto-trader: with low thresholds the OS trades on its own screener signals
# 4. panic: PANIC drops the OS back to HUMAN mode
# Restores: test bot deleted, auto-trader config restored, mode left on human.
set -u
CORE="http://127.0.0.1:3030"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

alerts() { curl -s "$CORE/alerts" | python3 -c "import sys,json;[print(a['message']) for a in json.load(sys.stdin)['alerts'][:$1]]"; }
mode_is() { curl -s "$CORE/mode" | python3 -c "import sys,json;print(json.load(sys.stdin)['mode'])"; }

echo "== 0. baseline =="
MODE0=$(mode_is)
[ "$MODE0" = "human" ] && ok "default mode is human" || bad "expected human, got $MODE0"

echo "== 1. mode gate: armed bot blocked in HUMAN mode =="
curl -s -X POST "$CORE/bot_save" -H 'content-type: application/json' -d '{
  "id":"mode-verify-bot","name":"Mode Probe","enabled":true,"watchlist":["EURUSD"],
  "strategyId":"confluence-core","tf":"5s","kind":"binary","stake":10,"expiryBars":1,
  "minScore":0,"direction":"both","regime":"all","maxOpen":3,"cooldownSec":0 }' >/dev/null
echo "  (bot armed in human mode - waiting up to 40s for a mode-gate rejection)"
GATE=""
for i in $(seq 1 40); do
  GATE=$(alerts 12 | grep -m1 "mode-gate" || true)
  [ -n "$GATE" ] && break
  sleep 1
done
if [ -n "$GATE" ]; then ok "gate blocked bot order: $GATE"; else bad "no mode-gate rejection observed"; fi

echo "== 2. NO-HUMAN mode lifts the gate -> bot trades =="
curl -s -X POST "$CORE/mode_set" -H 'content-type: application/json' -d '{"mode":"auto","reason":"mode-verify"}' >/dev/null
[ "$(mode_is)" = "auto" ] && ok "mode switched to auto" || bad "mode_set auto failed"
TRADED=""
for i in $(seq 1 60); do
  OPEN=$(curl -s "$CORE/positions?status=open" | python3 -c "import sys,json;d=json.load(sys.stdin);print(sum(1 for p in d['positions'] if p.get('note','').startswith('bot:mode-verify-bot')))" 2>/dev/null || echo 0)
  [ "$OPEN" != "0" ] && TRADED="yes" && break
  sleep 2
done
[ -n "$TRADED" ] && ok "bot opened a trade autonomously in auto mode" || bad "bot did not trade in auto mode"

echo "== 3. auto-trader acts on screener signals =="
curl -s -X POST "$CORE/autotrader_config" -H 'content-type: application/json' \
  -d '{"enabled":true,"minScore":8,"minConfidence":0,"paceSec":5,"cooldownSec":5,"maxOpen":3}' >/dev/null
AT=""
for i in $(seq 1 45); do
  AT=$(curl -s "$CORE/mode" | python3 -c "import sys,json;d=json.load(sys.stdin)['autotrader'];print(d['trades'])")
  [ "$AT" != "0" ] && [ -n "$AT" ] && break
  sleep 2
done
if [ -n "$AT" ] && [ "$AT" != "0" ]; then
  DETAIL=$(curl -s "$CORE/mode" | python3 -c "import sys,json;d=json.load(sys.stdin)['autotrader'];print('trades',d['trades'],'open',d['openCount'],'lastAction',d.get('lastAction'))")
  ok "auto-trader executed on its own ($DETAIL)"
else
  bad "auto-trader did not trade within window"
fi

echo "== 4. PANIC returns the OS to HUMAN mode =="
curl -s -X POST "$CORE/panic" -H 'content-type: application/json' -d '{}' >/dev/null
sleep 1
[ "$(mode_is)" = "human" ] && ok "panic flipped mode back to human" || bad "panic did not restore human mode"

echo "== cleanup =="
curl -s -X POST "$CORE/bot_delete" -H 'content-type: application/json' -d '{"id":"mode-verify-bot"}' >/dev/null && ok "test bot deleted"
curl -s -X POST "$CORE/autotrader_config" -H 'content-type: application/json' \
  -d '{"minScore":60,"minConfidence":55,"paceSec":45,"cooldownSec":180,"maxOpen":3}' >/dev/null && ok "auto-trader thresholds restored"
curl -s -X POST "$CORE/mode_set" -H 'content-type: application/json' -d '{"mode":"human","reason":"verify cleanup"}' >/dev/null

echo
echo "RESULT: $PASS passed, $FAIL failed"
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
