import { pricePassesGate } from './price.js';

/**
 * Jupiter Perps mark-price feed.
 *
 * Pyth's free tier is gone, so we source the price from the venue that will
 * actually price and liquidate the position: Jupiter Perps' own
 * `GET /v1/market-stats?mint=<mint>` endpoint. It is keyless and returns the
 * exact mark the perps engine uses, so our stops/hedge math is measured against
 * the same number that would trigger a liquidation.
 *
 * Verified live 2026-09-21 (no API key required):
 *   SOL  -> price ~116.79  (swap venue ~116.86; ~0.06% apart -> no basis to farm)
 *   ETH  -> price ~2754.77
 *   BTC  -> price ~85711.06
 *
 * Every accepted print still passes the SAME single-poll sanity gate the spot
 * oracle uses, so a glitched perps print can never drive a hedge/close.
 */

export const PERP_MARKETS: Record<string, string> = {
  SOL: 'So11111111111111111111111111111111111111112',
  ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  BTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
};

export interface PerpMark {
  mint: string;
  price: number;
  priceChange24H: number;
  priceHigh24H: number;
  priceLow24H: number;
  volumeUsd: number;
  /** wall-clock ms the print was accepted */
  ts: number;
}

export interface PerpPriceFeedOptions {
  /** Base URL, e.g. https://perps-api.jup.ag/v1 */
  apiUrl: string;
  /** Reject a print that jumps more than this fraction from the last accepted. */
  maxSingleJumpPct: number;
  /** Network timeout (ms). */
  timeoutMs?: number;
}

/**
 * Fetches the perps mark price and only *commits* a print that passes the
 * anomaly gate. Returns null when the source is unreachable OR the print was
 * rejected as an anomaly — callers must treat null as "do not act on price".
 */
export class PerpPriceFeed {
  private lastAccepted = 0;
  private lastMark: PerpMark | null = null;
  private lastRejectReasonText = '';
  private ok = false;

  constructor(private opts: PerpPriceFeedOptions) {}

  /** Last accepted mark, or null if none yet. */
  mark(): PerpMark | null {
    return this.lastMark;
  }

  lastPrice(): number {
    return this.lastAccepted;
  }

  /** True when the most recent fetch committed a sane price. */
  healthy(): boolean {
    return this.ok;
  }

  lastRejectReason(): string {
    return this.lastRejectReasonText;
  }

  rejectReason(): string {
    return this.lastRejectReasonText;
  }

  async fetch(mint: string): Promise<PerpMark | null> {
    const url = `${this.opts.apiUrl.replace(/\/$/, '')}/market-stats?mint=${encodeURIComponent(mint)}`;
    let raw: string;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 8000);
      const res = await fetch(url, { signal: ctl.signal });
      clearTimeout(t);
      if (!res.ok) {
        this.ok = false;
        this.lastRejectReasonText = `http ${res.status}`;
        return null;
      }
      raw = await res.text();
    } catch (e) {
      this.ok = false;
      this.lastRejectReasonText = `fetch failed: ${(e as Error).message}`;
      return null;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.ok = false;
      this.lastRejectReasonText = 'bad json';
      return null;
    }

    const price = Number(parsed.price);
    if (!Number.isFinite(price)) {
      this.ok = false;
      this.lastRejectReasonText = 'no numeric price';
      return null;
    }

    // Same anomaly guard as the spot oracle. A genuine move passes across
    // successive polls; a single glitched print does not.
    const accepted = pricePassesGate({
      p: price,
      prev: this.lastAccepted,
      maxSingleJumpPct: this.opts.maxSingleJumpPct,
      historyHigh: Number(parsed.priceHigh24H) || undefined,
      historyLow: Number(parsed.priceLow24H) || undefined,
    });

    if (!accepted) {
      this.ok = false;
      this.lastRejectReasonText = `jump gate rejected ${price} vs ${this.lastAccepted}`;
      return null;
    }

    const mark: PerpMark = {
      mint,
      price,
      priceChange24H: Number(parsed.priceChange24H) || 0,
      priceHigh24H: Number(parsed.priceHigh24H) || 0,
      priceLow24H: Number(parsed.priceLow24H) || 0,
      volumeUsd: Number(parsed.volume) || 0,
      ts: Date.now(),
    };
    this.lastAccepted = price;
    this.lastMark = mark;
    this.ok = true;
    return mark;
  }
}
