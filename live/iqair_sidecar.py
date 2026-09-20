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

import json
import threading

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

HOST = "127.0.0.1"
PORT = 8788

_lock = threading.Lock()
_client = None  # iqair IQOptionClient, set by /connect


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
            return self._send(_ok({"connected": connected}))

        if _client is None:
            return self._send(_err("not connected - POST /connect first"), 400)

        try:
            with _lock:
                if path == "/balance":
                    ok, bal = _client.get_balance()
                    if not ok:
                        return self._send(_err("balance fetch failed"), 502)
                    return self._send(_ok({"amount": bal.get("amount"), "mode": bal.get("currency")}))

                if path == "/assets":
                    ok, data = _client.get_assets_raw() if hasattr(_client, "get_assets_raw") else (False, None)
                    if not ok or data is None:
                        # fall back to the agent tool layer if present
                        from iqair.agent import tools as agent_tools
                        return self._send(_ok({"assets": agent_tools.list_assets(open_only=False).get("assets", [])}))
                    return self._send(_ok({"assets": data}))

                if path == "/candles":
                    asset = params.get("asset", "EURUSD")
                    size = int(params.get("size", 300))
                    tf = int(params.get("tf", 60))
                    ok, data = _client.get_candles(asset, size, tf)
                    if not ok:
                        return self._send(_err("candles fetch failed"), 502)
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

                if path == "/price":
                    asset = params.get("asset", "EURUSD")
                    ok, data = _client.get_financial_information(asset)
                    if not ok:
                        return self._send(_err("price fetch failed"), 502)
                    price = None
                    try:
                        price = float(data["ask"]["price"])  # mid-ish quote
                    except Exception:
                        try:
                            price = float(data.get("price"))
                        except Exception:
                            pass
                    if price is None:
                        return self._send(_err("no price in response"), 502)
                    return self._send(_ok({"asset": asset, "price": price}))

            return self._send(_err(f"no GET route {path}"), 404)
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
                return self._send(_ok({"connected": True, "balance_mode": mode}))
            except Exception as exc:  # noqa: BLE001
                return self._send(_err(exc), 500)

        if _client is None:
            return self._send(_err("not connected - POST /connect first"), 400)

        try:
            with _lock:
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
                        # digital options: prefer a dedicated iqair method when available
                        digital = mode.startswith("digital")
                        if digital:
                            check, order_id = None, None
                            for fn_name in ("buy_digital", "buy_digital_option", "buy_digitals"):
                                fn = getattr(_client, fn_name, None)
                                if not callable(fn):
                                    continue
                                for args in (
                                    (asset, amount, direction, expiry, float(strike_offset)) if strike_offset is not None else None,
                                    (asset, amount, direction, expiry),
                                ):
                                    if args is None:
                                        continue
                                    try:
                                        check, order_id = fn(*args)
                                        break
                                    except TypeError:
                                        continue
                                    except Exception as exc:
                                        check, order_id = False, str(exc)
                                        break
                                if check is not None:
                                    break
                            if check is None:
                                check, order_id = _client.buy(amount, asset, direction, expiry)
                        else:
                            check, order_id = _client.buy(amount, asset, direction, expiry)

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
                        check, data = fn(order_id)
                    elif mode.startswith("turbo") or mode.startswith("binary"):
                        check, data = _client.sell_option(order_id)
                    else:
                        fn = getattr(_client, "close_margin_position", None) or getattr(_client, "close_cfd", None)
                        if fn is None:
                            return self._send(_err("iqair client has no margin close method"), 502)
                        check, data = fn(order_id)
                    return self._send(_ok({"closed": bool(check), "data": data}))

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
                    ok, data = _client.get_position_history_v2(itype, limit=limit, offset=0)
                    return self._send(_ok({"history": data if ok else []}))

            return self._send(_err(f"no POST route {path}"), 404)
        except Exception as exc:  # noqa: BLE001
            return self._send(_err(exc), 500)


class Server(ThreadingHTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    print(f"[iqair-sidecar] listening on http://{HOST}:{PORT} - POST /connect to start a session")
    Server((HOST, PORT), Handler).serve_forever()
