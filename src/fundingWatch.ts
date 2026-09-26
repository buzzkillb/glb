/**
 * FUNDING/CARRY WATCH — front-page dashboard gauge.
 *
 * Jupiter Perps has no classic "funding rate": carry on an open position is
 * the per-side BORROW rate from `GET /v1/pool-info?mint=<mint>`
 * (`longBorrowRatePercent` / `shortBorrowRatePercent`, hourly fractions).
 * That is also exactly the carry cost our perps sleeve pays, so it is the
 * number that matters for the "is a carry trade worth it?" decision.
 *
 * This module polls that keyless endpoint on a slow interval, keeps only the
 * latest good sample (plus age), and NEVER throws: dashboard display must
 * degrade to "—" on network failure, not take the poll loop with it. It is
 * display-only — no strategy reads this.
 */

export interface FundingSnapshot {
  /** Hourly borrow fraction paid by LONGs (e.g. 0.000015). */
  longHourlyPct: number;
  /** Hourly borrow fraction paid by SHORTs. */
  shortHourlyPct: number;
  /** APR equivalent (hourly * 24 * 365) as a percent, e.g. 13.1 = 13.1% APR. */
  longAprPct: number;
  shortAprPct: number;
  /** Venue utilization per side (percent) — context for why borrow is high. */
  longUtilPct: number;
  shortUtilPct: number;
  /** Venue open fee percent (of notional) — round-trip cost context. */
  openFeePct: number;
  /** wall-clock ms of the last ACCEPTED sample */
  ts: number;
  /** seconds since the last good sample (drives the stale badge) */
  ageSec: number;
}

const STALE_AFTER_SEC = 15 * 60;

export class FundingWatch {
  private timer?: NodeJS.Timeout;
  private latest?: FundingSnapshot;

  constructor(
    private apiUrl: string,
    private mint: string,
    private intervalMs = 60_000
  ) {}

  start(): void {
    if (this.timer) return;
    void this.poll(); // immediate first sample, errors swallowed inside
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Latest sample, or null before the first success. */
  current(): FundingSnapshot | null {
    if (!this.latest) return null;
    const ageSec = Math.round((Date.now() - this.latest.ts) / 1000);
    return { ...this.latest, ageSec };
  }

  /** True when the sample is too old to trust for display emphasis. */
  static isStale(s: FundingSnapshot): boolean {
    return s.ageSec > STALE_AFTER_SEC;
  }

  private async poll(): Promise<void> {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8_000);
      const res = await fetch(
        `${this.apiUrl.replace(/\/$/, '')}/pool-info?mint=${encodeURIComponent(this.mint)}`,
        { signal: ctl.signal }
      ).finally(() => clearTimeout(t));
      if (!res.ok) return; // keep last good sample; display shows age growing
      const j = (await res.json()) as Record<string, string>;
      const num = (k: string): number => Number(j[k]) || 0;
      const longHourly = num('longBorrowRatePercent') / 100; // percent -> fraction
      const shortHourly = num('shortBorrowRatePercent') / 100;
      this.latest = {
        longHourlyPct: longHourly,
        shortHourlyPct: shortHourly,
        longAprPct: longHourly * 24 * 365 * 100,
        shortAprPct: shortHourly * 24 * 365 * 100,
        longUtilPct: num('longUtilizationPercent'),
        shortUtilPct: num('shortUtilizationPercent'),
        openFeePct: num('openFeePercent'),
        ts: Date.now(),
        ageSec: 0,
      };
    } catch {
      // Display-only: keep the previous sample and let ageSec expose the gap.
    }
  }
}
