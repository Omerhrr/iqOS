#!/usr/bin/env python3
"""Read-only probe: what EXACT names does this IQ account use for EURUSD(OTC)
in the turbo/binary init table vs the digital underlying list?
Runs in its own process with the saved ssid - does NOT touch the sidecar."""
import json
import os
import sys
import time

sys.path.insert(0, "/home/z/.venv/lib/python3.12/site-packages")

SESSION_FILE = "/home/z/my-project/live/.iq_session"


def main():
    import iqair.global_value as gv
    from iqair.client import IQOptionClient

    with open(SESSION_FILE) as f:
        saved = json.load(f)
    gv.SSID = str(saved.get("ssid") or "")
    client = IQOptionClient(str(saved.get("email") or ""), "")
    ok, reason = client.connect()
    print(f"connect: {ok} {reason}", flush=True)
    if not ok:
        sys.exit(1)

    # ---- turbo/binary init table ----
    try:
        data = client.get_all_init_v2()
    except Exception as exc:
        print(f"get_all_init_v2 ERROR: {exc}")
        data = None
    if data:
        for option in ("turbo", "binary"):
            actives = (data or {}).get(option, {}).get("actives", {})
            hits = []
            for aid, active in actives.items():
                if not isinstance(active, dict):
                    continue
                t = str(active.get("ticker") or "")
                n = str(active.get("name") or "")
                if "EURUSD" in t.upper() or "EURUSD" in n.upper():
                    hits.append((aid, t, n))
            print(f"--- {option}: {len(actives)} actives, EURUSD hits: {len(hits)}")
            for aid, t, n in hits:
                print(f"    id={aid} ticker={t!r} name={n!r}")

    # ---- digital underlying list ----
    try:
        dig = client.get_digital_underlying_list_data()
    except Exception as exc:
        print(f"get_digital_underlying_list_data ERROR: {exc}")
        dig = None
    items = (dig or {}).get("underlying", []) if isinstance(dig, dict) else []
    print(f"--- digital underlyings: {len(items)} total")
    for item in items:
        if not isinstance(item, dict):
            continue
        u = str(item.get("underlying") or "")
        if "EURUSD" in u.upper():
            print(f"    underlying={u!r} active_id={item.get('active_id')} keys={sorted(item.keys())}")

    # ---- raw instrument sample for digital EURUSD-OTC (what does it look like?) ----
    try:
        ins = client.get_digital_instruments_data(60)
        data = (ins or {}).get("instrument_data", []) if isinstance(ins, dict) else []
        print(f"--- digital instruments (exp 60): {len(data)} total")
        for it in data[:3]:
            print(f"    sample={json.dumps(it)[:220]}")
    except Exception as exc:
        print(f"get_digital_instruments_data ERROR: {exc}")


if __name__ == "__main__":
    main()
