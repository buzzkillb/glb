import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import type { AppConfig } from './config.js';
import { dryRunEnabled, liveExecutionKilled } from './jupiter.js';
import { PERP_MARKETS } from './perpPrice.js';
import type { PerpPosition } from './perpStore.js';

/**
 * Jupiter Perps execution broker — the sibling of `liveBroker.ts` for the
 * leverage sleeve.
 *
 * SAFETY: it obeys the exact same guards as the spot live path —
 *   - `liveExecutionKilled()` hard-halts the swap path
 *   - `dryRunEnabled()` builds + validates but never sends (the default until
 *     the operator sets LIVE_ARM=1)
 * so enabling perps can never bypass the spot book's kill-switch.
 *
 * Verified request schema (2026-09-21, live, no key):
 *   POST /v1/positions/increase  { collateralMint, marketMint, inputMint,
 *     collateralTokenDelta:<raw base units string>, leverage:<string>,
 *     side:'short'|'long', maxSlippageBps:<string>, walletAddress }
 *   -> { positionPubkey, quote:{ entryPriceUsd, liquidationPriceUsd,
 *        openFeeUsd, leverage }, serializedTxBase64, requireKeeperSignature }
 *
 * NOTE: `collateralTokenDelta` is in RAW BASE UNITS (USDC has 6 decimals), so
 * $50 collateral is the string "50000000". The venue enforces a $10 minimum
 * collateral for a new position — we surface that before spending fees.
 */

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;

/** Venue-enforced floor for opening a new position (USD). */
export const PERP_MIN_COLLATERAL_USD = 10;

export interface PerpQuote {
  entryPriceUsd: number;
  liquidationPriceUsd: number;
  openFeeUsd: number;
  leverage: number;
  collateralUsd: number;
  notionalUsd: number;
  positionPubkey: string;
  /** Unsigned, base64 serialized transaction (undefined if build returned none). */
  serializedTxBase64?: string;
}

export interface PerpBuildResult {
  ok: boolean;
  quote?: PerpQuote;
  error?: string;
}

export interface PerpCloseResult {
  ok: boolean;
  /** Realized PnL inferred from mark move (paper) or venue (live). */
  pnlUsd?: number;
  feeUsd?: number;
  error?: string;
}

export interface PerpBrokerOptions {
  /** e.g. https://perps-api.jup.ag/v1 */
  apiUrl: string;
  rpcUrl: string;
  /** slippage ceiling in bps for open/close */
  slippageBps: number;
  /** dry-run switch independent of LIVE_ARM for the perps sleeve. */
  paper: boolean;
}

interface RawBuild {
  positionPubkey?: string;
  serializedTxBase64?: string;
  quote?: Record<string, string> | null;
  code?: string;
  message?: string;
}

function usdToRaw(usd: number, decimals = USDC_DECIMALS): string {
  return String(Math.round(usd * 10 ** decimals));
}

export class PerpBroker {
  private conn: Connection;

  constructor(private opts: PerpBrokerOptions) {
    this.conn = new Connection(opts.rpcUrl, 'confirmed');
  }

  /** True when the sleeve should NOT send a real transaction. */
  private skipSend(): boolean {
    return this.opts.paper || dryRunEnabled() || liveExecutionKilled();
  }

  private async post(pathname: string, body: Record<string, unknown>): Promise<RawBuild> {
    const url = `${this.opts.apiUrl.replace(/\/$/, '')}${pathname}`;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const txt = await res.text();
      const parsed = JSON.parse(txt) as RawBuild & { error?: string };
      if (parsed.code === 'invalid_argument' || parsed.code) {
        return { code: parsed.code, message: parsed.message ?? parsed.code };
      }
      return parsed;
    } catch (e) {
      return { code: 'network', message: (e as Error).message };
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Build (and optionally send) an opening order. Returns a normalized quote so
   * the strategy can store entry/liquidation and enforce its own stop.
   *
   * @param side 'short' hedges grid inventory; 'long' is the directional overlay
   * @param collateralUsd USDC margin to post
   * @param walletAddress owner wallet (public key)
   */
  async open(params: {
    asset: string;
    side: 'long' | 'short';
    collateralUsd: number;
    leverage: number;
    walletAddress: string;
    signer?: Keypair;
  }): Promise<PerpBuildResult> {
    const mint = PERP_MARKETS[params.asset];
    if (!mint) return { ok: false, error: `unknown perp asset ${params.asset}` };

    if (params.collateralUsd < PERP_MIN_COLLATERAL_USD) {
      return {
        ok: false,
        error: `collateral $${params.collateralUsd.toFixed(2)} < venue minimum $${PERP_MIN_COLLATERAL_USD}`,
      };
    }

    const raw = await this.post('/positions/increase', {
      collateralMint: USDC_MINT,
      marketMint: mint,
      inputMint: USDC_MINT,
      collateralTokenDelta: usdToRaw(params.collateralUsd),
      leverage: String(params.leverage),
      side: params.side,
      maxSlippageBps: String(Math.max(1, Math.round(this.opts.slippageBps))),
      walletAddress: params.walletAddress,
    });

    if (raw.code) return { ok: false, error: `${raw.code}: ${raw.message}` };

    const q = raw.quote ?? {};
    const entry = Number(q.entryPriceUsd);
    const liq = Number(q.liquidationPriceUsd);
    const fee = Number(q.openFeeUsd);

    // SAFETY: refuse to open on a build with no usable price/liquidation —
    // without a liquidation price we cannot assert our stop sits inside it.
    if (!Number.isFinite(entry) || !Number.isFinite(liq)) {
      return { ok: false, error: 'venue returned no entry/liquidation price' };
    }

    const quote: PerpQuote = {
      entryPriceUsd: entry,
      liquidationPriceUsd: liq,
      openFeeUsd: Number.isFinite(fee) ? fee : 0,
      leverage: Number(q.leverage) || params.leverage,
      collateralUsd: params.collateralUsd,
      notionalUsd: params.collateralUsd * params.leverage,
      positionPubkey: raw.positionPubkey ?? '',
      serializedTxBase64: raw.serializedTxBase64,
    };

    const send = await this.maybeSend(quote.serializedTxBase64, params.signer);
    // Only a genuine LIVE send failure invalidates the open. Dry-run / paper
    // intentionally skip the send, so `sent:false` without an error is fine —
    // the built quote is still booked so the dashboard shows a live position.
    if (send.error) return { ok: false, error: send.error };
    return { ok: true, quote };
  }

  /** Close an existing position at market. */
  async close(params: {
    asset: string;
    side: 'long' | 'short';
    collateralUsd: number;
    notionalUsd: number;
    positionPubkey: string;
    walletAddress: string;
    signer?: Keypair;
  }): Promise<PerpCloseResult> {
    const mint = PERP_MARKETS[params.asset];
    if (!mint) return { ok: false, error: `unknown perp asset ${params.asset}` };
    if (!params.positionPubkey) {
      return { ok: false, error: 'missing positionPubkey: cannot build a decrease' };
    }

    // NOTE: `/positions/decrease` uses a DIFFERENT schema from `increase`.
    // It requires `collateralUsdDelta`, `sizeUsdDelta`, `desiredMint`, and
    // `positionPubkey` — sending the increase-style `collateralTokenDelta`/`side`
    // payload is rejected with `invalid_argument`. A full close withdraws the
    // whole collateral and reduces the whole notional size to zero.
    const raw = await this.post('/positions/decrease', {
      collateralUsdDelta: usdToRaw(params.collateralUsd),
      sizeUsdDelta: usdToRaw(params.notionalUsd),
      desiredMint: USDC_MINT,
      positionPubkey: params.positionPubkey,
      collateralMint: USDC_MINT,
      marketMint: mint,
      walletAddress: params.walletAddress,
      maxSlippageBps: String(Math.max(1, Math.round(this.opts.slippageBps))),
    });

    if (raw.code) return { ok: false, error: `${raw.code}: ${raw.message}` };

    const q = raw.quote ?? {};
    const send = await this.maybeSend(raw.serializedTxBase64, params.signer);
    // A live close that fails to submit must NOT be treated as closed, or the
    // ledger would drop a position that still exists on-chain.
    if (send.error) return { ok: false, error: send.error };

    return {
      ok: true,
      pnlUsd: Number.isFinite(Number(q.realizedPnlUsd)) ? Number(q.realizedPnlUsd) : undefined,
      feeUsd: Number.isFinite(Number(q.closeFeeUsd)) ? Number(q.closeFeeUsd) : undefined,
    };
  }

  /** Read live positions for reconciliation (collateral + unrealized PnL). */
  async positions(walletAddress: string): Promise<PerpPosition[] | null> {
    const url = `${this.opts.apiUrl.replace(/\/$/, '')}/positions?walletAddress=${encodeURIComponent(walletAddress)}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return null;
      const body = (await res.json()) as { dataList?: unknown[] };
      return Array.isArray(body.dataList) ? (body.dataList as PerpPosition[]) : [];
    } catch {
      return null;
    }
  }

  /** Sign + submit a serialized tx, honoring the kill-switch/dry-run guards. */
  private async maybeSend(
    serializedTxBase64: string | undefined,
    signer?: Keypair
  ): Promise<{ sent: boolean; error?: string }> {
    if (!serializedTxBase64) return { sent: false };
    if (this.skipSend()) return { sent: false };
    if (!signer) {
      return { sent: false, error: 'no signer — position built but NOT submitted' };
    }
    try {
      const tx = VersionedTransaction.deserialize(Buffer.from(serializedTxBase64, 'base64'));
      tx.sign([signer]);
      const sig = await this.conn.sendTransaction(tx, {
        skipPreflight: false,
        maxRetries: 3,
      });
      await this.conn.confirmTransaction(sig, 'confirmed');
      return { sent: true };
    } catch (e) {
      // Return the failure instead of swallowing it: a live submission that
      // fails must NOT be booked as an open position, or the sleeve would
      // believe it is hedged while nothing exists on-chain.
      return { sent: false, error: `send failed: ${(e as Error).message}` };
    }
  }
}

export function perpsApiUrl(cfg: AppConfig): string {
  return process.env.PERPS_API_URL || 'https://perps-api.jup.ag/v1';
}
