import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  history: PerpHistoryEntry[];
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
  haltReason: '',
  lastActionAt: 0,
  history: [],
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
      writeFileSync(this.file, JSON.stringify(this.ledger), { encoding: 'utf8', mode: 0o600 });
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
    this.setOutstanding(p ? p.collateralUsd : 0);
  }

  setHalt(reason: string): void {
    this.ledger.halted = true;
    this.ledger.haltReason = reason;
    this.save();
  }

  clearHalt(): void {
    this.ledger.halted = false;
    this.ledger.haltReason = '';
    this.save();
  }

  rollRealized(pnlUsd: number, feeUsd: number): void {
    this.ledger.realizedPnlUsd += pnlUsd;
    this.ledger.feesPaidUsd += feeUsd;
    this.save();
  }
}
