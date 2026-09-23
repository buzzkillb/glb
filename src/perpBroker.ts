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
const SOL_DECIMALS = 9;

/**
 * Venue-enforced floors, VERIFIED LIVE (2026-09-21):
 *   - leverage < 1.1 is rejected (`invalid_leverage`, incl. exactly 1x)
 *   - a LONG position must post the MARKET TOKEN as collateral
 *     (`invalid_collateral_token` when posting USDC for a long)
 * These are external venue facts, not policy choices, so they live with the
 * broker rather than as tunable config.
 */
export const PERP_MIN_LEVERAGE = 1.1;

/** Venue-enforced floor for opening a new position (USD). */
export const PERP_MIN_COLLATERAL_USD = 10;

/**
 * Base-unit decimals per market mint, for converting a USD long-collateral size
 * into raw token units. Keyed by mint so ETH/BTC do not silently borrow SOL's 9.
 */
const MARKET_DECIMALS: Record<string, number> = {
  [USDC_MINT]: USDC_DECIMALS,
  [PERP_MARKETS.SOL]: SOL_DECIMALS,
  [PERP_MARKETS.ETH]: 8,
  [PERP_MARKETS.BTC]: 8,
};

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
  /** Returned by /transaction/execute when the keeper lands the tx. */
  txid?: string;
  signature?: string;
  code?: string;
  message?: string;
}

function usdToRaw(usd: number, decimals = USDC_DECIMALS): string {
  return String(Math.round(usd * 10 ** decimals));
}

/** Decimal places for a mint, for converting a USD size into raw base units. */
function mintDecimals(mint: string): number {
  // Fall back to USDC's precision only for the unknown case; every market we
  // actually trade is explicitly mapped in MARKET_DECIMALS.
  return MARKET_DECIMALS[mint] ?? USDC_DECIMALS;
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

    // SAFETY: leverage must clear the venue's enforced floor, or the build is
    // rejected outright. Surface it here rather than spending a failed request.
    if (params.leverage < PERP_MIN_LEVERAGE) {
      return {
        ok: false,
        error: `leverage ${params.leverage.toFixed(2)}x < venue minimum ${PERP_MIN_LEVERAGE}x`,
      };
    }

    // Collateral rules are SIDE-DEPENDENT at this venue: a SHORT posts USDC
    // (quote) as margin, while a LONG must post the MARKET TOKEN itself. Posting
    // the wrong one is rejected (`invalid_collateral_token`), so pick the mint
    // and convert the USD size into that token's raw base units.
    const collateralMint = params.side === 'long' ? mint : USDC_MINT;
    let collateralRaw: string;
    if (params.side === 'long') {
      const mark = await this.markPrice(mint);
      if (!(mark > 0)) return { ok: false, error: 'no mark price to size long collateral' };
      collateralRaw = usdToRaw(params.collateralUsd / mark, mintDecimals(mint));
    } else {
      collateralRaw = usdToRaw(params.collateralUsd);
    }

    const raw = await this.post('/positions/increase', {
      collateralMint,
      marketMint: mint,
      inputMint: collateralMint,
      collateralTokenDelta: collateralRaw,
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

    const send = await this.maybeSend(quote.serializedTxBase64, params.signer, 'increase-position');
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
      // A hedge unwind should exit the WHOLE position, not leave a stub behind.
      // The venue honors `entirePosition` alongside the deltas.
      entirePosition: true,
      maxSlippageBps: String(Math.max(1, Math.round(this.opts.slippageBps))),
    });

    if (raw.code) return { ok: false, error: `${raw.code}: ${raw.message}` };

    const q = raw.quote ?? {};
    const send = await this.maybeSend(raw.serializedTxBase64, params.signer, 'decrease-position');
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
    signer: Keypair | undefined,
    action: 'increase-position' | 'decrease-position'
  ): Promise<{ sent: boolean; error?: string }> {
    if (!serializedTxBase64) return { sent: false };
    if (this.skipSend()) return { sent: false };
    if (!signer) {
      return { sent: false, error: 'no signer — position built but NOT submitted' };
    }
    try {
      // Jupiter Perps requires the KEEPER to co-sign and land the tx
      // (`requireKeeperSignature:true` on the build reply). Submitting directly
      // to the RPC fails signature/landing, so the correct flow is: sign the
      // user's side here, then POST the signed bytes to /transaction/execute,
      // which returns the real on-chain txid. Verified live 2026-09-21.
      const tx = VersionedTransaction.deserialize(Buffer.from(serializedTxBase64, 'base64'));
      tx.sign([signer]);
      const signedB64 = Buffer.from(tx.serialize()).toString('base64');
      const exec = await this.postTx('/transaction/execute', {
        action,
        serializedTxBase64: signedB64,
      });
      if (exec.code) return { sent: false, error: `keeper execute failed: ${exec.code}: ${exec.message}` };
      const txid = exec.txid || exec.signature;
      if (!txid) return { sent: false, error: 'keeper returned no txid' };
      // Confirm the keeper-landed tx so we never book a position that did not
      // actually open (or close).
      const err = await this.confirmTx(txid);
      if (err) return { sent: false, error: `tx did not confirm: ${err}` };
      return { sent: true };
    } catch (e) {
      // Return the failure instead of swallowing it: a live submission that
      // fails must NOT be booked as an open position, or the sleeve would
      // believe it is hedged while nothing exists on-chain.
      return { sent: false, error: `send failed: ${(e as Error).message}` };
    }
  }

  /**
   * Poll a keeper-landed txid until confirmed. The keeper only returns a txid
   * once it has landed the tx, but we still verify on-chain so we never book a
   * position that did not actually open/close. Public RPCs are flaky, so fall
   * back to a public endpoint if the configured one cannot see the tx.
   */
  private async confirmTx(txid: string): Promise<string | null> {
    const rpcs = [this.opts.rpcUrl, 'https://solana-rpc.publicnode.com'];
    const deadline = Date.now() + 75_000;
    while (Date.now() < deadline) {
      for (const rpc of rpcs) {
        try {
          const conn = new Connection(rpc, 'confirmed');
          const st = await conn.getSignatureStatuses([txid], { searchTransactionHistory: true });
          const s = st.value[0];
          if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
            return s.err ? JSON.stringify(s.err) : null;
          }
        } catch {
          /* try the next RPC */
        }
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return `not confirmed in 75s (${txid})`;
  }

  /** GET the venue mark price for a mint (used to size long-side collateral). */
  private async markPrice(mint: string): Promise<number> {
    try {
      const url = `${this.opts.apiUrl.replace(/\/$/, '')}/market-stats?mint=${mint}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      const d = (await res.json()) as { price?: string | number };
      return Number(d.price) || 0;
    } catch {
      return 0;
    }
  }

  /** POST expecting a tx-execution reply (txid/signature) rather than a quote. */
  private async postTx(pathname: string, body: Record<string, unknown>): Promise<RawBuild> {
    const url = `${this.opts.apiUrl.replace(/\/$/, '')}${pathname}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25_000),
      });
      return (await res.json()) as RawBuild;
    } catch {
      return {};
    }
  }
}

export function perpsApiUrl(cfg: AppConfig): string {
  return process.env.PERPS_API_URL || 'https://perps-api.jup.ag/v1';
}
