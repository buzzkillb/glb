import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * ISOLATED PERPS LEDGER.
 *
 * The perps sleeve must never be able to corrupt or drain the spot grid/DCA
 * book, so it gets its own file, its own accounting, and its own risk budget —
 * completely separate from `state-<mode>.json`. This is the structural
 * guarantee behind "amplify profits without risking base capital".
 *
 * ACCOUNTING MODEL (answers "what if profits go negative?"):
 *   - `principalFloorUsd` is the amount of equity treated as UNTOUCHABLE
 *     principal. The sleeve can only ever deploy equity ABOVE this floor.
 *   - A drawdown lowers equity, which automatically shrinks eligible profit and
 *     therefore the budget. At/below the floor the budget is exactly 0 — the
 *     sleeve stops deploying and simply waits. Nothing to unwind, nothing to
 *     top up, principal never touched.
 *   - `outstandingMarginUsd` subtracts margin already at work so the same
 *     profit cannot be double-deployed while a position is open.
 *
 * Persistence is owner-only (0600) like the main state file.
 */

const DEFAULT_STATE_DIR = '.botstate';

function stateDir(): string {
  // PERP_STATE_DIR is the explicit perps override; BOT_STATE_DIR keeps the
  // perps ledger alongside the spot book in one configurable root.
  return process.env.PERP_STATE_DIR || process.env.BOT_STATE_DIR || DEFAULT_STATE_DIR;
}

export interface PerpPosition {
  side: 'long' | 'short';
  collateralUsd: number;
  leverage: number;
  entryPriceUsd: number;
  liquidationPriceUsd: number;
  openedAt: number;
  /** Position account returned by the venue build response. */
  positionPubkey?: string;
  /** 'hedge' | 'overlay' — why the sleeve is on. */
  intent: 'hedge' | 'overlay';
}

export interface PerpHistoryEntry {
  ts: number;
  kind: 'open' | 'close' | 'halt' | 'reject';
  side?: 'long' | 'short';
  collateralUsd?: number;
  notionalUsd?: number;
  pnlUsd?: number;
  price?: number;
  note: string;
}

export interface PerpLedger {
  version: 1;
  /** Equity treated as untouchable principal. Deployable profit lives ABOVE this. */
  principalFloorUsd: number;
  /** Highest equity ever observed (observability only; never blocks deployment). */
  peakEquityUsd: number;
  /** Margin currently committed to an open position (prevents double-deploy). */
  outstandingMarginUsd: number;
  /** Cumulative realized PnL of the perps sleeve itself (can go negative). */
  realizedPnlUsd: number;
  /** Cumulative borrowing + open/close fees paid by the sleeve. */
  feesPaidUsd: number;
  position: PerpPosition | null;
  /** Set when the sleeve stops deploying (loss ceiling / safety breach). */
  halted: boolean;
  haltReason: string;
  lastActionAt: number;
  /**
   * Hedgeable spot exposure (USD) at the moment the last position CLOSED. After
   * a winning hedge banks and the re-arm cooldown starts, a dip can fill fresh
   * grid/DCA buys that the just-closed hedge no longer covers. Comparing the
   * current exposure against this value lets the sleeve re-arm IMMEDIATELY when
   * genuinely new unhedged inventory appears — closing the post-close gap —
   * while still blocking fee-churn re-entry at the SAME mark (no new exposure).
   */
  lastCloseExposureUsd: number;
  history: PerpHistoryEntry[];
  /**
   * Rolling samples of the OPEN position's live PnL while it is held, so the
   * dashboard can plot how the hedge is actually doing over time instead of a
   * single snapshot. Bounded; cleared when the position closes (a new trade
   * starts a fresh series so old and new PnL are never conflated).
   */
  pnlSeries: PerpPnlSample[];
}

/** One timed observation of an open position's mark PnL. */
export interface PerpPnlSample {
  ts: number;
  /** Net PnL (USD) incl. carry — exactly what the stop/take-profit judge. */
  netPnlUsd: number;
  /** Mark price at the sample, for context. */
  priceUsd: number;
}

const EMPTY: PerpLedger = {
  version: 1,
  principalFloorUsd: 0,
  peakEquityUsd: 0,
  outstandingMarginUsd: 0,
  realizedPnlUsd: 0,
  feesPaidUsd: 0,
  position: null,
  halted: false,
  lastCloseExposureUsd: 0,
  haltReason: '',
  lastActionAt: 0,
  history: [],
  pnlSeries: [],
};

export class PerpStore {
  private ledger: PerpLedger;
  private file: string;

  constructor(private mode: 'paper' | 'live') {
    this.file = path.join(stateDir(), `perps-${mode}.json`);
    this.ledger = this.load();
  }

  private load(): PerpLedger {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PerpLedger>;
        if (raw && raw.version === 1) {
          return { ...EMPTY, ...raw, history: raw.history ?? [] };
        }
      }
    } catch (e) {
      console.warn(`[perps] ledger load failed: ${(e as Error).message}`);
    }
    return { ...EMPTY, history: [] };
  }

  snapshotLedger(): PerpLedger {
    return this.ledger;
  }

  save(): void {
    try {
      mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
      // ATOMIC: write a sibling temp file then rename over the target. rename is
      // atomic on POSIX, so a crash mid-write can never truncate/corrupt the
      // ledger (which would reset the floor and the loss-ceiling memory).
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.ledger), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (e) {
      console.warn(`[perps] ledger write failed: ${(e as Error).message}`);
    }
  }

  /**
   * Seed the principal floor exactly once. If a configured baseline is given it
   * wins; otherwise the first observed equity becomes the floor (so a fresh bot
   * must first EARN profit before the sleeve may deploy anything).
   */
  seedFloor(equityUsd: number, configuredBaselineUsd: number): void {
    if (this.ledger.principalFloorUsd > 0) return;
    const floor = configuredBaselineUsd > 0 ? configuredBaselineUsd : Math.max(0, equityUsd);
    this.ledger.principalFloorUsd = floor;
    this.save();
  }

  /** Observability: track the all-time peak equity. Never affects the floor. */
  observePeakEquity(equityUsd: number): void {
    if (equityUsd > this.ledger.peakEquityUsd) {
      this.ledger.peakEquityUsd = equityUsd;
      this.save();
    }
  }

  /** Lock newly-banked profit into the floor (raise it). Never lowers it. */
  raiseFloor(toUsd: number): void {
    if (toUsd > this.ledger.principalFloorUsd) {
      this.ledger.principalFloorUsd = toUsd;
      this.save();
    }
  }

  setOutstanding(marginUsd: number): void {
    this.ledger.outstandingMarginUsd = Math.max(0, marginUsd);
    this.save();
  }

  record(entry: PerpHistoryEntry): void {
    this.ledger.history.push(entry);
    // Keep the tail bounded; the ledger is a safety record, not a forensic log.
    if (this.ledger.history.length > 500) {
      this.ledger.history.splice(0, this.ledger.history.length - 500);
    }
    this.ledger.lastActionAt = entry.ts;
    this.save();
  }

  setPosition(p: PerpPosition | null): void {
    this.ledger.position = p;
    // A closed position starts a fresh PnL series on the next open, so the
    // sparkline never splices two different trades into one misleading line.
    if (!p) this.ledger.pnlSeries = [];
    this.setOutstanding(p ? p.collateralUsd : 0);
  }

  /**
   * Record the hedgeable spot exposure that existed when the last position
   * closed. A later tick compares live exposure against this to decide whether
   * genuinely NEW unhedged inventory justifies re-arming inside the cooldown.
   */
  setLastCloseExposure(exposureUsd: number): void {
    this.ledger.lastCloseExposureUsd = Math.max(0, exposureUsd);
    this.save();
  }

  /**
   * Append a timed PnL observation for the open position. Bounded ring so the
   * ledger stays a safety record, not an unbounded log; the dashboard reads the
   * tail for the sparkline.
   */
  samplePnl(entry: PerpPnlSample): void {
    this.ledger.pnlSeries.push(entry);
    const cap = 720; // ~6h at a 30s tick, enough for a readable curve
    if (this.ledger.pnlSeries.length > cap) {
      this.ledger.pnlSeries.splice(0, this.ledger.pnlSeries.length - cap);
    }
    this.save();
  }

  setHalt(reason: string): void {
    this.ledger.halted = true;
    this.ledger.haltReason = reason;
    this.save();
  }

  rollRealized(pnlUsd: number, feeUsd: number): void {
    // `realizedPnlUsd` is the sleeve's net trading result (used by the loss
    // ceiling); `feesPaidUsd` is the cost line. Keep them disjoint so carry is
    // never counted in both — callers pass net PnL here and fee/carry once.
    this.ledger.realizedPnlUsd += pnlUsd;
    this.ledger.feesPaidUsd += feeUsd;
    this.save();
  }
}
