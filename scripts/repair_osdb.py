#!/usr/bin/env python3
"""Repair a corrupted candles_archive table in the iqOS kernel DB.

The archive is regenerable cache data (closed bars re-persist as the feed
advances), so the safe repair is: rebuild the whole DB file fresh, copying
every readable table row-for-row and creating candles_archive empty. Every
other table (account, positions, bots, lab_strategies, ...) is preserved.

Run ONLY while the kernel is stopped. Usage: python3 scripts/repair_osdb.py
"""
import os
import sqlite3
import sys

DB = "/home/z/my-project/mini-services/trading-core/data/os.db"
SKIP_TABLES = {"candles_archive"}  # corrupted - recreated empty

ARCHIVE_SCHEMA = """
CREATE TABLE IF NOT EXISTS candles_archive (
  asset TEXT NOT NULL,
  tf TEXT NOT NULL,
  time INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume INTEGER NOT NULL,
  PRIMARY KEY (asset, tf, time)
)
"""

def main() -> int:
    if not os.path.exists(DB):
        print(f"missing: {DB}")
        return 1
    # fold any pending WAL into the main file before copying
    try:
        wal = sqlite3.connect(DB)
        wal.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        wal.close()
        print("wal checkpointed")
    except Exception as e:
        print(f"wal checkpoint skipped: {e}")

    src = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    tables = [r[0] for r in src.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()]
    print("source tables:", tables)

    tmp = DB + ".new"
    if os.path.exists(tmp):
        os.remove(tmp)
    dst = sqlite3.connect(tmp)
    dst.executescript(ARCHIVE_SCHEMA)

    copied, skipped = [], []
    for t in tables:
        if t in SKIP_TABLES:
            skipped.append(t)
            continue
        try:
            rows = src.execute(f"SELECT * FROM {t}").fetchall()
            cols = [d[1] for d in src.execute(f"PRAGMA table_info({t})").fetchall()]
            ddl = src.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (t,)).fetchone()[0]
            dst.execute(ddl)
            ph = ",".join("?" * len(cols))
            dst.executemany(f"INSERT INTO {t} VALUES ({ph})", rows)
            copied.append((t, len(rows)))
        except Exception as e:
            skipped.append(f"{t} ({e})")
    # copy indexes for the copied tables
    for (name, ddl, tbl) in src.execute(
            "SELECT name, sql, tbl_name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").fetchall():
        if tbl in skipped or any(tbl.startswith(s.split(" ")[0]) for s in []):
            continue
        try:
            dst.execute(ddl)
        except Exception:
            pass  # index on a skipped table
    dst.commit()
    ok = dst.execute("PRAGMA integrity_check").fetchone()[0]
    dst.close()
    src.close()
    print("copied:", copied)
    print("skipped:", skipped)
    print("integrity:", ok)
    if ok != "ok":
        print("refusing to swap - new db failed integrity check")
        return 1
    os.replace(DB, DB + ".corrupt-bak")
    os.replace(tmp, DB)
    for ext in ("-wal", "-shm"):
        stale = DB + ext
        if os.path.exists(stale):
            os.remove(stale)
    print("swapped in repaired db; old file kept as", DB + ".corrupt-bak")
    return 0

if __name__ == "__main__":
    sys.exit(main())
