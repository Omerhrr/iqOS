#!/usr/bin/env bash
# IQAIR//OS - SENTINEL phase live fire tests
set -u
B=http://127.0.0.1:3030
J() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }

say() { echo; echo "=== $1 ==="; }

# --- setup: raise throttle for the test, tighten per-asset cap, arm tiny drawdown trap
say "SETUP: throttle 10/h, perAssetCap 1% (~\$100), drawdown halt 0.001%"
curl -s -X POST $B/sentinel_config -H 'content-type: application/json' \
  -d '{"maxTradesPerHour":10,"perAssetCapPct":1,"drawdownHaltPct":0.001}' | J "print(d['config'])"

say "TEST A: per-asset exposure cap (EURUSD has \$20 open, cap ~\$100 -> \$85 rejected)"
curl -s -X POST $B/trade -H 'content-type: application/json' \
  -d '{"asset":"EURUSD","kind":"binary","side":"call","amount":85,"mode":"paper"}' | J "print('ok:',d.get('ok'),'| err:',d.get('error','-'))"

say "TEST B: wait for the 2 open 1m binaries to settle; drawdown breaker must trip on any net loss"
for round in 1 2 3; do
  for i in $(seq 1 40); do
    OPEN=$(curl -s "$B/positions?status=open" | J "print(len(d['positions']))")
    [ "$OPEN" = "0" ] && break
    sleep 3
  done
  TRIP=$(curl -s $B/sentinel | J "print(d['breakers'][1]['tripped'])")
  echo "round $round: open=$OPEN drawdown_tripped=$TRIP"
  [ "$TRIP" = "True" ] && break
  # seed another round of trades if breaker not tripped yet (wins raised HWM)
  curl -s -X POST $B/trade -H 'content-type: application/json' -d '{"asset":"EURUSD","kind":"binary","side":"call","amount":10,"mode":"paper"}' >/dev/null
  sleep 2
  curl -s -X POST $B/trade -H 'content-type: application/json' -d '{"asset":"EURUSD","kind":"binary","side":"put","amount":10,"mode":"paper"}' >/dev/null
done

say "TEST B2: breaker state + side effects (kill switch auto-engaged, events logged)"
curl -s $B/sentinel | J "
b=[x for x in d['breakers'] if x['id']=='drawdown'][0]
print('tripped:',b['tripped'])
print('reason:',b['reason'])
print('killSwitch:',d['killSwitch'])
print('balance:',d['balance'],'hwm:',d['hwm'],'dd%:',d['drawdownPct'])
print('events:')
for e in d['events'][:5]: print('  -',e['kind'],'|',e['message'])
"

say "TEST C: blocked trade while breaker latched"
curl -s -X POST $B/trade -H 'content-type: application/json' \
  -d '{"asset":"BTCUSD","kind":"binary","side":"call","amount":5,"mode":"paper"}' | J "print('ok:',d.get('ok'),'| err:',d.get('error','-'))"

say "TEST D: ack resets breaker (re-release kill switch first, then ack drawdown)"
curl -s -X POST $B/kill_switch -H 'content-type: application/json' -d '{"on":false}' >/dev/null
curl -s -X POST $B/sentinel_ack -H 'content-type: application/json' -d '{"breaker":"drawdown"}' | J "print(d)"
curl -s $B/sentinel | J "print('drawdown tripped now:',[x['tripped'] for x in d['breakers'] if x['id']=='drawdown'][0],'| armed:',d['armed'])"

say "TEST E: PANIC - place 2 trades then flatten everything"
curl -s -X POST $B/trade -H 'content-type: application/json' -d '{"asset":"EURUSD","kind":"binary","side":"call","amount":10,"mode":"paper"}' >/dev/null
sleep 1
curl -s -X POST $B/trade -H 'content-type: application/json' -d '{"asset":"BTCUSD","kind":"binary","side":"put","amount":10,"mode":"paper"}' >/dev/null
sleep 1
echo "open before panic: $(curl -s "$B/positions?status=open" | J "print(len(d['positions']))")"
curl -s -X POST $B/panic -H 'content-type: application/json' -d '{"killSwitch":true}' | J "print('closed:',d['closed'],'| failed:',d['failed'],'| botsDisarmed:',d['botsDisarmed'],'| killSwitch:',d['killSwitch'])"
echo "open after panic: $(curl -s "$B/positions?status=open" | J "print(len(d['positions']))")"

say "TEST F: persistence - restart kernel, config + HWM must survive"
curl -s -X POST $B/sentinel_ack -H 'content-type: application/json' -d '{}' >/dev/null
curl -s -X POST $B/kill_switch -H 'content-type: application/json' -d '{"on":false}' >/dev/null
kill $(pgrep -f "bun.*index.ts" | head -1) 2>/dev/null
sleep 2
curl -s -m 40 http://127.0.0.1:3000/api/kernel | J "print('keeper:',d.get('kernel'))"
sleep 2
curl -s $B/sentinel | J "print('post-restart config:',d['config']); print('post-restart hwm:',d['hwm'],'balance:',d['balance'])"

say "RESTORE: sensible defaults + ack + kill off"
curl -s -X POST $B/sentinel_config -H 'content-type: application/json' \
  -d '{"maxTradesPerHour":30,"perAssetCapPct":12,"drawdownHaltPct":15}' >/dev/null
curl -s -X POST $B/sentinel_ack -H 'content-type: application/json' -d '{}' >/dev/null
curl -s -X POST $B/kill_switch -H 'content-type: application/json' -d '{"on":false}' >/dev/null
curl -s $B/sentinel | J "print('final: armed:',d['armed'],'| config:',d['config'])"
echo
echo "DONE"
