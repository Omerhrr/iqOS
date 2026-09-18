// IQAIR//OS - Persistence (bun:sqlite)
// Account, positions/trade journal, risk config, alerts and agent chat sessions.

import { Database } from 'bun:sqlite'
import type { AccountState, Position } from './types'

export class Store {
  private db: Database

  constructor(path: string) {
    this.db = new Database(path, { create: true })
    this.db.run('PRAGMA journal_mode = WAL;')
    this.migrate()
    this.seedAccount()
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS account (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        balance REAL NOT NULL,
        start_balance REAL NOT NULL,
        day_key TEXT NOT NULL,
        day_start_balance REAL NOT NULL,
        kill_switch INTEGER NOT NULL DEFAULT 0,
        live_balance REAL,
        live_mode TEXT
      );
      CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY,
        ts_open INTEGER NOT NULL,
        ts_close INTEGER,
        asset TEXT NOT NULL,
        tf TEXT NOT NULL,
        side TEXT NOT NULL,
        kind TEXT NOT NULL,
        mode TEXT NOT NULL,
        amount REAL NOT NULL,
        expiry_bars INTEGER NOT NULL DEFAULT 0,
        entry_price REAL NOT NULL,
        exit_price REAL,
        payout REAL NOT NULL DEFAULT 0.85,
        pnl REAL,
        status TEXT NOT NULL,
        strategy TEXT,
        note TEXT,
        live_order_id TEXT,
        settles_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
      CREATE INDEX IF NOT EXISTS idx_positions_ts ON positions(ts_open);
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        meta TEXT
      );
    `)
  }

  private seedAccount(): void {
    const row = this.db.query('SELECT id FROM account WHERE id = 1').get()
    if (!row) {
      const dayKey = new Date().toISOString().slice(0, 10)
      this.db.run(
        'INSERT INTO account (id, balance, start_balance, day_key, day_start_balance) VALUES (1, 10000, 10000, ?, 10000)',
        [dayKey]
      )
    }
  }

  // ---------- account ----------

  getAccount(): AccountState {
    const row = this.db.query('SELECT * FROM account WHERE id = 1').get() as {
      balance: number
      start_balance: number
      day_key: string
      day_start_balance: number
      kill_switch: number
      live_balance: number | null
      live_mode: string | null
    }
    const totalPnl = row.balance - row.start_balance
    return {
      balance: row.balance,
      startBalance: row.start_balance,
      mode: 'sim',
      balanceMode: row.live_mode ?? 'PRACTICE',
      dayKey: row.day_key,
      dayStartBalance: row.day_start_balance,
      dayPnl: row.balance - row.day_start_balance,
      totalPnl,
      killSwitch: row.kill_switch === 1,
      openPositions: this.listPositions('open').length,
    }
  }

  rolloverDay(): void {
    const today = new Date().toISOString().slice(0, 10)
    const row = this.db.query('SELECT day_key FROM account WHERE id = 1').get() as { day_key: string }
    if (row.day_key !== today) {
      this.db.run('UPDATE account SET day_key = ?, day_start_balance = (SELECT balance FROM account WHERE id = 1) WHERE id = 1', [today])
    }
  }

  adjustBalance(delta: number): void {
    this.db.run('UPDATE account SET balance = balance + ? WHERE id = 1', [delta])
  }

  resetAccount(balance: number): void {
    const dayKey = new Date().toISOString().slice(0, 10)
    this.db.run(
      'UPDATE account SET balance = ?, start_balance = ?, day_key = ?, day_start_balance = ?, kill_switch = 0 WHERE id = 1',
      [balance, balance, dayKey, balance]
    )
    this.db.run('DELETE FROM positions WHERE status = "open" AND mode = "paper"')
  }

  setKillSwitch(on: boolean): void {
    this.db.run('UPDATE account SET kill_switch = ? WHERE id = 1', [on ? 1 : 0])
  }

  setLiveBalance(amount: number, mode: string): void {
    this.db.run('UPDATE account SET live_balance = ?, live_mode = ? WHERE id = 1', [amount, mode])
  }

  // ---------- positions ----------

  insertPosition(p: Position): void {
    this.db.run(
      `INSERT INTO positions (id, ts_open, asset, tf, side, kind, mode, amount, expiry_bars, entry_price, payout, status, strategy, note, live_order_id, settles_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.id, p.tsOpen, p.asset, p.tf, p.side, p.kind, p.mode, p.amount, p.expiryBars, p.entryPrice, p.payout, p.status, p.strategy ?? null, p.note ?? null, p.liveOrderId ?? null, p.settlesAt ?? null]
    )
  }

  getPosition(id: string): Position | null {
    const row = this.db.query('SELECT * FROM positions WHERE id = ?').get(id) as Record<string, unknown> | null
    return row ? this.rowToPosition(row) : null
  }

  listPositions(status?: 'open' | 'closed', limit = 200): Position[] {
    let rows: Record<string, unknown>[]
    if (status === 'open') {
      rows = this.db.query("SELECT * FROM positions WHERE status = 'open' ORDER BY ts_open DESC LIMIT ?").all(limit) as Record<string, unknown>[]
    } else if (status === 'closed') {
      rows = this.db.query("SELECT * FROM positions WHERE status != 'open' ORDER BY ts_open DESC LIMIT ?").all(limit) as Record<string, unknown>[]
    } else {
      rows = this.db.query('SELECT * FROM positions ORDER BY ts_open DESC LIMIT ?').all(limit) as Record<string, unknown>[]
    }
    return rows.map((r) => this.rowToPosition(r))
  }

  settlePosition(id: string, exitPrice: number, status: string, pnl: number): Position | null {
    this.db.run('UPDATE positions SET status = ?, exit_price = ?, pnl = ?, ts_close = ? WHERE id = ?', [
      status,
      exitPrice,
      pnl,
      Math.floor(Date.now() / 1000),
      id,
    ])
    return this.getPosition(id)
  }

  lossStreak(): { count: number; lastLossTs: number } {
    const rows = this.db
      .query("SELECT status, ts_close FROM positions WHERE status != 'open' ORDER BY ts_close DESC LIMIT 20")
      .all() as { status: string; ts_close: number | null }[]
    let count = 0
    let lastLossTs = 0
    for (const r of rows) {
      if (r.status === 'lost') {
        count++
        lastLossTs = Math.max(lastLossTs, r.ts_close ?? 0)
      } else if (r.status === 'won') break
      // 'closed' rows (manual spot exits) don't break the streak evaluation
    }
    return { count, lastLossTs }
  }

  private rowToPosition(r: Record<string, unknown>): Position {
    return {
      id: r.id as string,
      tsOpen: r.ts_open as number,
      tsClose: (r.ts_close as number) ?? undefined,
      asset: r.asset as string,
      tf: r.tf as Position['tf'],
      side: r.side as Position['side'],
      kind: r.kind as Position['kind'],
      mode: r.mode as Position['mode'],
      amount: r.amount as number,
      expiryBars: r.expiry_bars as number,
      entryPrice: r.entry_price as number,
      exitPrice: (r.exit_price as number) ?? undefined,
      payout: r.payout as number,
      pnl: (r.pnl as number) ?? undefined,
      status: r.status as Position['status'],
      strategy: (r.strategy as string) ?? undefined,
      note: (r.note as string) ?? undefined,
      liveOrderId: (r.live_order_id as string) ?? undefined,
      settlesAt: (r.settles_at as number) ?? undefined,
    }
  }

  // ---------- alerts / journal ----------

  recordAlert(level: string, message: string, ts: number): void {
    this.db.run('INSERT INTO alerts (ts, level, message) VALUES (?, ?, ?)', [ts, level, message])
  }

  listAlerts(limit = 100): { ts: number; level: string; message: string }[] {
    return this.db
      .query('SELECT ts, level, message FROM alerts ORDER BY ts DESC LIMIT ?')
      .all(limit) as { ts: number; level: string; message: string }[]
  }

  // ---------- agent chat ----------

  saveChat(sessionId: string, role: string, content: string, meta?: unknown): void {
    this.db.run('INSERT INTO chat_messages (session_id, ts, role, content, meta) VALUES (?, ?, ?, ?, ?)', [
      sessionId,
      Math.floor(Date.now() / 1000),
      role,
      content,
      meta ? JSON.stringify(meta) : null,
    ])
  }

  listChat(sessionId: string, limit = 60): { ts: number; role: string; content: string }[] {
    return this.db
      .query('SELECT ts, role, content FROM chat_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?')
      .all(sessionId, limit) as unknown as { ts: number; role: string; content: string }[]
  }

  clearChat(sessionId: string): number {
    const row = this.db.query('SELECT COUNT(*) as n FROM chat_messages WHERE session_id = ?').get(sessionId) as { n: number }
    this.db.run('DELETE FROM chat_messages WHERE session_id = ?', [sessionId])
    return row.n ?? 0
  }

  stats(): { trades: number; wins: number; losses: number; netPnl: number } {
    const row = this.db
      .query(
        `SELECT COUNT(*) as trades,
                SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) as losses,
                COALESCE(SUM(pnl), 0) as netPnl
         FROM positions WHERE status != 'open'`
      )
      .get() as { trades: number; wins: number | null; losses: number | null; netPnl: number }
    return { trades: row.trades, wins: row.wins ?? 0, losses: row.losses ?? 0, netPnl: row.netPnl }
  }
}
