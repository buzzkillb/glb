import { EventEmitter } from 'node:events';
import type { AppConfig } from './config.js';
import type { Candle } from './types.js';
import { JupiterExec } from './jupiter.js';

export interface PriceGateInput {
  p: number;             // candidate price from the source
  prev: number;          // last committed price (0 if none yet)
  maxSingleJumpPct: number;
  historyHigh?: number;  // max(existing history.high)
  historyLow?: number;   // min(existing history.low)
}

/**
 * Decide whether a freshly-fetched price is sane enough to commit to the
 * stream. Guards against a single bad/glitched quote (e.g.the ~$5.97 print on
 * a ~$107 SOL) that would otherwise trigger real grid crossed-fills + a DCA
 * trailing sell at a fabricated price.
 *
 * Returns true when the price should be ACCEPTED.
 */
export function pricePassesGate({
  p, prev, maxSingleJumpPct, historyHigh, historyLow,
}: PriceGateInput): boolean {
  if (!(p > 0)) return false;
  if (prev > 0 && Math.abs(p - prev) / prev > maxSingleJumpPct) return false;
  if (historyHigh !== undefined && historyLow !== undefined && historyLow > 0 && historyHigh > 0) {
    const cushion = (historyHigh - historyLow) * 0.5;
    if (p < historyLow - cushion || p > historyHigh + cushion) return false;
  }
  return true;
}

/** Why a candidate print was not committed verbatim. */
export type GateReason = 'ok' | 'non-positive' | 'single-jump' | 'outside-range';

/**
 * Classify (not just accept/reject) a candidate print so the caller can decide
 * how hard to distrust it. Rejecting a single anomalous print outright — the old
 * behaviour — froze the feed on a *genuine* sharp move: the venue kept returning
 * the real new price and the oracle kept throwing it away as a "glitch". This
 * classifier lets a repeated / corroborated print through while still dropping a
 * one-off flash.
 */
export function classifyPrice({
  p, prev, maxSingleJumpPct, historyHigh, historyLow,
}: PriceGateInput): GateReason {
  if (!(p > 0)) return 'non-positive';
  if (prev > 0 && Math.abs(p - prev) / prev > maxSingleJumpPct) return 'single-jump';
  if (historyHigh !== undefined && historyLow !== undefined && historyLow > 0 && historyHigh > 0) {
    const cushion = (historyHigh - historyLow) * 0.5;
    if (p < historyLow - cushion || p > historyHigh + cushion) return 'outside-range';
  }
  return 'ok';
}

/**
 * Cross-source agreement check: given several INDEPENDENT quotes of the same
 * asset, return the median of the ones that mutually agree within `tol`. A
 * single outlier (a bad print, a stale cached page, a thin pool) is excluded as
 * long as at least two sources corroborate each other. This is how we make
 * pulling in external data *smart*: we never commit a lone number when multiple
 * sources disagree, and we never trust one source's glitch.
 *
 * Returns null when fewer than the required number of sources agree.
 */
export function corroboratedMedian(
  prints: { source: string; price: number }[],
  tol = 0.01,
  minAgree = 2
): { price: number; sources: string[]; rejected: { source: string; price: number }[] } | null {
  const good = prints.filter((x) => Number.isFinite(x.price) && x.price > 0);
  if (good.length === 0) return null;
  // Find the largest cluster of mutually-agreeing prints.
  let best: { source: string; price: number }[] = [];
  for (const seed of good) {
    const cluster = good.filter((x) => Math.abs(x.price - seed.price) / seed.price <= tol);
    if (cluster.length > best.length) best = cluster;
  }
  if (best.length < minAgree) return null;
  const sorted = best.slice().sort((a, b) => a.price - b.price);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid].price : (sorted[mid - 1].price + sorted[mid].price) / 2;
  const inCluster = new Set(best.map((x) => x.source));
  return {
    price: median,
    sources: best.map((x) => x.source),
    rejected: good.filter((x) => !inCluster.has(x.source)),
  };
}

/**
 * Price oracle for SOL/USDC.
 *
 * PRIMARY source: Jupiter on-chain quote (same venue the bot executes swaps
 * on). This means the displayed price, the DCA/grid trigger signals, and the
 * actual expected fill price all come from the same on-chain route — no
 * divergence between what we see and what we trade.
 *
 * FALLBACK: CoinGecko USD price if the Jupiter fetch fails (keeps VWAP/price
 * flowing during a transient quote API blip, with a clear log.)
 *
 * HISTORY: seeded from GeckoTerminal's on-chain DEX OHLCV (SOL/USDC pool), so
 * the grid band sizes itself from REAL recent price action (live DEX candles,
 * never static numbers) and keeps refreshing through the day.
 */
export class PriceOracle extends EventEmitter {
  private price = 0;
  private candles: Candle[] = []; // live, minute-grain (from quote polling)
  private history: Candle[] = []; // on-chain DEX candles (GeckoTerminal OHLCV)
  private intraday: Candle[] = []; // hourly-only series, used for VWAP (see get vwap)
  private timer?: ReturnType<typeof setInterval>;
  private historyTimer?: ReturnType<typeof setInterval>;
  private jup: JupiterExec;
  /** True when the last poll actually produced a fresh price (not a retained/stale one). */
  private fresh = false;
  /** True when the last poll's PRIMARY source — Jupiter, the real execution
   *  venue — succeeded. A working CoinGecko fallback can keep `fresh` true even
   *  while Jupiter is down; the live circuit-breaker uses THIS so it trips when
   *  the venue we actually trade on goes stale, even if a fallback price exists. */
  private _jupiterFresh = false;
  // Fixed notional quote (in SOL) used to compute the near-mid on-chain price.
  // Small enough to keep price impact negligible, large enough to be a real route.
  private readonly oracleAmountSol = 1;

  // ---- Primary-source backoff --------------------------------------------------
  // Jupiter is the venue we execute on, so it stays primary — but hammering it
  // every poll while it is intermittently 400-ing/rate-limiting adds noise and
  // keeps the circuit-breaker tripping on our own request pressure. On repeated
  // failures we OPEN A COOLDOWN and stop calling it for a while, then probe once
  // to see if it recovered. Success resets the streak immediately.
  private jupFailStreak = 0;
  private jupBackoffUntil = 0;

  // ---- Confirmation buffer for anomalous prints --------------------------------
  // A print that fails the single-jump gate is held here. If the SAME value
  // (within tolerance) is seen on the next poll too, it is a real move being
  // rejected by our guard, not a one-off flash — so we accept it. Anything that
  // appears once and vanishes is dropped.
  private pendingAnomaly: { price: number; seenAt: number; count: number } | null = null;

  constructor(private cfg: AppConfig) {
    super();
    this.jup = new JupiterExec(cfg);
  }

  get current(): number {
    return this.price;
  }

  /** True if the most recent fetch refreshed the price successfully. */
  get currentGeneratingFresh(): boolean {
    return this.fresh;
  }

  /** True if the most recent poll refreshed the PRIMARY execution venue (Jupiter). */
  get jupiterFresh(): boolean {
    return this._jupiterFresh;
  }

  /**
   * TEST ONLY: force a deterministic price without hitting a network (used by
   * unit tests to drive fill logic). Not part of the runtime path.
   */
  __setPrice(p: number, jupiterFresh: boolean = true): void {
    this.price = p;
    this.fresh = true;
    this._jupiterFresh = jupiterFresh;
    this.pushCandle(p);
  }

  /**
   * The price ~24 hours ago: the OPEN of the oldest candle still inside the
   * 24h window. Returns 0 when the bot hasn't been running long enough to
   * have 24h of samples (dashboard then shows '—' rather than a lie).
   */
  price24hAgo(): number {
    const cutoff = Date.now() - 24 * 60 * 60_000;
    const src = this.history.length ? this.history : this.candles;
    if (src.length === 0) return 0;
    // Only honest as a "24h ago" read when the series actually starts at or
    // before the 24h edge; the 30min slack tolerates the last refresh landing
    // slightly inside the window.
    if (src[0].ts > cutoff + 30 * 60_000) return 0;
    const inWindow = src.find((c) => c.ts >= cutoff);
    if (!inWindow) return 0;
    return inWindow.open > 0 ? inWindow.open : inWindow.close;
  }

  /**
   * Highest price seen over the last `minutes` of on-chain DEX history.
   *
   * Returns 0 ("unknown") when neither the on-chain history nor the live
   * polled candles cover the window. We deliberately do NOT invent a cushion
   * around spot: a fabricated "24h high" would render on the dashboard as if
   * it were a real observed extreme. Callers treat 0 as "no reading" — the
   * grid band falls back to a price-derived pad and the dashboard shows '—'.
   */
  recentHigh(minutes = 1440): number {
    const from = Date.now() - minutes * 60_000;
    const recent = this.history.filter((c) => c.ts >= from);
    if (recent.length > 0) return Math.max(...recent.map((c) => c.high));
    const live = this.candles.slice(-Math.max(2, Math.ceil(minutes / 5)));
    if (live.length > 0) return Math.max(...live.map((c) => c.high));
    return 0;
  }

  /** Lowest price seen over the last `minutes` of on-chain DEX history (0 = unknown). */
  recentLow(minutes = 1440): number {
    const from = Date.now() - minutes * 60_000;
    const recent = this.history.filter((c) => c.ts >= from);
    if (recent.length > 0) return Math.min(...recent.map((c) => c.low));
    const live = this.candles.slice(-Math.max(2, Math.ceil(minutes / 5)));
    if (live.length > 0) return Math.min(...live.map((c) => c.low));
    return 0;
  }

  /**
   * Rolling VWAP over recent closes. PREFERS the real on-chain GeckoTerminal
   * candles, which carry genuine volumeUsd from the pool (OHLCV row index 5).
   * Only if history is empty (no synthetic volume is ever invented) we fall
   * back to the unweighted mean of live polled closes so VWAP still has a
   * directional baseline without fabricating a number.
   */
  get vwap(): number {
    // Volume-weighted over the INTRADAY (hourly) tape only, bounded to the grid's
    // real history window. Using the mixed daily+hourly series here would weight
    // in 24h-volume bars from weeks ago and drag VWAP well below spot — which
    // would skew grid levels and falsely trigger DCA dip buys.
    const hours = Math.max(1, this.cfg.strategies.grid.historyHours ?? 48);
    const from = Date.now() - hours * 3_600_000;
    const intraday = this.intraday.filter((c) => c.ts >= from);
    if (intraday.length > 0) {
      const vol = intraday.reduce((s, c) => s + c.volumeUsd, 0);
      if (vol > 0) {
        const sum = intraday.reduce((s, c) => s + c.volumeUsd * c.close, 0);
        return sum / vol;
      }
    }
    // Fallback: bounded slice of the mixed series (still time-filtered so old
    // daily bars cannot dominate).
    const bounded = this.history.filter((c) => c.ts >= from);
    if (bounded.length > 0) {
      const vol = bounded.reduce((s, c) => s + c.volumeUsd, 0);
      if (vol > 0) {
        const sum = bounded.reduce((s, c) => s + c.volumeUsd * c.close, 0);
        return sum / vol;
      }
    }
    if (this.candles.length === 0) return this.price;
    const n = Math.min(this.candles.length, 60);
    const recent = this.candles.slice(-n);
    return recent.reduce((s, c) => s + c.close, 0) / recent.length;
  }

  /**
   * Directional move over the last `candlesN` candles, as a fraction
   * (e.g. 0.05 = +5%). Used by the trend/regime filter to avoid arming
   * against strong momentum.
   */
  recentTrend(candlesN = 12): number {
    const n = Math.min(candlesN, this.candles.length);
    if (n < 2) return 0;
    const win = this.candles.slice(-n);
    const first = win[0].open;
    const last = win[win.length - 1].close;
    if (first <= 0) return 0;
    return (last - first) / first;
  }

  /**
   * VWAP slope: directional move of VWAP over the recent history, as a fraction
   * (e.g. -0.03 = VWAP drifting down 3% over the window). This is the regime
   * signal the grid uses to avoid arming asks into a sliding range (Feature 6).
   */
  vwapSlope(candlesN = 12): number {
    const src = this.history.length ? this.history : this.candles;
    const n = Math.min(candlesN, src.length);
    if (n < 2) return 0;
    const win = src.slice(-n);
    const first = win[0].close;
    const last = win[win.length - 1].close;
    if (first <= 0) return 0;
    return (last - first) / first;
  }

  /**
   * Recent realized volatility as a fraction of price (coefficient of
   * variation of closes over the last `candlesN` candles). Drives the
   * volatility-adaptive band: wider when choppy, tighter when calm.
   */
  recentVolatility(candlesN = 12): number {
    const n = Math.min(candlesN, this.candles.length);
    if (n < 2) return 0;
    const closes = this.candles.slice(-n).map((c) => c.close);
    const mean = closes.reduce((s, c) => s + c, 0) / closes.length;
    if (mean <= 0) return 0;
    const variance = closes.reduce((s, c) => s + (c - mean) ** 2, 0) / closes.length;
    return Math.sqrt(variance) / mean;
  }

  start(): void {
    void this.fetchNow();
    void this.refreshHistory();
    this.timer = setInterval(() => void this.fetchNow(), this.cfg.pollIntervalMs);
    this.timer.unref?.();
    // Refresh on-chain history every 30 min so the band tracks the day's action.
    this.historyTimer = setInterval(() => void this.refreshHistory(), 30 * 60_000);
    this.historyTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.historyTimer) clearInterval(this.historyTimer);
  }

  /**
   * Seed the historical band from GeckoTerminal's on-chain SOL/USDC DEX OHLCV.
   * Free + keyless; returns real daily candles. Uses a large known SOL/USDC
   * pool by default (overridable via GEOKT_POOL).
   */
  async refreshHistory(): Promise<void> {
    const pool = process.env.GEOKT_POOL || '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
    try {
      // Daily candles for the longer-term range, 24h-hourly for finer recent
      // detail. Merge, sort ascending, dedupe by bucket.
      const day = await this.fetchOhlcv(pool, 'day', 1, 30);
      const hour = await this.fetchOhlcv(pool, 'hour', 1, 48);
      const merged = new Map<number, Candle>();
      for (const c of [...day, ...hour]) merged.set(c.ts, c);
      const arr = [...merged.values()].sort((a, b) => a.ts - b.ts);
      // Keep the HOURLY series separately. The long-range series intentionally
      // mixes daily + hourly buckets for band/high/low, but a volume-weighted
      // average over "the last N rows" of a mixed-resolution series is wrong:
      // daily bars carry 24h of volume and reach back weeks, so they drag the
      // VWAP far below spot. VWAP must come from the intraday series only.
      this.intraday = hour.slice().sort((a, b) => a.ts - b.ts);
      if (arr.length > 0) {
        this.history = arr;
        this.emit('history', arr.length);
      }
    } catch (e) {
      this.emit('warn', `[price] geckoterminal history failed (${(e as Error).message})`);
    }
  }

  private async fetchOhlcv(pool: string, timeframe: 'day' | 'hour', aggregate: number, limit: number): Promise<Candle[]> {
    const url =
      `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/${timeframe}` +
      `?aggregate=${aggregate}&limit=${limit}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    // GeckoTerminal OHLCV is keyless (verified live: real hourly/daily candles,
    // HTTP 200, no key). A non-OK response is surfaced as an error and the
    // caller falls back gracefully — candles are never fabricated.
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers });
    if (!res.ok) throw new Error(`geckoterminal HTTP ${res.status}`);
    const json = (await res.json()) as {
      data?: { attributes?: { ohlcv_list?: number[][] } };
    };
    const list = json?.data?.attributes?.ohlcv_list ?? [];
    // OHLCV row: [ts, open, high, low, close, volume]
    return list.map((r) => ({
      ts: r[0] * 1000,
      open: r[1],
      high: r[2],
      low: r[3],
      close: r[4],
      volumeUsd: r[5] ?? 0,
    }));
  }

  /**
   * Fetch and update the current on-chain price. Returns the latest price.
   * Order of preference:
   *   1. Jupiter on-chain SOL->USDC quote  (primary, matches execution venue)
   *   2. CoinGecko USD                    (fallback)
   */
  async fetchNow(): Promise<number> {
    const g = this.cfg.strategies.grid;
    const prev = this.price;
    let p = 0;
    let source = 'jupiter';
    const prints: { source: string; price: number }[] = [];

    // PRIMARY: Jupiter on-chain quote (the venue we execute on). Backed off
    // rather than hammered: once it fails repeatedly we stop calling it every
    // poll and probe only after a cooldown, so our own request pressure can't
    // keep the venue API 400-ing or the circuit-breaker tripping.
    const backoffActive = Date.now() < this.jupBackoffUntil;
    if (!backoffActive) {
      try {
        const q = await this.jup.quote(g.baseMint, g.quoteMint, this.oracleAmountSol, 'BUY');
        if (q.inAmount > 0 && q.outAmount > 0) {
          const jupP = q.outAmount / q.inAmount;
          prints.push({ source: 'jupiter', price: jupP });
          this._jupiterFresh = true;
          this.jupFailStreak = 0;
          this.jupBackoffUntil = 0;
        }
      } catch (e) {
        this._jupiterFresh = false;
        this.jupFailStreak++;
        // Exponential cooldown, capped at 2 min: 2 fails -> 10s, then 20s, 40s …
        const cooldown = Math.min(120_000, 10_000 * 2 ** Math.max(0, this.jupFailStreak - 2));
        this.jupBackoffUntil = Date.now() + cooldown;
        this.emit(
          'warn',
          `[price] jupiter quote failed (${(e as Error).message}); backing off ${Math.round(cooldown / 1000)}s ` +
            `(fail streak ${this.jupFailStreak}); using corroborated fallbacks`
        );
      }
    } else if (this._jupiterFresh === false) {
      // still inside cooldown — keep the venue marked not-fresh without retrying
      this._jupiterFresh = false;
    }

    // FALLBACKS: independent keyless sources. We deliberately query MORE THAN ONE
    // so a lone bad print can be discarded by cross-source agreement rather than
    // trusted blindly. None of these is the execution venue, so a fallback price
    // never counts as jupiterFresh.
    if (prints.length === 0 || !this._jupiterFresh) {
      const fb = await this.fetchFallbacks();
      prints.push(...fb);
    }

    // SMART BAD-DATA HANDLING ---------------------------------------------------
    // If a non-primary source disagrees wildly with the primary, drop it. If we
    // only have non-primary sources, require at least two to corroborate each
    // other (median) — a single unverified number is never committed.
    let chosen = 0;
    let chosenSource = source;
    let corroborated = false;
    if (prints.length >= 1) {
      const primaryPrint = prints.find((x) => x.source === 'jupiter');
      if (primaryPrint) {
        // Primary exists: keep only prints that agree with it, then take their
        // median (or just the primary when nothing else corroborates).
        const agree = prints.filter((x) => Math.abs(x.price - primaryPrint.price) / primaryPrint.price <= 0.02);
        const cm = corroboratedMedian(agree, 0.01, 1);
        chosen = cm ? cm.price : primaryPrint.price;
        chosenSource = primaryPrint.source;
        corroborated = agree.length > 1;
      } else {
        const cm = corroboratedMedian(prints, 0.01, 2);
        if (cm) {
          chosen = cm.price;
          chosenSource = cm.sources.join('+');
          corroborated = true;
          if (cm.rejected.length) {
            this.emit('warn', `[price] discarded outlier ${cm.rejected.map((r) => r.source + '@' + r.price.toFixed(2)).join(', ')}`);
          }
        }
      }
    }

    if (!(chosen > 0)) {
      this.fresh = false;
      this.emit('warn', `[price] no source produced a usable price (last known: ${this.price}); using retained price.`);
      return this.price;
    }
    p = chosen;
    source = chosenSource;

    // ----- GATE: classify rather than flat-reject ---------------------------------
    let hi: number | undefined;
    let lo: number | undefined;
    if (this.history.length > 0) {
      hi = Math.max(...this.history.map((c) => c.high));
      lo = Math.min(...this.history.map((c) => c.low));
    }
    const verdict = classifyPrice({
      p, prev, maxSingleJumpPct: this.cfg.risk.maxSingleJumpPct,
      historyHigh: hi, historyLow: lo,
    });

    if (verdict !== 'ok') {
      // Corroboration overrides a lone anomaly: if two independent sources agree
      // on this value, it is a real move, not a flash — commit it.
      if (corroborated) {
        this.pendingAnomaly = null;
        this.commit(p, source, prev);
        return this.price;
      }
      // Otherwise hold it. If the SAME anomalous value recurs on the next poll,
      // our guard is rejecting a genuine move — accept the second sighting.
      const a = this.pendingAnomaly;
      const sameAgain = a && Math.abs(p - a.price) / a.price <= 0.005;
      if (sameAgain) {
        this.pendingAnomaly = null;
        console.warn(`[price] ${verdict} print ${p.toFixed(2)} from ${source} recurred — treating as a genuine move.`);
        this.commit(p, source, prev);
        return this.price;
      }
      this.pendingAnomaly = { price: p, seenAt: Date.now(), count: 1 };
      this.fresh = false;
      this.emit(
        'warn',
        `[price] held suspicious ${source} print ${p.toFixed(2)} (${verdict}; ` +
          `last ${prev > 0 ? prev.toFixed(2) : 'n/a'}); awaiting confirmation`
      );
      return this.price;
    }

    // Clean print.
    this.pendingAnomaly = null;
    this.commit(p, source, prev);
    return this.price;
  }

  /** Commit an accepted price to the stream. */
  private commit(p: number, source: string, prev: number): void {
    this.price = p;
    this.fresh = true;
    this.pushCandle(p);
    if (prev !== p) this.emit('price', p, source);
  }

  /**
   * Query independent keyless fallback sources and return their prints. We ask
   * several so cross-source agreement can vouch for a value when the primary
   * execution venue is unavailable; a single-source answer is flagged by the
   * caller as uncorroborated and is never preferred over the venue.
   */
  private async fetchFallbacks(): Promise<{ source: string; price: number }[]> {
    const out: { source: string; price: number }[] = [];
    const tasks: Promise<void>[] = [];

    // CoinGecko (USD).
    tasks.push(
      (async () => {
        try {
          const res = await fetch(
            'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
            { signal: AbortSignal.timeout(8000) }
          );
          if (!res.ok) return;
          const json = (await res.json()) as { solana?: { usd?: number } };
          const v = json?.solana?.usd ?? 0;
          if (v > 0) out.push({ source: 'coingecko', price: v });
        } catch { /* keep trying others */ }
      })()
    );

    // Binance public ticker (USDT ≈ USD, no key).
    tasks.push(
      (async () => {
        try {
          const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', {
            signal: AbortSignal.timeout(8000),
          });
          if (!res.ok) return;
          const json = (await res.json()) as { price?: string };
          const v = Number(json?.price ?? 0);
          if (v > 0) out.push({ source: 'binance', price: v });
        } catch { /* keep trying others */ }
      })()
    );

    // Coinbase spot (no key).
    tasks.push(
      (async () => {
        try {
          const res = await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot', {
            signal: AbortSignal.timeout(8000),
          });
          if (!res.ok) return;
          const json = (await res.json()) as { data?: { amount?: string } };
          const v = Number(json?.data?.amount ?? 0);
          if (v > 0) out.push({ source: 'coinbase', price: v });
        } catch { /* keep trying others */ }
      })()
    );

    await Promise.all(tasks);
    return out;
  }

  private pushCandle(p: number): void {
    const minute = Math.floor(Date.now() / 60000);
    const last = this.candles[this.candles.length - 1];
    // Live polled candles carry NO synthetic volume — real volume lives in the
    // on-chain GeckoTerminal history (used for VWAP). volumeUsd stays 0 here.
    if (last && Math.floor(last.ts / 60000) === minute) {
      last.close = p;
      last.high = Math.max(last.high, p);
      last.low = Math.min(last.low, p);
    } else {
      this.candles.push({
        ts: Date.now(),
        open: p,
        high: p,
        low: p,
        close: p,
        volumeUsd: 0,
      });
    }
    if (this.candles.length > 5000) {
      this.candles = this.candles.slice(-5000);
    }
  }
}
