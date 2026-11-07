#!/usr/bin/env python3
"""Sidecar settlement-lookup engine - deterministic unit (python, in-process).

Locks the /order_result contract added with the stuck-settlement fix (live
binary 14425223607 polling "awaiting IQ confirmation" for 11h+ while IQ had
closed the trade):
  - _norm_id: int / digit-string / float-ized ids (14425223607.0) all match
  - _num: pnl figures arriving as strings ("-10.40", unicode minus, thousands
    separators) are readable; bool/garbage are not
  - _order_result_payload against a FAKE iqair client:
      * closed row matched by a float-ized id with a STRING pnl -> verdict
        found/closed with the parsed number
      * pnl absent but close_profit - invest derivable -> derived pnl
      * matched closed row with NO readable pnl -> pnl_unreadable verdict
        (the kernel settles flat under a loud alert, never hangs forever)
      * still-open row in get_positions -> found/open (keep waiting)
      * no match anywhere -> found:false WITHOUT an error (genuine wait)
      * every broker call raising -> found:false WITH error (surfaced loudly)
Runs against the real module (the daemon threads it starts are harmless in
this short-lived process; iqair resolves from the local checkout or PyPI).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + "/live")
sys.path.insert(0, "/tmp/iqair_inspect")  # local iqair install, skips the auto pip

import threading  # noqa: E402
import time  # noqa: E402

import iqair_sidecar as m  # noqa: E402

pass_n = 0
fail_n = 0


def ok(cond, name, detail=""):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print("  ok", name)
    else:
        fail_n += 1
        print("  FAIL", name, detail)


# ---------------- _norm_id ----------------
ok(m._norm_id(14425223607) == "14425223607", "int id normalizes")
ok(m._norm_id(14425223607.0) == "14425223607", "float-ized id matches its int form")
ok(m._norm_id("14425223607") == "14425223607", "string id normalizes")
ok(m._norm_id(" 14425223607 ") == "14425223607", "padded string id normalizes")
ok(m._norm_id(None) is None, "None id -> None (never matches)")
ok(m._norm_id(True) is None, "bool is not an id")
ok(m._norm_id("abc123") == "abc123", "non-numeric strings pass through for raw_event ids")

# ---------------- _num ----------------
ok(m._num(-10.4) == -10.4, "float pnl passes")
ok(m._num(-10) == -10.0, "int pnl passes")
ok(m._num("-10.40") == -10.4, "STRING pnl is readable (the silent-miss class)")
ok(m._num("\u221210.40") == -10.4, "unicode-minus STRING pnl is readable")
ok(m._num("1,234.50") == 1234.5, "thousands-separated STRING pnl is readable")
ok(m._num(" 8.5 ") == 8.5, "padded number is readable")
ok(m._num(None) is None, "None -> None")
ok(m._num(True) is None, "bool -> None")
ok(m._num("n/a") is None, "garbage string -> None")
ok(m._num("") is None, "empty string -> None")


# ---------------- _order_result_payload against a fake client ----------------
class FakeClient:
    """Mimics the two iqair calls /order_result uses. `open_rows` answers
    get_positions(); `hist_rows` answers get_position_history_v2() page 0;
    `raise_all` simulates a dead session."""

    def __init__(self, open_rows=None, hist_rows=None, raise_all=False):
        self.open_rows = open_rows or []
        self.hist_rows = hist_rows or []
        self.raise_all = raise_all

    def get_positions(self, itype, max_wait_sec=4, limit=100, offset=0):
        if self.raise_all:
            raise ConnectionError("session dead")
        return True, {"positions": list(self.open_rows)}

    def get_position_history_v2(self, itype, limit, offset, start=0, end=0, max_wait_sec=4):
        if self.raise_all:
            raise ConnectionError("session dead")
        rows = list(self.hist_rows) if offset == 0 else []
        return True, {"positions": rows}


def run(payload_body, client):
    m._client = client
    m._gv = None  # balance print falls back to '?'
    return m._order_result_payload(payload_body)


OID = 14425223607

# 1. float-ized id + string pnl - both silent-miss classes at once
res = run({"order_id": str(OID), "mode": "binary"}, FakeClient(hist_rows=[{"id": float(OID), "status": "closed", "pnl": "-10.40"}]))
ok(res.get("found") is True and res.get("status") == "closed", "float-ized id matched, string pnl read", str(res))
ok(res.get("pnl") == -10.4, "string pnl parsed to -10.4", str(res.get("pnl")))

# 2. external_id match + pnl derivable from close_profit - invest
res = run({"order_id": OID, "mode": "binary"}, FakeClient(hist_rows=[{"external_id": str(OID), "status": "closed", "close_profit": 10, "invest": 17}]))
ok(res.get("found") is True and res.get("pnl") == -7.0, "close_profit-invest derivation (10-17=-7)", str(res))

# 3. matched closed row, NO pnl anywhere -> explicit unreadable verdict
res = run({"order_id": OID, "mode": "binary"}, FakeClient(hist_rows=[{"id": OID, "status": "closed", "close_reason": "expired"}]))
ok(res.get("found") is True and res.get("pnl_unreadable") is True, "matched closed row without pnl -> pnl_unreadable verdict", str(res))
ok("row_keys" in res and "raw_event" not in res.get("row_keys", []), "row_keys disclosed for debugging, raw_event dropped", str(res.get("row_keys")))
ok("pnl" not in res, "no pnl key when unreadable (kernel must not read a fake number)", str(res.get("pnl")))

# 4. pnl_net fallback + close_quote/close_time pass-through
res = run(
    {"order_id": OID, "mode": "turbo"},
    FakeClient(hist_rows=[{"id": OID, "status": "lost", "pnl_net": "8.25", "close_quote": "1.08432", "close_time": 1_700_000_100.0}]),
)
ok(res.get("pnl") == 8.25, "pnl_net string fallback", str(res))
ok(res.get("close_price") == 1.08432, "close_quote passes through as close_price", str(res))
ok(res.get("close_time") == 1_700_000_100.0, "close_time passes through", str(res))

# 5. still-open position -> found/open, no settlement
res = run({"order_id": OID, "mode": "binary"}, FakeClient(open_rows=[{"id": OID, "status": "open"}]))
ok(res.get("found") is True and res.get("status") == "open", "open row -> found/open (kernel keeps waiting)", str(res))

# 6. genuinely not there -> found:false with NO error (a real "not closed yet")
res = run({"order_id": OID, "mode": "binary"}, FakeClient(hist_rows=[{"id": 999, "status": "closed", "pnl": 5}]))
ok(res.get("found") is False and "error" not in res, "no match -> clean found:false (wait path)", str(res))

# 7. every broker call raising -> the loud error verdict
res = run({"order_id": OID, "mode": "binary"}, FakeClient(raise_all=True))
ok(res.get("found") is False and "error" in res, "all lookups failing -> error verdict (never mistaken for not-closed-yet)", str(res))

# 8. digital mode searches the digital family
res = run({"order_id": OID, "mode": "digital"}, FakeClient(hist_rows=[{"position_id": str(OID), "status": "closed", "pnl": -3.2}]))
ok(res.get("found") is True and res.get("pnl") == -3.2, "digital family searched, position_id matched", str(res))

# 9. unicode-minus pnl inside a real row
res = run({"order_id": OID, "mode": "binary"}, FakeClient(hist_rows=[{"id": OID, "status": "closed", "pnl": "\u22123.2"}]))
ok(res.get("pnl") == -3.2, "unicode-minus pnl parsed", str(res))

# ---------------- _session_watchdog_verdict (the half-open-socket rot detector) ----------------
# Production rot mode: TCP alive so the lib's ws flag stays green, but IQ
# answers nothing - settlement polls keep being ATTEMPTED while nothing
# DEMONSTRABLY succeeds. The verdict must fire on that and ONLY on that.
NOW = 1_000_000.0

# no client -> never judge
exit_now, why = m._session_watchdog_verdict(NOW, False, None, NOW - 5)
ok(exit_now is False, "no client -> no restart")

# idle session (no attempt in the demand window) -> never judge, even with a stale ok
exit_now, why = m._session_watchdog_verdict(NOW, True, NOW - 10_000, NOW - 10_000)
ok(exit_now is False, "no recent demand -> no restart (idle must not be killed)")

# demand is fresh but IQ has NEVER answered -> rotten, restart
exit_now, why = m._session_watchdog_verdict(NOW, True, None, NOW - 5)
ok(exit_now is True and "never" in why, "demand with zero ever-successful responses -> restart", why)

# demand fresh, last ok older than stale_after (2min) -> rotten, restart with the age
exit_now, why = m._session_watchdog_verdict(NOW, True, NOW - 300.0, NOW - 5)
ok(exit_now is True and "300s ago" in why, "stale ok (300s) under fresh demand -> restart", why)

# boundary: stale means strictly PAST stale_after (the kernel's health hint
# uses the same >120 convention) - exactly 120s is the last healthy instant
exit_now, _ = m._session_watchdog_verdict(NOW, True, NOW - 120.0, NOW - 5)
ok(exit_now is False, "ok exactly 120s old -> not yet rotten (stale strictly past 120s)")
exit_now, _ = m._session_watchdog_verdict(NOW, True, NOW - 120.5, NOW - 5)
ok(exit_now is True, "ok 120.5s old -> rotten (boundary)")
exit_now, _ = m._session_watchdog_verdict(NOW, True, NOW - 119.0, NOW - 5)
ok(exit_now is False, "ok 119s old -> healthy (boundary)")

# demand just outside the window -> idle again (a one-off attempt long ago is not demand)
exit_now, _ = m._session_watchdog_verdict(NOW, True, None, NOW - 91.0)
ok(exit_now is False, "attempt older than the 90s demand window -> not judged")

# fresh ok under fresh demand -> healthy (the every-poll success case)
exit_now, why = m._session_watchdog_verdict(NOW, True, NOW - 3.0, NOW - 1.0)
ok(exit_now is False, "fresh ok under fresh demand -> healthy session")

# the note helpers actually move the bookkeeping the verdict reads
m._iq_last_ok = None
m._iq_last_attempt = None
m._note_iq_attempt()
ok(m._iq_last_attempt is not None and m._iq_last_ok is None, "_note_iq_attempt stamps demand only")
m._note_iq_ok()
ok(m._iq_last_ok is not None, "_note_iq_ok stamps the success side")

# ---------------- order_result records liveness against the fake client ----------------
m._iq_last_ok = None
m._iq_last_attempt = None
res = run({"order_id": OID, "mode": "binary"}, FakeClient(hist_rows=[{"id": OID, "status": "closed", "pnl": 5}]))
ok(m._iq_last_attempt is not None and m._iq_last_ok is not None,
   "a successful order_result poll stamps attempt AND ok", f"{m._iq_last_attempt} / {m._iq_last_ok}")

m._iq_last_ok = None
m._iq_last_attempt = None
res = run({"order_id": OID, "mode": "binary"}, FakeClient(raise_all=True))
ok(m._iq_last_attempt is not None and m._iq_last_ok is None,
   "an all-failing poll stamps attempt but NOT ok (rot signal)", f"{m._iq_last_attempt} / {m._iq_last_ok}")

# ---------------- boot-resume hang guard: the pending stamp lifecycle ----------------
# The lib's connect() has `while global_value.balance_id == None: pass` - an
# unbounded busy-wait. The wrapper must stamp pending while the resume runs
# and clear it when it finishes (success OR failure), so the establishment
# watchdog only exits on a genuinely stuck resume.
orig_inner = m._try_resume_session_inner
m._resume_pending_since = None
m._try_resume_session_inner = lambda: (time.sleep(0.4), True)[1]
th = threading.Thread(target=m._try_resume_session, daemon=True)
th.start()
time.sleep(0.15)
ok(m._resume_pending_since is not None, "resume pending stamped while the resume is in flight")
th.join()
ok(m._resume_pending_since is None, "resume pending cleared when the resume finishes")

# a FAILING resume must also clear the stamp (no spurious restart loop)
m._try_resume_session_inner = lambda: False
th = threading.Thread(target=m._try_resume_session, daemon=True)
th.start(); th.join()
ok(m._resume_pending_since is None, "failed resume also clears the pending stamp")
m._try_resume_session_inner = orig_inner

print(f"settlement_sidecar_unit: {pass_n} ok, {fail_n} fail")
sys.exit(1 if fail_n else 0)
