// ---------------------------------------------------------------------------
// HISTORY ROLLUPS (SOL book only — memes/CYB excluded by design)
//
// Long-memory daily statistics for the dashboard History tab. The live trade
// ledger is capped (~5000 fills) and the equity ring is capped (~7 days), but
// the forever journal (.botstate/trades-<mode>.jsonl) holds every fill, so
// year-scale history is rebuilt from that tape rather than being lost when the
// ledger overflows.
//
// Design rules:
//  - Measurement only. Nothing here feeds trading decisions.
//  - Deposits/withdrawals are external transfers, not trading profit. The bot
//    cannot detect them directly. We persist raw components (equityEod,
//    realized, fees, fills, roundTrips) and let the UI compute profit honestly
//    from realized minus fees. Equity deltas across a deposit simply show in
//    the equity line.
//  - ROWS ARE REBUILT FROM THE JOURNAL at startup, so any day with fills is
//    recovered even if the ledger has aged out or the bot was restarted. Days
//    with no fills are marked `noData` instead of silently omitted, so the UI
//    never renders a missing day as a misleading $0.
//  - Crash-safe: the file is written atomically (tmp+rename) and any read/write
//    failure degrades to empty stats, never throws into the trading loop.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Trade } from './types.js';
import { readJournal, readEquityArchive, type EquitySample } from './journal.js';

// Resolved lazily so an explicit override (tests, alternate deployments) takes
// effect even when set after this module is imported. Never a hardcoded path.
function stateDir(): string {
  return process.env.BOT_STATE_DIR || join(process.cwd(), '.botstate');
}
function historyFile(): string {
  return join(stateDir(), 'history-sol.json');
}

/** One UTC day of SOL-book trading, aggregated from real fills. */
export interface DayRollup {
  /** UTC date, YYYY-MM-DD. */
  day: string;
  /** Sum of SELL realizedPnlUsd for grid+dca fills (gross banked PnL). */
  realizedUsd: number;
  /** Sum of feeUsd for grid+dca fills (real network fees). */
  feesUsd: number;
  /** realized − fees. */
  netUsd: number;
  /** Total fills (buys+sells) across grid+dca. */
  fills: number;
  /** Completed round-trips: sells whose realizedPnl closed a basis. */
  roundTrips: number;
  /** Average winning sell (USD) in the day. */
  avgWinUsd: number;
  /** Average losing sell (USD, negative) in the day. */
  avgLossUsd: number;
  /** wins / total sells. */
  winRate: number;
  /** Total SELL fills with a realized outcome this day. */
  sells: number;
  /** Winning sells this day. */
  wins: number;
  /** Gross winning USD this day. */
  sumWins: number;
  /** Gross losing USD (negative) this day. */
  sumLosses: number;
  /** Σwins / |Σlosses| for the day; null when no losing sells. */
  profitFactor: number | null;
  /** Last equity sample of the day (USDC + SOL*price at day end). */
  equityEod: number | null;
  /** Last price of the day. */
  priceEod: number | null;
  /** First equity sample of the day (for the UI's day-over-day equity delta). */
  equityBod: number | null;
  /** True when the bot recorded no SOL-book fills this day (idle/offline). */
  noData: boolean;
  /** Where the fill counts came from: live merge or journal replay. */
  source: 'live' | 'journal';
}

interface HistoryFile {
  version: 2;
  /** Keyed by UTC day string. */
  days: Record<string, DayRollup>;
}

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function emptyRow(day: string): DayRollup {
  return {
    day, realizedUsd: 0, feesUsd: 0, netUsd: 0, fills: 0, roundTrips: 0,
    avgWinUsd: 0, avgLossUsd: 0, winRate: 0, sells: 0, wins: 0, sumWins: 0, sumLosses: 0,
    profitFactor: null,
    equityEod: null, priceEod: null, equityBod: null,
    noData: true, source: 'journal',
  };
}

/** Aggregate a set of SOL-book trades (grid+dca only) into one day row. */
export function rollupDay(day: string, trades: Trade[]): DayRollup {
  const row = emptyRow(day);
  let wins = 0, losses = 0, sumWins = 0, sumLosses = 0, sells = 0;
  for (const t of trades) {
    // SOL book only: grid + dca. Meme/CYB fills are excluded here by design.
    if (t.strategyId !== 'grid' && t.strategyId !== 'dca') continue;
    if (utcDay(t.ts) !== day) continue;
    row.fills++;
    row.feesUsd += t.feeUsd || 0;
    if (t.direction === 'SELL') {
      sells++;
      const pnl = t.realizedPnlUsd ?? 0;
      row.realizedUsd += pnl;
      if (t.realizedPnlUsd !== undefined) row.roundTrips++;
      if (pnl > 0) { wins++; sumWins += pnl; }
      else if (pnl < 0) { losses++; sumLosses += pnl; }
    }
  }
  row.netUsd = row.realizedUsd - row.feesUsd;
  row.avgWinUsd = wins ? sumWins / wins : 0;
  row.avgLossUsd = losses ? sumLosses / losses : 0;
  row.sells = sells;
  row.wins = wins;
  row.sumWins = sumWins;
  row.sumLosses = sumLosses;
  row.winRate = sells ? wins / sells : 0;
  row.profitFactor = sumLosses < 0 ? sumWins / Math.abs(sumLosses) : (sumWins > 0 ? null : 0);
  row.noData = row.fills === 0;
  return row;
}

/**
 * Daily history store: reads/merges/writes .botstate/history-sol.json.
 *
 * `update()` merges today's live ledger; `rebuildFromJournal()` replays the
 * forever journal at startup so every day that ever had fills is recovered,
 * and annotates equity endpoints from the combined ring + archive.
 */
export class HistoryStore {
  private days: Record<string, DayRollup> = {};

  constructor(private mode: 'paper' | 'live') {
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(historyFile())) {
        const raw = JSON.parse(readFileSync(historyFile(), 'utf8')) as { version?: number; days?: Record<string, DayRollup> };
        if (raw && typeof raw.days === 'object') {
          this.days = raw.days;
        }
      }
    } catch {
      this.days = {}; // corrupt file -> start over; never crash trading
    }
  }

  private save(): void {
    try {
      mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
      const payload: HistoryFile = { version: 2, days: this.days };
      const file = historyFile();
      const tmp = file + '.tmp';
      writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, file); // atomic on POSIX
    } catch (e) {
      console.warn(`[history] write failed: ${(e as Error).message}`);
    }
  }

  /** Attach equity/price endpoints from any available sample source. */
  private applyEquityEndpoints(extra: EquitySample[]): void {
    const samples: EquitySample[] = [];
    // Prefer the persisted equity archive (long horizon); de-dupe by ts.
    try {
      samples.push(...readEquityArchive(this.mode));
    } catch { /* archive optional */ }
    samples.push(...extra);
    const byDay = new Map<string, EquitySample[]>();
    for (const s of samples) {
      const d = utcDay(s.ts);
      const arr = byDay.get(d) ?? [];
      arr.push(s);
      byDay.set(d, arr);
    }
    for (const [d, arr] of byDay) {
      const row = this.days[d];
      if (!row) continue;
      arr.sort((a, b) => a.ts - b.ts);
      const bod = arr[0]!.equityUsd;
      const eod = arr[arr.length - 1]!.equityUsd;
      // Only fill when we don't already have a better (live) reading.
      if (row.equityBod == null) row.equityBod = bod;
      if (row.equityEod == null) row.equityEod = eod;
    }
  }

  /**
   * Replay the forever journal and rebuild every day that has fills. This is
   * what recovers history older than the ledger cap and backfills days the
   * rollup missed while the bot was down. Returns the number of days touched.
   */
  rebuildFromJournal(equityExtra: { ts: number; equityUsd: number }[] = []): number {
    let journal: Trade[] = [];
    try {
      journal = readJournal(this.mode);
    } catch {
      return 0;
    }
    if (!journal.length) {
      this.applyEquityEndpoints(equityExtra);
      return 0;
    }
    const byDay = new Map<string, Trade[]>();
    for (const t of journal) {
      if (t.strategyId !== 'grid' && t.strategyId !== 'dca') continue;
      const d = utcDay(t.ts);
      const arr = byDay.get(d) ?? [];
      arr.push(t);
      byDay.set(d, arr);
    }
    let touched = 0;
    for (const [d, trades] of byDay) {
      const row = rollupDay(d, trades);
      row.source = 'journal';
      // Preserve any previously stored (live) equity endpoints only if the
      // rebuild has none — the trade stats are what must come from the tape.
      const prior = this.days[d];
      if (prior) {
        if (row.equityBod == null) row.equityBod = prior.equityBod;
        if (row.equityEod == null) row.equityEod = prior.equityEod;
        if (row.priceEod == null) row.priceEod = prior.priceEod;
      }
      this.days[d] = row;
      touched++;
    }
    this.applyEquityEndpoints(equityExtra);
    this.fillInteriorGaps();
    this.save();
    return touched;
  }

  /**
   * Materialize explicit `noData` rows for calendar days strictly between the
   * first and last journaled day that have no fills. Without this, an offline
   * stretch simply vanishes from the table and the operator can't tell it apart
   * from "we chose not to record". Equity endpoints remain null -> rendered "-".
   */
  private fillInteriorGaps(): void {
    const filled = Object.keys(this.days).sort();
    if (filled.length < 2) return;
    const start = Date.parse(filled[0]! + 'T00:00:00Z');
    const end = Date.parse(filled[filled.length - 1]! + 'T00:00:00Z');
    const MS = 86_400_000;
    for (let t = start + MS; t < end; t += MS) {
      const d = utcDay(t);
      if (!this.days[d]) this.days[d] = emptyRow(d);
    }
  }

  /**
   * Recompute today's row from the live ledger, merge equity endpoints from the
   * sampled curve, persist, and return every day sorted ascending.
   */
  update(
    trades: Trade[],
    equityHistory: { ts: number; equityUsd: number }[]
  ): DayRollup[] {
    const today = utcDay(Date.now());
    const row = rollupDay(today, trades);
    row.source = 'live';
    const samples = equityHistory.filter((p) => utcDay(p.ts) === today);
    if (samples.length) {
      row.equityBod = samples[0]!.equityUsd;
      row.equityEod = samples[samples.length - 1]!.equityUsd;
    }
    // Keep a previously-known body value; only overwrite when we have one.
    const prior = this.days[today];
    if (row.equityBod == null && prior?.equityBod != null) row.equityBod = prior.equityBod;
    if (row.priceEod == null && prior?.priceEod != null) row.priceEod = prior.priceEod;
    this.days[today] = row;
    this.applyEquityEndpoints(equityHistory);
    this.save();
    return this.rows();
  }

  /** All stored rows, ascending by day. */
  rows(): DayRollup[] {
    return Object.values(this.days).sort((a, b) => a.day.localeCompare(b.day));
  }
}
