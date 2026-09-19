#!/usr/bin/env bash
# IQAIR//OS - WATCHDOG phase live fire tests
# Escalation ladder: HEALTHY -> WATCH -> HOLD (gate blocks armed bot) ->
# AUTO-DISARM at hold expiry, then ack + restart persistence.
# Determinism trick: a same-candle CALL+PUT pair always produces exactly one
# loss, so with a 99% win-rate floor every settled pair degrades the probe.
set -u
B=http://127.0.0.1:3030
J() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }
say() { echo; echo "=== $1 ==="; }

probe() {
  curl -s $B/watchdog | J "b=[x for x in d['bots'] if x['botId']=='$1']; print('level:', b[0]['level'], b[0]['levelLabel'], '| reason:', (b[0]['reason'] or '-')[:70], '| acks:', b[0]['acks'], '| baseline:', b[0]['metrics']['baselinePct']) if b else print('probe missing')"
}

say "SETUP: hyper-sensitive thresholds (WR floor 99%, minTrades 2, grace 1, hold 1m, autoDisarm)"
curl -s -X POST $B/watchdog_config -H 'content-type: application/json' \
  -d '{"windowTrades":5,"minTrades":2,"winRateFloorPct":99,"winRateDriftPct":60,"profitFactorFloor":0,"maxConsecLosses":0,"graceTrades":1,"holdMinutes":1,"botDrawdownUsd":0,"autoDisarm":true}' >/dev/null

BOT=$(curl -s -X POST $B/bot_save -H 'content-type: application/json' \
  -d '{"name":"WD Probe","watchlist":["EURUSD"],"strategyId":"confluence-core","tf":"5s","minScore":0,"stake":2,"cooldownSec":0,"enabled":true}' \
  | J "print(d['bot']['id'])")
echo "armed probe: $BOT"

pair() {
  curl -s -X POST $B/trade -H 'content-type: application/json' \
    -d "{\"asset\":\"EURUSD\",\"tf\":\"5s\",\"kind\":\"binary\",\"side\":\"call\",\"amount\":2,\"mode\":\"paper\",\"note\":\"bot:$BOT\"}" >/dev/null
  curl -s -X POST $B/trade -H 'content-type: application/json' \
    -d "{\"asset\":\"EURUSD\",\"tf\":\"5s\",\"kind\":\"binary\",\"side\":\"put\",\"amount\":2,\"mode\":\"paper\",\"note\":\"bot:$BOT\"}" >/dev/null
  sleep 12
}

say "TEST A: pair #1 -> WATCH/HOLD escalation (bot itself may add settlements)"
pair
probe "$BOT"

say "TEST B: second settlement burst -> HEALTH HOLD, armed bot blocked"
pair
probe "$BOT"
curl -s "$B/bots" | J "b=[x for x in d['bots'] if x['bot']['id']=='$BOT'][0]; print('probe trades while held:', b['stats']['trades'], '(expect 0)')"
curl -s $B/alerts | J "m=[a['message'] for a in d['alerts'] if 'standing down: watchdog' in a['message']]; print('gate alert:', (m[0] if m else 'NONE')[:95])"

say "TEST C: hold expiry + bot attempt -> AUTO-DISARM"
sleep 70
probe "$BOT"
curl -s "$B/bots" | J "b=[x for x in d['bots'] if x['bot']['id']=='$BOT'][0]; print('bot enabled after disarm:', b['bot']['enabled'], '(expect False)')"
curl -s $B/watchdog | J "e=[x for x in d['events'] if x['kind']=='disarm']; print('disarm event:', (e[0]['message'][:90] if e else 'NONE'))"

say "TEST D: operator ack resets health + recalibrates window"
curl -s -X POST $B/watchdog_ack -H 'content-type: application/json' -d "{\"botId\":\"$BOT\"}" | J "print('ack:', d)"
probe "$BOT"

say "TEST E: baseline override + persistence across kernel restart"
curl -s -X POST $B/watchdog_baseline -H 'content-type: application/json' -d "{\"botId\":\"$BOT\",\"expectedWinRatePct\":75}" | J "print('baseline:', d)"
PID=$(ss -ltnp 2>/dev/null | grep ':3030' | grep -oP 'pid=\K[0-9]+' | head -1)
kill "$PID" 2>/dev/null; sleep 1
curl -s http://127.0.0.1:3000/api/kernel >/dev/null
for _ in $(seq 1 25); do curl -sf $B/health >/dev/null 2>&1 && break; sleep 1; done
echo "kernel back up"
curl -s $B/watchdog | J "print('config windowTrades after restart:', d['config']['windowTrades'])"
probe "$BOT"

say "CLEANUP: restore defaults, delete probe bot"
curl -s -X POST $B/watchdog_config -H 'content-type: application/json' \
  -d '{"windowTrades":30,"minTrades":10,"winRateFloorPct":38,"winRateDriftPct":12,"profitFactorFloor":0.7,"maxConsecLosses":6,"graceTrades":5,"holdMinutes":30,"botDrawdownUsd":0,"autoDisarm":true,"expectedWinRatePct":55}' >/dev/null
curl -s -X POST $B/bot_delete -H 'content-type: application/json' -d "{\"id\":\"$BOT\"}" | J "print('delete:', d)"
curl -s $B/watchdog | J "print('fleet summary:', d['summary'])"
echo; echo "WATCHDOG VERIFY DONE"
