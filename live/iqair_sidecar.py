#!/usr/bin/env python3
"""
IQAIR//OS - Live sidecar
Bridges the Trading OS (TypeScript kernel) to your iqair library:
  https://github.com/Omerhrr/iqair

Run it on the machine that talks to IQ Option:

    pip install -e /path/to/iqair          # your library
    pip install requests                   # already needed by iqair
    python iqair_sidecar.py                # listens on 127.0.0.1:8788

Then in the Trading OS: Settings -> LIVE mode -> URL http://127.0.0.1:8788
and your IQ Option credentials. Everything the OS needs (candles, prices,
balances, turbo/binary/forex/crypto/CFD trades, positions, history) flows
through THIS process using iqair directly.

PRACTICE balance is the default and strongly recommended. The OS never
switches to REAL unless you ask the sidecar to.
"""

import contextlib
import json
import os
import threading
import time

# Self-heal the iqair dependency: sandbox snapshot resets can revert the venv
# to a state without this package. Install on demand (PyPI: omerhrr/iqair) so
# a freshly spawned sidecar is always able to serve /connect.
try:
    import iqair  # noqa: F401
except ModuleNotFoundError:
    import subprocess
    import sys

    try:
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--quiet", "iqair"],
            check=True,
            timeout=180,
        )
        print("[sidecar] iqair was missing - installed from PyPI")
    except Exception as _exc:  # noqa: BLE001
        print(f"[sidecar] WARNING: auto-install of iqair failed: {_exc}")

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Static symbol map (symbol -> numeric active id) used to validate assets and
# to translate the kernel's symbol strings into ids the broker API expects.
try:
    import iqair.constants as OP_code
except Exception:  # noqa: BLE001
    OP_code = None

HOST = "127.0.0.1"
PORT = 8788

_lock = threading.Lock()
_client = None  # iqair IQOptionClient, set by /connect
_assets_cache = None  # (rows, ts) - the ~90s instrument table, 30 min TTL
_assets_fetching = False  # dedupe concurrent metadata crunches (they run unlocked)
_asset_ids = {}  # ticker -> numeric active_id, from the account's own metadata
_digital_ids = {}  # ticker -> numeric active_id, digital-option group only
_prices_cache = {}  # ticker -> (price, ts) for the /prices batch, 30s TTL

# ---- websocket stream price engine ----
# get_financial_information / get_candles are UNBOUNDED busy-wait round-trips
# on the shared iqair websocket ('while ...: pass' with no timeout); every
# /price tick used to ride them under the global lock, so one slow IQ
# response froze every price in the OS ("the price is not moving at all").
# Instead: subscribe IQ's candle stream per watched asset and read the
# in-memory candle table (client.get_realtime_candles) - a pure RAM read,
# no lock, no round-trip, never blocks.
_STREAM_SIZE = 5      # 5s candles = freshest streamed close per asset
_STREAM_MAXDICT = 2   # keep only the newest 2 candles per asset in RAM
_streamed = set()     # tickers with a LIVE stream subscription
_seeding = set()      # ticker whose seed thread is in flight (ONE at a time)
_watch = {}           # ticker -> last-touched ts (reaper expires stale subs)
_seed_lock = threading.Lock()
WATCH_TTL = 300.0     # stop streams untouched for 5 min
WATCH_CAP = 48        # max concurrent subscriptions
PRICE_WAIT = 2.0      # max lock wait for PRICE paths - polls must never block

# The iqair lib has UNBOUNDED busy-wait loops (get_candles et al spin forever
# on a half-open websocket - client.py 'while ...: pass' with no timeout).
# A lib call that never returns while holding the global lock froze the whole
# bus once (489 request threads piled up behind it). Two defenses:
#   1. lock_guard(): WAITERS get a fast 503 after LOCK_WAIT_TIMEOUT instead of
#      queueing forever, so one slow call degrades instead of deadlocking.
#   2. _lock_watchdog(): a holder running longer than LOCK_STUCK_EXIT_SECS is
#      by definition a hung lib call (legit calls cap at ~40s worst case) -
#      exit hard and let the keeper respawn a fresh sidecar.
LOCK_WAIT_TIMEOUT = 15.0
LOCK_STUCK_EXIT_SECS = 60.0
_held_since = None  # ts when the current holder acquired _lock


class SidecarBusy(Exception):
    """Raised when the global iqair lock cannot be acquired in time."""


@contextlib.contextmanager
def lock_guard(timeout=None):
    global _held_since
    if not _lock.acquire(timeout=LOCK_WAIT_TIMEOUT if timeout is None else timeout):
        raise SidecarBusy("iqair bus busy - another call is holding the lock")
    _held_since = time.time()
    try:
        yield
    finally:
        _held_since = None
        _lock.release()


def _lock_watchdog():
    while True:
        time.sleep(5)
        if _lock.locked() and _held_since is not None:
            held = time.time() - _held_since
            if held > LOCK_STUCK_EXIT_SECS:
                print(f"[sidecar] WATCHDOG: iqair call held the bus for {held:.0f}s "
                      f"(hung lib call, dead websocket) - restarting process")
                os._exit(1)


threading.Thread(target=_lock_watchdog, daemon=True).start()


# ---------------- stream price engine ----------------

def _stream_price(ticker):
    """Freshest streamed candle close for ticker, straight from RAM.
    Returns None when no stream data exists (asset not seeded yet)."""
    if _client is None:
        return None
    try:
        table = _client.get_realtime_candles(ticker, _STREAM_SIZE)
        if isinstance(table, dict) and table:
            c = table[max(table.keys())]
            for k in ("close", "ask", "price"):
                v = c.get(k)
                if v is not None:
                    f = float(v)
                    if f > 0:
                        return f
    except Exception:  # noqa: BLE001
        pass
    return None


def _seed_stream(ticker):
    """Subscribe the websocket candle stream for one asset. The seed does a
    single get_candles round-trip (history fill) under the lock, so seeds are
    STRICTLY serialized (one at a time) - a batch of new watch tickers must
    never monopolize the bus and stall /price //prices again. Tickers whose
    seed was deferred are retried on the next /price touch poll."""
    with _seed_lock:
        if _seeding:  # another seed in flight -> defer, next touch retries
            return
        _seeding.add(ticker)

    def _run():
        try:
            if _client is None:
                return
            with lock_guard():
                if _client is None:
                    return
                _client.start_candles_stream(ticker, _STREAM_SIZE, _STREAM_MAXDICT)
            _streamed.add(ticker)
            print(f"[sidecar] stream live: {ticker} (size={_STREAM_SIZE}s)")
        except SidecarBusy:
            pass  # bus busy - the next /price touch retries
        except Exception as exc:  # noqa: BLE001
            print(f"[sidecar] stream seed failed for {ticker}: {exc}")
            _streamed.discard(ticker)
        finally:
            with _seed_lock:
                _seeding.discard(ticker)

    threading.Thread(target=_run, daemon=True).start()


def _touch_watch(ticker):
    """Mark a ticker as wanted and (re)arm its stream when needed.
    Called on every /price and /prices touch - cheap by design."""
    _watch[ticker] = time.time()
    if ticker not in _streamed and ticker not in _seeding:
        _seed_stream(ticker)


def _watch_reaper():
    """Stop streams the OS stopped asking about (asset switch, closed watch
    rows) so websocket subscriptions stay bounded."""
    while True:
        time.sleep(60)
        if _client is None or not _watch:
            continue
        now = time.time()
        stale = [t for t, ts in _watch.items() if now - ts > WATCH_TTL]
        over = len(_watch) - WATCH_CAP
        if over > 0:
            oldest = sorted(_watch.items(), key=lambda kv: kv[1])[:over]
            stale += [t for t, _ in oldest if t not in stale]
        for t in stale:
            _watch.pop(t, None)
            was_live = t in _streamed
            _streamed.discard(t)
            if not was_live:
                continue
            try:
                with lock_guard():
                    if _client is not None:
                        _client.stop_candles_stream(t, _STREAM_SIZE)
                print(f"[sidecar] stream stopped: {t}")
            except Exception:  # noqa: BLE001
                pass


threading.Thread(target=_watch_reaper, daemon=True).start()

# ---------------- session resume ----------------
# The iqair lib keeps the authenticated session in a module global
# (global_value.SSID) and its connect() takes a FAST ssid path when that slot
# is pre-filled - no password round-trip. Persisting the ssid lets keeper
# respawns / watchdog restarts resume transparently instead of demanding a
# manual re-login. File lives next to the sidecar, chmod 600, never committed.
SESSION_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".iq_session")

try:
    import iqair.global_value as _gv
except Exception:  # noqa: BLE001
    _gv = None


def _save_session(email):
    if _gv is None or not getattr(_gv, "SSID", None):
        return
    try:
        with open(SESSION_FILE, "w") as f:
            json.dump({"email": email, "ssid": _gv.SSID}, f)
        os.chmod(SESSION_FILE, 0o600)
        print("[sidecar] session token saved - future respawns will auto-resume")
    except Exception as exc:  # noqa: BLE001
        print(f"[sidecar] session save failed: {exc}")


def _try_resume_session():
    """Boot-time auto-resume: inject the saved ssid into the lib's global slot
    BEFORE client.connect() so api.connect() sends the ssid over a fresh
    websocket (fast path, no credentials). Always lands on PRACTICE."""
    global _client
    try:
        with open(SESSION_FILE) as f:
            saved = json.load(f)
        ssid = str(saved.get("ssid") or "")
        if not ssid or _gv is None:
            return False
        from iqair.client import IQOptionClient

        _gv.SSID = ssid
        client = IQOptionClient(str(saved.get("email") or ""), "")
        check, reason = client.connect()
        if not check:
            print(f"[sidecar] session resume failed ({reason}) - manual login required")
            return False
        client.change_balance("PRACTICE")
        _client = client
        _save_session(str(saved.get("email") or ""))
        threading.Thread(target=_seed_ids_from_init, daemon=True).start()
        print("[sidecar] session RESUMED from saved token (no re-login needed)")
        return True
    except FileNotFoundError:
        return False
    except Exception as exc:  # noqa: BLE001
        print(f"[sidecar] session resume error: {exc}")
        return False


def _ws_health_monitor():
    """On a dead websocket every lib call silently pays a FULL re-login
    inside the lock (20-55s each - that is what made /price time out while
    /health stayed green). Detect a dead socket proactively and exit hard:
    the keeper respawns in ~5s and the saved ssid auto-resumes."""
    dead = 0
    time.sleep(45)  # let boot resume / first login settle
    while True:
        time.sleep(10)
        if _client is None:
            dead = 0
            continue
        try:
            alive = bool(_client.check_connect())
        except Exception:  # noqa: BLE001
            alive = False
        dead = dead + 1 if not alive else 0
        if dead >= 3:
            print("[sidecar] WATCHDOG: websocket dead ~30s - restarting for auto-resume")
            os._exit(1)


threading.Thread(target=_ws_health_monitor, daemon=True).start()


def _seed_ids_from_init():
    """Best-effort build of the ticker -> active_id map from the turbo/binary
    init table right after connect, so the first trade already resolves fast.
    Also seeds the library's stale 2018 static ACTIVES table with real ids."""
    try:
        data = _client.get_all_init_v2()
        for option in ("turbo", "binary"):
            actives = (data or {}).get(option, {}).get("actives", {})
            for aid, active in actives.items():
                t = active.get("ticker") or str(active.get("name", "")).split(".")[-1]
                try:
                    _asset_ids[t] = int(aid)
                except (TypeError, ValueError):
                    pass
        if OP_code is not None:
            for t, aid in _asset_ids.items():
                if t not in OP_code.ACTIVES:
                    OP_code.ACTIVES[t] = aid
        print(f"[sidecar] active_id map ready: {len(_asset_ids)} tickers")
    except Exception as exc:  # noqa: BLE001
        print(f"[sidecar] active_id map deferred (will build lazily): {exc}")
    # digital underlyings in the same background sweep: one fast round trip,
    # and it is the ONLY group the metadata-based scan below may miss when
    # the account has instruments exclusively as digital options
    try:
        dig = _client.get_digital_underlying_list_data()
        for item in (dig or {}).get("underlying", []):
            t = item.get("underlying")
            aid = item.get("active_id")
            if t and aid is not None:
                try:
                    _digital_ids[t] = int(aid)
                except (TypeError, ValueError):
                    pass
        print(f"[sidecar] digital id map ready: {len(_digital_ids)} tickers")
    except Exception as exc:  # noqa: BLE001
        print(f"[sidecar] digital id map deferred: {exc}")


def _resolve_active_id(ticker):
    """ticker -> IQ numeric active_id. Cached map first, one-shot live scan of
    the turbo/binary init table on miss, seeded static table last. Returns
    None only when the account truly has no such instrument - NEVER sends a
    null active_id to the broker."""
    # right after /connect the seed thread may still be in flight - give it
    # a moment instead of failing the first trade with "not an instrument"
    deadline = time.time() + 8
    while not _asset_ids and _client is not None and time.time() < deadline:
        time.sleep(0.2)
    if ticker in _asset_ids:
        return _asset_ids[ticker]
    if _client is None:
        return None
    try:
        data = _client.get_all_init_v2()
        for option in ("turbo", "binary"):
            actives = (data or {}).get(option, {}).get("actives", {})
            for aid, active in actives.items():
                t = active.get("ticker") or str(active.get("name", "")).split(".")[-1]
                try:
                    _asset_ids[t] = int(aid)
                except (TypeError, ValueError):
                    pass
    except Exception:  # noqa: BLE001
        pass
    if ticker in _asset_ids:
        return _asset_ids[ticker]
    if OP_code is not None:
        v = OP_code.ACTIVES.get(ticker)
        if isinstance(v, int):
            _asset_ids[ticker] = v
            return v
    return None


def _resolve_digital_id(ticker):
    """ticker -> active_id for the DIGITAL option group. Cached map first,
    then one fast live scan of the digital underlying list."""
    if ticker in _digital_ids:
        return _digital_ids[ticker]
    if _client is None:
        return None
    try:
        dig = _client.get_digital_underlying_list_data()
        for item in (dig or {}).get("underlying", []):
            t = item.get("underlying")
            aid = item.get("active_id")
            if t and aid is not None:
                try:
                    _digital_ids[t] = int(aid)
                except (TypeError, ValueError):
                    pass
    except Exception:  # noqa: BLE001
        pass
    return _digital_ids.get(ticker)


def _buy_digital_spot(amount, ticker, direction, expiry_minutes):
    """Digital-option spot (ATM) buy through iqair's buy_digital_spot, which
    resolves a REAL tradable instrument id server-side. iqair's low-level
    buy_digital() takes a pre-built instrument id + index - calling it with a
    ticker/direction crashed with int('put') - so it is never used here.
    Returns (True, order_id) or (False, reason)."""
    if direction not in ("call", "put"):
        return False, "direction must be call or put"
    fn = getattr(_client, "buy_digital_spot", None)
    if not callable(fn):
        return False, "iqair client has no buy_digital_spot"
    try:
        res = fn(ticker, float(amount), direction, int(max(1, expiry_minutes)), max_wait_sec=25)
    except Exception as exc:  # noqa: BLE001
        print(f"[sidecar] digital buy error: {ticker}: {exc}")
        return False, f"digital buy failed: {exc}"
    if res == -1:
        return False, "invalid direction"
    if isinstance(res, tuple) and len(res) == 2:
        ok, data = bool(res[0]), res[1]
        if ok:
            print(f"[sidecar] digital buy ok: {ticker} x {amount} {direction} {expiry_minutes}m -> order {data}")
        else:
            print(f"[sidecar] digital buy rejected: {ticker}: {data}")
        return ok, data
    return False, str(res)


def _buy_fast(amount, active_id, direction, expiry_minutes):
    """Direct buyv3 order with a pre-resolved active_id: ONE websocket round
    trip, no per-order init re-scan. Mirrors iqair's _buy_once response wait.
    Returns (True, order_id) or (False, reason)."""
    req_id = f"iqos-{int(time.time() * 1000)}"
    _client.api.buy_multi_option = {}
    _client.api.buy_successful = None
    _client.api.buyv3(amount, active_id, direction, expiry_minutes, req_id)
    deadline = time.time() + 10
    resp = None
    while time.time() < deadline:
        resp = (_client.api.buy_multi_option or {}).get(req_id)
        if isinstance(resp, dict) and (resp.get("id") is not None or resp.get("message")):
            break
        time.sleep(0.15)
    if not isinstance(resp, dict):
        print(f"[sidecar] buy timeout: {active_id} x {amount} ({expiry_minutes}m)")
        return False, "broker did not answer the order in time"
    if resp.get("id") is None:
        msg = resp.get("message") or "rejected"
        print(f"[sidecar] buy rejected: {active_id} x {amount}: {msg}")
        return False, str(msg)
    print(f"[sidecar] buy ok: active_id {active_id} x {amount} {direction} {expiry_minutes}m -> order {resp['id']}")
    return True, resp["id"]


def _ok(data=None):
    body = {"ok": True}
    if data:
        body.update(data)
    return body


def _err(msg):
    return {"ok": False, "error": str(msg)}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quiet
        pass

    def _assets_payload(self):
        """GET /assets body - built OUTSIDE the global lock. Serves the cached
        instrument table instantly; on miss fetches the account metadata
        (up to ~95s) while /trade, /candles and /balance stay responsive.
        Rows: {ticker, category, is_open, payout}; the fetch also fills the
        ticker -> active_id map used by the fast trade path."""
        global _assets_cache, _assets_fetching
        now = time.time()
        if _assets_cache and now - _assets_cache[1] < 1800:
            return _ok({"assets": _assets_cache[0], "live": True, "cached": True})
        if not _assets_fetching:
            _assets_fetching = True
            try:
                # NOTE: must use OUR client - iqair.agent.tools.get_client()
                # is a different, unconnected instance.
                meta = _client.get_asset_metadata()
                rows = []
                for cat, entries in (meta or {}).items():
                    if not isinstance(entries, dict):
                        continue
                    for ticker, info in entries.items():
                        is_open = bool((info or {}).get("is_open", False)) if isinstance(info, dict) else False
                        pay = None
                        if isinstance(info, dict) and info.get("payout") is not None:
                            try:
                                pay = float(info["payout"])
                            except (TypeError, ValueError):
                                pay = None
                        if isinstance(info, dict) and info.get("id") is not None:
                            try:
                                _asset_ids[ticker] = int(info["id"])
                                if cat == "digital":
                                    _digital_ids[ticker] = int(info["id"])
                            except (TypeError, ValueError):
                                pass
                        rows.append({"ticker": ticker, "category": cat, "is_open": is_open, "payout": pay})
                if rows:
                    # seed the library's stale 2018 static table with real ids:
                    # fixes /candles + /price validation for OTC/new tickers too
                    if OP_code is not None:
                        for t, aid in _asset_ids.items():
                            if t not in OP_code.ACTIVES:
                                OP_code.ACTIVES[t] = aid
                    # non-fatal cache write: if the bus is stuck we still
                    # return the freshly fetched rows, just uncached
                    if _lock.acquire(timeout=LOCK_WAIT_TIMEOUT):
                        try:
                            _assets_cache = (rows, now)
                        finally:
                            _lock.release()
                    print(f"[sidecar] asset table cached: {len(rows)} rows, {len(_asset_ids)} active_ids")
            except Exception as exc:  # noqa: BLE001
                print(f"[sidecar] asset metadata fetch failed: {exc}")
            finally:
                _assets_fetching = False
        if _assets_cache:
            return _ok({"assets": _assets_cache[0], "live": True, "cached": True})
        if OP_code is not None:
            # static universe from the library's symbol table (no payout info)
            return _ok({"assets": [{"ticker": k, "category": None, "is_open": None, "payout": None} for k in OP_code.ACTIVES.keys()], "live": False})
        return _ok({"assets": [], "live": False})

    def _send(self, obj, code=200):
        raw = json.dumps(obj, default=str).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.send_header("access-control-allow-origin", "*")
        self.end_headers()
        self.wfile.write(raw)

    def _body(self):
        length = int(self.headers.get("content-length") or 0)
        if length <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return {}

    # ---------------- GET ----------------

    def do_GET(self):
        global _client
        path, _, query = self.path.partition("?")
        params = dict(p.split("=", 1) for p in query.split("&") if "=" in p)

        if path == "/health":
            connected = _client is not None
            return self._send(_ok({"connected": connected, "assets_mapped": len(_asset_ids)}))

        if _client is None:
            return self._send(_err("not connected - POST /connect first"), 400)

        if path == "/assets":
            # served OUTSIDE the global lock on purpose: the metadata
            # round-trip can take IQ ~95s and must never block /trade,
            # /candles or /balance (lock queuing made orders feel dead)
            return self._send(self._assets_payload())

        if path == "/price":
            # STREAM FIRST: the freshest price straight from the websocket
            # candle table in RAM - no lock, no round-trip, never blocks and
            # keeps flowing even while /candles or /trade hold the bus. The
            # locked round-trip fallback below only runs before the stream
            # has seeded (first ~2s after connect / asset switch).
            asset = params.get("asset", "EURUSD")
            if OP_code is not None and asset not in OP_code.ACTIVES:
                return self._send(_err(f"unknown asset {asset}"), 400)
            _touch_watch(asset)
            sp = _stream_price(asset)
            if sp is not None:
                return self._send(_ok({"asset": asset, "price": sp, "src": "stream"}))
            # fallback: get_financial_information round-trip (busy-waits in
            # the lib). SHORT lock wait - a price poll must never queue
            # behind a 240-bar candle pull; the kernel retries in 4s.
            try:
                with lock_guard(PRICE_WAIT):
                    active_id = OP_code.ACTIVES.get(asset, asset) if OP_code is not None else asset
                    # iqair 1.0.0: returns the payload directly (no ok-wrapper)
                    data = _client.get_financial_information(active_id)
                    if isinstance(data, list) and data:
                        data = data[0]
                    price = None
                    try:
                        price = float(data["ask"]["price"])  # mid-ish quote
                    except Exception:  # noqa: BLE001
                        try:
                            price = float(data.get("price"))
                        except Exception:  # noqa: BLE001
                            pass
                    if price is None:
                        return self._send(_err("no price in response"), 502)
                    return self._send(_ok({"asset": asset, "price": price, "src": "roundtrip"}))
            except SidecarBusy:
                return self._send(_err("iqair bus busy - retry shortly"), 503)
            except Exception as exc:  # noqa: BLE001
                return self._send(_err(exc), 500)

        if path == "/balance":
            # short lock wait: balance is polled on a 15s cadence, missing
            # one poll is harmless - blocking the bus for it is not
            try:
                with lock_guard(PRICE_WAIT):
                    bal = _client.get_balance()
                    try:
                        mode = _client.get_balance_mode()
                    except Exception:  # noqa: BLE001
                        mode = None
                    return self._send(_ok({"amount": bal, "mode": mode}))
            except SidecarBusy:
                return self._send(_err("iqair bus busy - retry shortly"), 503)
            except Exception as exc:  # noqa: BLE001
                return self._send(_err(exc), 500)

        try:
            with lock_guard():
                if path == "/candles":
                    asset = params.get("asset", "EURUSD")
                    size = int(params.get("size", 300))
                    tf = int(params.get("tf", 60))
                    if OP_code is not None and asset not in OP_code.ACTIVES:
                        return self._send(_err(f"unknown asset {asset}"), 400)
                    # iqair 1.0.0: get_candles(ACTIVES, interval, count, endtime)
                    # returns the candle list directly (no ok-wrapper).
                    data = _client.get_candles(asset, tf, size, int(time.time()))
                    candles = [
                        {
                            "time": int(c.get("from", 0)),
                            "open": float(c.get("open", 0)),
                            "high": float(c.get("max", c.get("high", 0))),
                            "low": float(c.get("min", c.get("low", 0))),
                            "close": float(c.get("close", 0)),
                            "volume": float(c.get("volume", 0)),
                        }
                        for c in data
                        if isinstance(c, dict) and c.get("open") is not None
                    ]
                    candles.sort(key=lambda k: k["time"])
                    return self._send(_ok({"candles": candles}))

            return self._send(_err(f"no GET route {path}"), 404)
        except SidecarBusy:
            return self._send(_err("iqair bus busy - retry shortly"), 503)
        except Exception as exc:  # noqa: BLE001
            return self._send(_err(exc), 500)

    # ---------------- POST ----------------

    def do_POST(self):
        global _client
        path = self.path.split("?")[0]
        body = self._body()

        if path == "/connect":
            try:
                from iqair.client import IQOptionClient

                email = body.get("email") or ""
                password = body.get("password") or ""
                if not email or not password:
                    return self._send(_err("email and password required"), 400)
                client = IQOptionClient(email, password)
                check, reason = client.connect()
                if not check:
                    return self._send(_err(f"connect failed: {reason}"), 401)
                mode = (body.get("balance_mode") or "PRACTICE").upper()
                if mode == "REAL":
                    print("[sidecar] WARNING: connecting with REAL balance at user request")
                client.change_balance(mode)
                _client = client
                # persist the ssid: every future keeper respawn / watchdog
                # restart resumes from it instead of asking for credentials
                _save_session(email)
                # build the ticker -> active_id map in the background so the
                # FIRST trade already takes the fast path (connect replies now)
                threading.Thread(target=_seed_ids_from_init, daemon=True).start()
                return self._send(_ok({"connected": True, "balance_mode": mode}))
            except Exception as exc:  # noqa: BLE001
                return self._send(_err(exc), 500)

        if _client is None:
            return self._send(_err("not connected - POST /connect first"), 400)

        if path == "/balance_mode":
            # switch the SAME authenticated session between PRACTICE / REAL
            mode = str(body.get("mode") or "").upper()
            if mode not in ("PRACTICE", "REAL"):
                return self._send(_err("mode must be PRACTICE or REAL"), 400)
            print(f"[sidecar] balance_mode switch requested: -> {mode}")
            try:
                with lock_guard():
                    # fast path: already in the requested mode? get_balance_mode()
                    # is a cheap read, while change_balance() is a slow websocket
                    # round-trip (tens of seconds) - skip it when it is a no-op
                    # so paper -> IQ PRACTICE switches feel instant.
                    try:
                        current = _client.get_balance_mode()
                    except Exception:  # noqa: BLE001
                        current = None
                    amount = None
                    if str(current or "").upper() != mode:
                        _client.change_balance(mode)
                    try:
                        amount = _client.get_balance()
                    except Exception:  # noqa: BLE001
                        amount = None
                if mode == "REAL":
                    print("[sidecar] WARNING: session switched to REAL balance")
                else:
                    print(f"[sidecar] balance mode = {mode} (was {current or 'unknown'})")
                return self._send(_ok({"balance_mode": mode, "amount": amount}))
            except Exception as exc:  # noqa: BLE001
                # silent failures here made practice<->real switches look
                # broken (the UI just saw a timeout) - log them loudly
                print(f"[sidecar] balance_mode switch to {mode} FAILED: {exc}")
                return self._send(_err(exc), 500)

        if path == "/prices":
            # batch watch-list prices - served OUTSIDE the global lock:
            # stream-first RAM reads + a short-wait round-trip scan only for
            # tickers whose stream has not seeded yet. A price poll must
            # never queue behind /candles or /trade (that froze the UI).
            raw = body.get("tickers")
            want = [t for t in (raw if isinstance(raw, list) else []) if isinstance(t, str) and t][:40]
            if not want:
                return self._send(_ok({"prices": {}}))
            now = time.time()
            prices = {}
            missing = []
            for t in want:
                # stream first: RAM read, no lock (also auto-subscribes the
                # ticker so FUTURE polls are pure memory reads)
                if OP_code is not None and t in OP_code.ACTIVES:
                    _touch_watch(t)
                    sp = _stream_price(t)
                    if sp is not None:
                        prices[t] = sp
                        _prices_cache[t] = (sp, now)
                        continue
                hit = _prices_cache.get(t)
                if hit and now - hit[1] < 30:
                    prices[t] = hit[0]
                else:
                    missing.append(t)
            if missing:
                # all iqair calls share the global lock: concurrent
                # candle/price requests would clobber the lib's shared
                # response slots (and a KeyError here would push the
                # lib into its reconnect busy-wait). SHORT wait - a
                # price poll degrades to partial results instead of
                # queueing behind a 240-bar candle pull.
                try:
                    with lock_guard(PRICE_WAIT):
                        # per-call fetch budget: a big visible window must
                        # never hold the bus for tens of seconds (that
                        # starved the 4s active-asset poll into timeouts).
                        # Tickers left unfetched stay uncached - the next
                        # UI poll (8s) continues where this one stopped.
                        budget = time.time() + 3.0
                        for t in missing:
                            if time.time() > budget:
                                break
                            if OP_code is not None and t not in OP_code.ACTIVES:
                                continue
                            try:
                                data = _client.get_candles(t, 60, 1, int(time.time()))
                                if data and isinstance(data[-1], dict) and data[-1].get("close") is not None:
                                    p = float(data[-1]["close"])
                                    _prices_cache[t] = (p, time.time())
                                    prices[t] = p
                            except Exception:  # noqa: BLE001
                                pass
                except SidecarBusy:
                    pass  # serve the stream/cache hits we already have
            return self._send(_ok({"prices": prices}))

        try:
            with lock_guard():
                if path == "/disconnect":
                    try:
                        _client.disconnect()
                    finally:
                        _client = None
                    return self._send(_ok())

                if path == "/trade":
                    mode = (body.get("mode") or "turbo").lower()
                    asset = body.get("asset")
                    amount = float(body.get("amount", 0))
                    direction = (body.get("direction") or "call").lower()
                    expiry = int(body.get("expiry_minutes", 1))
                    leverage = body.get("leverage")
                    strike_offset = body.get("strike_offset_pct")
                    if amount <= 0 or not asset:
                        return self._send(_err("asset and positive amount required"), 400)

                    # ---- options family ----
                    if mode in ("turbo", "binary", "digital", "digital-option", "binary-option", "turbo-option"):
                        # Resolve the ticker across BOTH option families and
                        # route to what the account actually offers. IQ splits
                        # instruments into turbo/binary (buyv3, numeric id)
                        # and digital (server-resolved instrument contracts);
                        # an account may carry a ticker in only one of them.
                        digital_req = mode.startswith("digital")
                        tb_id = _resolve_active_id(asset)
                        dig_id = _resolve_digital_id(asset) if digital_req or tb_id is None else None
                        if digital_req:
                            if dig_id is not None:
                                check, order_id = _buy_digital_spot(amount, asset, direction, expiry)
                            elif tb_id is not None:
                                # requested digital, account only has turbo/binary
                                check, order_id = _buy_fast(amount, int(tb_id), direction, expiry)
                                mode = "turbo"
                            else:
                                return self._send(_err(f"{asset} is not a digital/turbo/binary instrument on this IQ account"), 400)
                        else:
                            if tb_id is not None:
                                # turbo/binary fast path: resolve the numeric
                                # active_id ONCE (cached account metadata) and
                                # send buyv3 directly. _client.buy() re-scans
                                # the whole init table on EVERY order (slow)
                                # and falls back to a stale 2018 static table
                                # that lacks OTC/new tickers -> active_id null
                                # -> server rejection ("ActiveId is not nullable")
                                check, order_id = _buy_fast(amount, int(tb_id), direction, expiry)
                            elif dig_id is not None:
                                # requested turbo/binary, account only offers
                                # this ticker as a digital option (common on
                                # newer IQ accounts) - route to digital spot
                                check, order_id = _buy_digital_spot(amount, asset, direction, expiry)
                                mode = "digital-option"
                            else:
                                return self._send(_err(f"{asset} is not a turbo/binary/digital instrument on this IQ account"), 400)

                    # ---- margin / CFD family ----
                    elif mode in ("forex", "crypto", "stock", "index", "commodity", "cfd"):
                        if not leverage:
                            leverage = 10
                        # route to the most specific method iqair exposes, else generic CFD
                        fn = None
                        for fn_name in (f"buy_{mode}_market", "buy_cfd_market", "buy_margin_spot"):
                            candidate = getattr(_client, fn_name, None)
                            if callable(candidate):
                                fn = candidate
                                break
                        if fn is None:
                            return self._send(_err(f"iqair client has no {mode} buy method"), 502)
                        try:
                            check, order_id = fn(asset, amount, direction, leverage)
                        except TypeError:
                            check, order_id = fn(asset, amount, direction)
                    else:
                        return self._send(_err(f"unsupported mode {mode}"), 400)

                    if not check:
                        return self._send(_err(f"order rejected: {order_id}"), 502)
                    return self._send(_ok({"order_id": order_id, "mode": mode, "asset": asset}))

                if path == "/close_trade":
                    mode = (body.get("mode") or "turbo").lower()
                    order_id = body.get("order_id")
                    if order_id is None:
                        return self._send(_err("order_id required"), 400)
                    if mode.startswith("digital"):
                        fn = getattr(_client, "close_digital_option", None) or getattr(_client, "sell_option", None)
                        raw = fn(order_id)
                    elif mode.startswith("turbo") or mode.startswith("binary"):
                        # iqair 1.0.0: sell_option returns the response dict directly
                        raw = _client.sell_option(order_id)
                    else:
                        fn = getattr(_client, "close_margin_position", None) or getattr(_client, "close_cfd", None)
                        if fn is None:
                            return self._send(_err("iqair client has no margin close method"), 502)
                        raw = fn(order_id)
                    # tolerate both legacy (check, data) tuples and direct payloads
                    if isinstance(raw, tuple) and len(raw) == 2:
                        check, data = bool(raw[0]), raw[1]
                    else:
                        check, data = bool(raw), raw
                    return self._send(_ok({"closed": check, "data": data}))

                if path == "/positions":
                    itype = body.get("instrument_type") or "turbo-option"
                    ok, data = _client.get_positions(itype)
                    return self._send(_ok({"positions": data.get("positions", []) if ok and isinstance(data, dict) else []}))

                if path == "/payouts":
                    # best-effort payout snapshot for the active asset
                    asset = body.get("asset") or "EURUSD"
                    out = {"asset": asset}
                    for name, fn_name in (("binary", "get_binary_payout"), ("turbo", "get_turbo_payout"), ("digital", "get_digital_payout")):
                        fn = getattr(_client, fn_name, None)
                        if callable(fn):
                            try:
                                ok2, val = fn(asset)
                                if ok2:
                                    out[name] = val
                            except Exception:
                                pass
                    return self._send(_ok(out))

                if path == "/history":
                    itype = body.get("instrument_type") or "turbo-option"
                    limit = int(body.get("limit", 20))
                    # iqair 1.0.0 moved position history to the api layer:
                    # api.get_position_history_v2 is a command factory; the
                    # websocket response lands in api.position_history_v2.
                    _client.api.position_history_v2 = None
                    user_id = None
                    try:
                        prof = _client.get_profile()
                        if isinstance(prof, dict) and prof.get("user_id"):
                            user_id = int(prof["user_id"])
                    except Exception:  # noqa: BLE001
                        user_id = None
                    if user_id is None:
                        try:
                            user_id = int(_client.api.profile.user_id)
                        except Exception:  # noqa: BLE001
                            user_id = None
                    _client.api.get_position_history_v2()(itype, limit, offset=0, user_id=user_id)
                    deadline = time.time() + 10
                    while _client.api.position_history_v2 is None and time.time() < deadline:
                        time.sleep(0.1)
                    raw = _client.api.position_history_v2
                    if raw is None:
                        return self._send(_err("history fetch timed out"), 504)
                    payload = raw.get("body", raw) if isinstance(raw, dict) else raw
                    items = payload.get("positions", payload) if isinstance(payload, dict) else payload
                    return self._send(_ok({"history": items if isinstance(items, list) else []}))

            return self._send(_err(f"no POST route {path}"), 404)
        except SidecarBusy:
            return self._send(_err("iqair bus busy - retry shortly"), 503)
        except Exception as exc:  # noqa: BLE001
            return self._send(_err(exc), 500)


class Server(ThreadingHTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    print(f"[iqair-sidecar] listening on http://{HOST}:{PORT} - POST /connect to start a session")
    # transparent auto-resume: if a previous session saved its ssid, bring the
    # client back BEFORE anyone asks - kernel boot-restore / adopt will find a
    # connected sidecar and the operator never re-enters credentials
    threading.Thread(target=_try_resume_session, daemon=True).start()
    Server((HOST, PORT), Handler).serve_forever()
