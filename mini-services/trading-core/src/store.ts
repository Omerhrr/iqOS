// IQAIR//OS - Persistence (bun:sqlite)
// Account, positions/trade journal, risk config, alerts, agent chat sessions
// and the autopilot bot fleet.

import { Database } from 'bun:sqlite'
import type { AccountState, Position, Candle } from './types'
import type { BotConfig } from './plugins/autopilot'
import type { AlertRule } from './plugins/alert-rules'

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
        live_mode TEXT,
        source TEXT NOT NULL DEFAULT 'paper'
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
      CREATE TABLE IF NOT EXISTS copilot_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'note',
        content TEXT NOT NULL,
        tags TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_copilot_notes_ts ON copilot_notes(ts);
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        config TEXT NOT NULL,
        created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS alert_rules (
        id TEXT PRIMARY KEY,
        config TEXT NOT NULL,
        created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS risk_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        config TEXT NOT NULL,
        hwm REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS risk_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS watchdog_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        config TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS watchdog_state (
        bot_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        updated_ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS watchdog_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        bot_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL
      );
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
      );
      CREATE TABLE IF NOT EXISTS os_mode (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mode TEXT NOT NULL,
        reason TEXT,
        ts INTEGER NOT NULL,
        config TEXT
      );
    `)
    // column migrations for databases created before the column existed:
    // CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so the
    // account source column must be added explicitly (guarded - it throws
    // when the column is already there).
    try {
      this.db.run(`ALTER TABLE account ADD COLUMN source TEXT NOT NULL DEFAULT 'paper'`)
    } catch {
      // column already exists - nothing to migrate
    }
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
      liveBalance: row.live_balance,
      source: 'paper', // overridden by execution.account() when trading on iq
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

  /** Persisted account source ('paper' | 'iq') - survives kernel restarts so
   * the boot sequence restores the SAME ledger + feed the operator left on. */
  getSource(): 'paper' | 'iq' {
    const row = this.db.query('SELECT source FROM account WHERE id = 1').get() as { source?: string } | null
    return row?.source === 'iq' ? 'iq' : 'paper'
  }

  setSource(source: 'paper' | 'iq'): void {
    this.db.run('UPDATE account SET source = ? WHERE id = 1', [source])
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

  /**
   * True-up a live position from the broker's own books (portfolio v4):
   * expiration_time -> settles_at (IQ aligns expiries to minute boundaries,
   * our local now+N*60 guess can be off by +-30s) and openPrice ->
   * entry_price (IQ settles against ITS open quote, not our feed tick).
   */
  updateLiveMeta(id: string, patch: { settlesAt?: number; entryPrice?: number }): void {
    const sets: string[] = []
    const vals: (number | string)[] = []
    if (patch.settlesAt !== undefined) {
      sets.push('settles_at = ?')
      vals.push(patch.settlesAt)
    }
    if (patch.entryPrice !== undefined) {
      sets.push('entry_price = ?')
      vals.push(patch.entryPrice)
    }
    if (!sets.length) return
    vals.push(id)
    this.db.run(`UPDATE positions SET ${sets.join(', ')} WHERE id = ?`, vals)
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

  // ---------- copilot persistent memory ----------

  saveNote(kind: string, content: string, tags?: string): { id: number; ts: number } {
    const ts = Math.floor(Date.now() / 1000)
    const out = this.db
      .query('INSERT INTO copilot_notes (ts, kind, content, tags) VALUES (?, ?, ?, ?) RETURNING id, ts')
      .get(ts, kind, content, tags ?? null) as { id: number; ts: number } | null
    return { id: out?.id ?? 0, ts }
  }

  listNotes(q: string, limit = 30): { id: number; ts: number; kind: string; content: string; tags: string | null }[] {
    const lim = Math.min(Math.max(limit, 1), 100)
    if (q) {
      const like = `%${q.toLowerCase()}%`
      return this.db
        .query(
          "SELECT id, ts, kind, content, tags FROM copilot_notes WHERE lower(content) LIKE ? OR lower(kind) LIKE ? OR lower(coalesce(tags,'')) LIKE ? ORDER BY id DESC LIMIT ?"
        )
        .all(like, like, like, lim) as unknown as { id: number; ts: number; kind: string; content: string; tags: string | null }[]
    }
    return this.db
      .query('SELECT id, ts, kind, content, tags FROM copilot_notes ORDER BY id DESC LIMIT ?')
      .all(lim) as unknown as { id: number; ts: number; kind: string; content: string; tags: string | null }[]
  }

  deleteNote(id: number): boolean {
    const res = this.db.run('DELETE FROM copilot_notes WHERE id = ?', [id])
    return res.changes > 0
  }

  // ---------- autopilot bots ----------

  saveBot(bot: BotConfig): void {
    const now = Math.floor(Date.now() / 1000)
    const existing = this.db.query('SELECT created_ts FROM bots WHERE id = ?').get(bot.id) as { created_ts: number } | null
    this.db.run(
      'INSERT INTO bots (id, config, created_ts, updated_ts) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_ts = excluded.updated_ts',
      [bot.id, JSON.stringify(bot), existing?.created_ts ?? now, now]
    )
  }

  deleteBot(id: string): boolean {
    const res = this.db.run('DELETE FROM bots WHERE id = ?', [id])
    return res.changes > 0
  }

  listBots(): { bot: BotConfig; createdTs: number }[] {
    const rows = this.db.query('SELECT config, created_ts FROM bots ORDER BY created_ts ASC').all() as {
      config: string
      created_ts: number
    }[]
    return rows.map((r) => {
      try {
        return { bot: JSON.parse(r.config) as BotConfig, createdTs: r.created_ts }
      } catch {
        // corrupted row - drop it rather than poison the fleet
        this.db.run('DELETE FROM bots WHERE config = ?', [r.config])
        return null
      }
    }).filter((x): x is { bot: BotConfig; createdTs: number } => x !== null)
  }

  /** Journal rows for one bot (positions tagged note = bot:{id}). */
  botJournal(botId: string, limit = 200): Position[] {
    const rows = this.db
      .query("SELECT * FROM positions WHERE note = ? ORDER BY ts_open DESC LIMIT ?")
      .all(`bot:${botId}`, limit) as Record<string, unknown>[]
    return rows.map((r) => this.rowToPosition(r))
  }

  // ---------- alert rules ----------

  saveAlertRule(rule: AlertRule): void {
    const now = Math.floor(Date.now() / 1000)
    const existing = this.db.query('SELECT created_ts FROM alert_rules WHERE id = ?').get(rule.id) as { created_ts: number } | null
    this.db.run(
      'INSERT INTO alert_rules (id, config, created_ts, updated_ts) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_ts = excluded.updated_ts',
      [rule.id, JSON.stringify(rule), existing?.created_ts ?? now, now]
    )
  }

  deleteAlertRule(id: string): boolean {
    const res = this.db.run('DELETE FROM alert_rules WHERE id = ?', [id])
    return res.changes > 0
  }

  listAlertRules(): { rule: AlertRule; createdTs: number }[] {
    const rows = this.db.query('SELECT config, created_ts FROM alert_rules ORDER BY created_ts ASC').all() as {
      config: string
      created_ts: number
    }[]
    return rows
      .map((r) => {
        try {
          return { rule: JSON.parse(r.config) as AlertRule, createdTs: r.created_ts }
        } catch {
          // corrupted row - drop it rather than poison the evaluator
          this.db.run('DELETE FROM alert_rules WHERE config = ?', [r.config])
          return null
        }
      })
      .filter((x): x is { rule: AlertRule; createdTs: number } => x !== null)
  }

  // ---------- sentinel (risk governance) ----------

  /** Persisted sentinel config blob (limits + breakers + high-water mark). */
  getSentinelState(): { config: unknown; hwm: number } | null {
    const row = this.db.query('SELECT config, hwm FROM risk_config WHERE id = 1').get() as { config: string; hwm: number } | null
    if (!row) return null
    try {
      return { config: JSON.parse(row.config), hwm: row.hwm }
    } catch {
      return null
    }
  }

  saveSentinelState(config: unknown, hwm: number): void {
    this.db.run(
      'INSERT INTO risk_config (id, config, hwm) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config, hwm = excluded.hwm',
      [JSON.stringify(config), hwm]
    )
  }

  recordRiskEvent(kind: string, message: string, ts: number): void {
    this.db.run('INSERT INTO risk_events (ts, kind, message) VALUES (?, ?, ?)', [ts, kind, message])
  }

  listRiskEvents(limit = 50): { ts: number; kind: string; message: string }[] {
    return this.db
      .query('SELECT ts, kind, message FROM risk_events ORDER BY id DESC LIMIT ?')
      .all(limit) as { ts: number; kind: string; message: string }[]
  }

  // ---------- os mode (human-in-the-loop governor) ----------

  /** Persisted OS mode row: mode + last change reason + auto-trader config blob. */
  getOsMode(): { mode: string; reason: string | null; ts: number; config: unknown } | null {
    const row = this.db.query('SELECT mode, reason, ts, config FROM os_mode WHERE id = 1').get() as {
      mode: string
      reason: string | null
      ts: number
      config: string | null
    } | null
    if (!row) return null
    let config: unknown = null
    try {
      config = row.config ? JSON.parse(row.config) : null
    } catch {
      config = null
    }
    return { mode: row.mode, reason: row.reason, ts: row.ts, config }
  }

  saveOsMode(mode: string, reason: string, ts: number, config: unknown): void {
    this.db.run(
      'INSERT INTO os_mode (id, mode, reason, ts, config) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET mode = excluded.mode, reason = excluded.reason, ts = excluded.ts, config = excluded.config',
      [mode, reason, ts, config === null ? null : JSON.stringify(config)]
    )
  }

  // ---------- watchdog (strategy health) ----------

  getWatchdogConfig(): unknown | null {
    const row = this.db.query('SELECT config FROM watchdog_config WHERE id = 1').get() as { config: string } | null
    if (!row) return null
    try {
      return JSON.parse(row.config)
    } catch {
      return null
    }
  }

  saveWatchdogConfig(config: unknown): void {
    this.db.run('INSERT INTO watchdog_config (id, config) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config', [
      JSON.stringify(config),
    ])
  }

  getWatchdogStates(): { botId: string; state: unknown; updatedTs: number }[] {
    const rows = this.db.query('SELECT bot_id, state, updated_ts FROM watchdog_state').all() as {
      bot_id: string
      state: string
      updated_ts: number
    }[]
    return rows.map((r) => {
      try {
        return { botId: r.bot_id, state: JSON.parse(r.state), updatedTs: r.updated_ts }
      } catch {
        // corrupted row - drop it rather than poison the health engine
        this.db.run('DELETE FROM watchdog_state WHERE bot_id = ?', [r.bot_id])
        return null
      }
    }).filter((x): x is { botId: string; state: unknown; updatedTs: number } => x !== null)
  }

  saveWatchdogState(botId: string, state: unknown): void {
    this.db.run(
      'INSERT INTO watchdog_state (bot_id, state, updated_ts) VALUES (?, ?, ?) ON CONFLICT(bot_id) DO UPDATE SET state = excluded.state, updated_ts = excluded.updated_ts',
      [botId, JSON.stringify(state), Math.floor(Date.now() / 1000)]
    )
  }

  deleteWatchdogState(botId: string): void {
    this.db.run('DELETE FROM watchdog_state WHERE bot_id = ?', [botId])
  }

  recordWatchdogEvent(botId: string, kind: string, message: string, ts: number): void {
    this.db.run('INSERT INTO watchdog_events (ts, bot_id, kind, message) VALUES (?, ?, ?, ?)', [ts, botId, kind, message])
  }

  listWatchdogEvents(limit = 50): { ts: number; bot_id: string; kind: string; message: string }[] {
    return this.db
      .query('SELECT ts, bot_id, kind, message FROM watchdog_events ORDER BY id DESC LIMIT ?')
      .all(limit) as { ts: number; bot_id: string; kind: string; message: string }[]
  }

  // ---------- candles archive (deep history) ----------

  /** Batched UPSERT of closed candles. Rows may overlap existing keys - PK dedupes. */
  saveCandles(rows: { asset: string; tf: string; time: number; open: number; high: number; low: number; close: number; volume: number }[]): void {
    if (!rows.length) return
    const stmt = this.db.prepare(
      'INSERT INTO candles_archive (asset, tf, time, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(asset, tf, time) DO UPDATE SET open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close, volume = excluded.volume'
    )
    const tx = this.db.transaction((batch: typeof rows) => {
      for (const r of batch) stmt.run(r.asset, r.tf, r.time, r.open, r.high, r.low, r.close, r.volume)
    })
    for (let i = 0; i < rows.length; i += 500) tx(rows.slice(i, i + 500))
  }

  /** Newest `limit` archived candles for one asset|tf, ascending by time. */
  getCandlesArchive(asset: string, tf: string, limit: number): Candle[] {
    const rows = this.db
      .query('SELECT time, open, high, low, close, volume FROM candles_archive WHERE asset = ? AND tf = ? ORDER BY time DESC LIMIT ?')
      .all(asset, tf, Math.max(1, Math.min(limit, 5000))) as { time: number; open: number; high: number; low: number; close: number; volume: number }[]
    return rows.reverse().map((r) => ({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }))
  }

  archiveCount(asset: string, tf: string): number {
    const row = this.db.query('SELECT COUNT(*) n FROM candles_archive WHERE asset = ? AND tf = ?').get(asset, tf) as { n: number }
    return row.n
  }

  archiveStats(): {
    rows: number
    keys: number
    top: { asset: string; tf: string; n: number; oldest: number; newest: number }[]
    perTf: { tf: string; n: number }[]
  } {
    const tot = this.db.query('SELECT COUNT(*) n, COUNT(DISTINCT asset || "|" || tf) k FROM candles_archive').get() as { n: number; k: number }
    const top = this.db
      .query('SELECT asset, tf, COUNT(*) n, MIN(time) oldest, MAX(time) newest FROM candles_archive GROUP BY asset, tf ORDER BY n DESC LIMIT 12')
      .all() as { asset: string; tf: string; n: number; oldest: number; newest: number }[]
    const perTf = this.db.query('SELECT tf, COUNT(*) n FROM candles_archive GROUP BY tf').all() as { tf: string; n: number }[]
    return { rows: tot.n, keys: tot.k, top, perTf }
  }

  /** Trim every asset|tf key to its newest `cap` bars. Returns removed rows. */
  pruneArchive(cap: number): number {
    const over = this.db
      .query('SELECT asset, tf, COUNT(*) n FROM candles_archive GROUP BY asset, tf HAVING n > ?')
      .all(cap) as { asset: string; tf: string; n: number }[]
    if (!over.length) return 0
    const del = this.db.prepare(
      'DELETE FROM candles_archive WHERE asset = ? AND tf = ? AND time <= (SELECT time FROM candles_archive WHERE asset = ? AND tf = ? ORDER BY time DESC LIMIT 1 OFFSET ?)'
    )
    const tx = this.db.transaction((batch: typeof over) => {
      let n = 0
      for (const k of batch) n += del.run(k.asset, k.tf, k.asset, k.tf, cap - 1).changes
      return n
    })
    return tx(over)
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

  /** Closed positions with optional note-prefix filter (e.g. 'bot:' for autopilot trades). */
  journal(notePrefix?: string, limit = 500): Position[] {
    const rows = (
      notePrefix
        ? this.db.query("SELECT * FROM positions WHERE status != 'open' AND note LIKE ? ORDER BY ts_open DESC LIMIT ?").all(`${notePrefix}%`, limit)
        : this.db.query("SELECT * FROM positions WHERE status != 'open' ORDER BY ts_open DESC LIMIT ?").all(limit)
    ) as Record<string, unknown>[]
    return rows.map((r) => this.rowToPosition(r)).reverse()
  }
}
