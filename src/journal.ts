// ---------------------------------------------------------------------------
// TRADE JOURNAL + EQUITY ARCHIVE (append-only, kept forever)
//
// The live trade ledger in StateStore is capped (~5000 fills) and the equity
// ring is capped (~7 days), so anything older than that was being silently
// dropped — which made it impossible to analyse the strategy over months or to
// verify that the accounting reconciled. This module fixes that with two small
// append-only JSONL files that are never pruned:
//
//   .botstate/trades-<mode>.jsonl   one raw fill per line (the audit trail)
//   .botstate/equity-<mode>.jsonl   coarse equity samples (15-min cadence)
//
// A year of fills at the observed rate is a few hundred KB; the equity archive
// is ~35k samples/year (~1.5 MB). Both are trivially small, so they are kept
// indefinitely and become the source of truth for long-horizon analysis and
// for rebuilding the daily rollups (including days the bot was offline).
//
// Design rules:
//  - Measurement only. Nothing here feeds trading decisions.
//  - Appends are best-effort: a write failure must never crash the loop.
//  - Reads tolerate corrupt/partial lines (a crash mid-append cannot poison
//    the whole file) and dedupe by trade id so re-seeding is idempotent.
//  - reconcileCostBasis() is pure and unit-tested; it is the honest fix for
//    the aggregate cost basis, which previously drifted away from both the
//    trade tape and the on-chain balance.
// ---------------------------------------------------------------------------

import {
  appendFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Trade } from './types.js';

// Honor an explicit override (tests, alternate deployments) before the default.
// Resolved lazily so an env override (tests, alternate deployments) takes
// effect even when a test sets it after the import statement (ESM hoisting).
function stateDir(): string {
  return process.env.BOT_STATE_DIR || join(process.cwd(), '.botstate');
}

export function journalPath(mode: 'paper' | 'live'): string {
  return join(stateDir(), `trades-${mode}.jsonl`);
}

export function equityArchivePath(mode: 'paper' | 'live'): string {
  return join(stateDir(), `equity-${mode}.jsonl`);
}

export interface EquitySample {
  ts: number;
  equityUsd: number;
}

function ensureDir(): void {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
}

/** Append fills to the forever journal. Best-effort; never throws. */
export function appendJournal(mode: 'paper' | 'live', trades: Trade[]): void {
  if (!trades.length) return;
  try {
    ensureDir();
    const lines = trades.map((t) => JSON.stringify(t)).join('\n') + '\n';
    appendFileSync(journalPath(mode), lines, { encoding: 'utf8', mode: 0o600 });
  } catch (e) {
    console.warn(`[journal] append failed: ${(e as Error).message}`);
  }
}

/**
 * True for fills that never touched the wallet: the smoke-test script books
 * synthetic SELLs at a hardcoded price (orderId 'test-sell') directly into the
 * live store. When those reach the journal they inflate realized PnL and skew
 * every rollup, so analysis must exclude them.
 */
export function isSyntheticFill(t: Trade): boolean {
  return (t.orderId ?? '').startsWith('test');
}

/**
 * Read the entire journal, deduped by trade id. Corrupt lines are skipped so
 * one bad append can never hide the rest of the history. Synthetic test fills
 * are excluded by default so analytics reflect only real on-chain activity.
 */
export function readJournal(mode: 'paper' | 'live', opts: { includeSynthetic?: boolean } = {}): Trade[] {
  const file = journalPath(mode);
  if (!existsSync(file)) return [];
  const seen = new Set<string>();
  const out: Trade[] = [];
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const t = JSON.parse(trimmed) as Trade;
        if (!t || typeof t.ts !== 'number' || typeof t.baseQty !== 'number') continue;
        if (isSyntheticFill(t) && !opts.includeSynthetic) continue;
        if (t.id && seen.has(t.id)) continue;
        if (t.id) seen.add(t.id);
        out.push(t);
      } catch {
        /* partial/corrupt line — skip */
      }
    }
  } catch (e) {
    console.warn(`[journal] read failed: ${(e as Error).message}`);
  }
  return out;
}

/**
 * One-time idempotent seeding: copy any ledger fills that predate the journal
 * into it so history older than the 5000-fill cap is not lost on upgrade.
 * Returns how many rows were newly appended.
 */
export function seedJournalFromLedger(mode: 'paper' | 'live', trades: Trade[]): number {
  if (!trades.length) return 0;
  const existing = new Set(readJournal(mode, { includeSynthetic: true }).map((t) => t.id));
  const missing = trades.filter((t) => t.id && !existing.has(t.id));
  if (missing.length) {
    // Oldest first so the journal stays chronological for tape replay.
    missing.sort((a, b) => a.ts - b.ts);
    appendJournal(mode, missing);
  }
  return missing.length;
}

/** Append a coarse equity sample to the forever archive. Best-effort. */
export function appendEquityArchive(mode: 'paper' | 'live', sample: EquitySample): void {
  // Reject a non-positive equity sample: at boot the chain balances have not
  // synced yet, so a transient 0 would be archived as a fake net-worth crash and
  // could later be picked as the profit baseline (or show a crash on the chart).
  // A real account with 0 equity is indistinguishable from "not loaded yet", so
  // it is safer to skip than to persist a wrong sample.
  if (!(sample.equityUsd > 0) || !(sample.ts > 0)) return;
  try {
    ensureDir();
    appendFileSync(equityArchivePath(mode), JSON.stringify(sample) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch (e) {
    console.warn(`[equity-archive] append failed: ${(e as Error).message}`);
  }
}

/** Read the equity archive (ascending), tolerating corrupt lines. */
export function readEquityArchive(mode: 'paper' | 'live'): EquitySample[] {
  const file = equityArchivePath(mode);
  if (!existsSync(file)) return [];
  const out: EquitySample[] = [];
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const s = JSON.parse(trimmed) as EquitySample;
        if (s && typeof s.ts === 'number' && typeof s.equityUsd === 'number') out.push(s);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* unreadable -> empty */
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

export interface FillEntry {
  ts: number;
  direction: 'BUY' | 'SELL';
  baseQty: number;
  quoteQty: number;
}

export interface CostBasisResult {
  /** SOL attributable to recorded trades (buys minus sells). */
  trackedQty: number;
  /** SOL on-chain that no trade explains (deposits/manual transfers). */
  untrackedQty: number;
  /** Remaining trade-attributable cost basis (USD). */
  trackedCostUsd: number;
  /** Untracked SOL valued at the given spot price (USD). */
  untrackedCostUsd: number;
  /** Honest average cost per base for the whole holding (USD/SOL). */
  avgCostPerBase: number;
  /** Realized PnL implied by the tape (proceeds − basis sold). */
  realizedPnlUsd: number;
}

/**
 * Weighted-average cost basis from a chronological fill tape, reconciled
 * against the real on-chain base quantity.
 *
 * Why this exists: the store's aggregate avgCostPerBase only moved on
 * tracked fills and defaulted to spot when empty, while SELL basis removal
 * used a proportional shrink of quoteQty — over months those diverged from
 * both the tape and the chain (the persisted basis read $109.56 while the
 * tape implied ~$105). The honest basis for a holding is
 * (trade-attributable remaining cost + untracked SOL at market) / total SOL,
 * which this computes exactly. Pure function — no I/O.
 */
export function reconcileCostBasis(
  entries: FillEntry[],
  chainQty: number,
  spotPrice: number
): CostBasisResult {
  const sorted = [...entries].sort((a, b) => a.ts - b.ts);
  let qty = 0;
  let cost = 0;
  let realized = 0;
  for (const e of sorted) {
    if (!(e.baseQty > 0)) continue;
    if (e.direction === 'BUY') {
      qty += e.baseQty;
      cost += e.quoteQty;
    } else {
      const sellQty = Math.min(e.baseQty, qty);
      if (sellQty <= 0) continue;
      const basisSold = qty > 0 ? (cost / qty) * sellQty : 0;
      realized += (e.quoteQty * (sellQty / e.baseQty)) - basisSold;
      cost -= basisSold;
      qty -= sellQty;
    }
  }
  const trackedQty = Math.max(0, qty);
  const trackedCostUsd = Math.max(0, cost);
  const untrackedQty = Math.max(0, chainQty - trackedQty);
  const untrackedCostUsd = untrackedQty * (spotPrice > 0 ? spotPrice : 0);
  const totalQty = trackedQty + untrackedQty;
  const avgCostPerBase =
    totalQty > 0 ? (trackedCostUsd + untrackedCostUsd) / totalQty : 0;
  return {
    trackedQty,
    untrackedQty,
    trackedCostUsd,
    untrackedCostUsd,
    avgCostPerBase,
    realizedPnlUsd: realized,
  };
}

/** Distribute an untracked base quantity across strategy books pro-rata. */
export function distributeUntracked(
  weights: Record<string, number>,
  untrackedQty: number
): Record<string, number> {
  const total = Object.values(weights).reduce((s, v) => s + v, 0);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(weights)) {
    out[k] = total > 0 ? (v / total) * untrackedQty : 0;
  }
  return out;
}

/** Atomic rewrite used by the audit snapshot exporter (tmp + rename). */
export function writeJsonAtomic(file: string, payload: unknown): void {
  try {
    ensureDir();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    console.warn(`[journal] atomic write failed: ${(e as Error).message}`);
  }
}
