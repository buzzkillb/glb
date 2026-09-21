# Perps Amplification Plan — AS BUILT

**Status:** implemented and verified (paper-verified; live send gated behind `LIVE_ARM`)
**As of:** 2026-09-21
**Goal:** amplify profit on top of the spot grid/DCA book using a profit-funded,
risk-isolated Jupiter Perps sleeve — without ever putting base capital at risk.

---

## 1. The design (and why it's safe)

The spot grid/DCA book stays the majority profit engine and is **never touched**.
The perps sleeve is funded **only** by equity above an **untouchable principal floor**:

```
budget = min( share * max(0, equity - principalFloor) - outstandingMargin,
              equity * maxEquityPct,
              maxMarginUsd )
```

Because the floor never decreases, base capital is structurally out of reach. The
sleeve lives in its own state file (`perps-<mode>.json`), own accounting, own risk
budget — it cannot corrupt or drain the spot book.

## 2. "How much money should we actually use?"

Answer: **only the account's own earned profit, and only a fraction of it.**

- Default `PERPS_PROFIT_SHARE_PCT=0.5` — at most **half** of equity above the floor.
- Default `PERPS_MAX_EQUITY_PCT=0.10` — hard ceiling at **10% of equity**, no matter
  how large the profit grows.
- Default `PERPS_MAX_MARGIN_USD=250` — absolute USD ceiling per position.
- Default `PERPS_MAX_LEVERAGE=3` — leverage ceiling (hedge path uses ≤2x).

At the current live book (~$10.5k equity, +$522 realized), a sensible rollout is:

| Setting | Conservative | Aggressive |
|---|---|---|
| Principal floor | current equity ($10.5k) | a fixed $5k (banks prior profit out of reach) |
| Deployable profit | $0 until new profit is earned | ~$5.2k profit → 50% = $2.6k, capped to 10% = $1.05k, capped to $250 ceiling → **$250** |
| Leverage | 2x (hedge) | 3x (overlay) |
| Realistic position | $250 margin @2x = $500 notional | $250 @3x = $750 notional |

Result: even in the aggressive case the sleeve can lose **at most $250 of already-won
money**, and the $10.5k principal is provably untouchable.

## 3. "What if profits go negative?" — handled by construction

This is the important question and the model answers it directly:

- Eligible profit = `max(0, equity - principalFloor)`. If equity falls to/below the
  floor, eligible profit is **exactly 0** and `computeSleeveBudget` returns **0**.
- The budget is never negative, so the sleeve can never "owe" margin.
- The sleeve simply **stops deploying**; the grid keeps running independently.
  Nothing to unwind, nothing to top up.
- A separate **loss ceiling** (`PERPS_MAX_LOSS_USD`, default $75) permanently HALTS
  the sleeve if its own realized loss breaches it. Halting blocks new margin only —
  the spot book is unaffected.

Tested invariants (see `test/perps.test.ts`, 16 passing):
- budget = 0 at/below the floor, and after a drawdown,
- negative sleeve PnL does not risk principal,
- halted sleeve deploys nothing,
- outstanding margin prevents double-deploying the same profit,
- principal floor ratchets up only and never down,
- stop must sit **inside** liquidation (the leverage failure mode),
- perps ledger is a separate file from the spot book.

## 4. Strategy tiers

- **Tier 1 — profit-funded sleeve.** The funding model above. Deploys only earned profit.
- **Tier 2 — delta-neutral hedge (preferred).** When the grid accumulates net-long SOL
  beyond `PERPS_HEDGE_TRIGGER_PCT` (default 15% of equity), open a short perp sized to
  `gridNetLong * PERPS_HEDGE_RATIO` (default 0.8) — flattening the grid's directional
  tail so the grid can run harder. Cost: hourly borrow (live: ~0.0006%/hr SOL short).
- **Tier 3 — directional overlay (off by default).** Only when there is no hedge to
  place and `PERPS_OVERLAY_ENABLED=1`; uses a fraction of the sleeve budget, 2-3x,
  with the same inside-liquidation stop enforcement.

## 5. Price feed (keyless, authoritative)

Pyth's free tier is gone, so the sleeve prices off the venue that would actually
liquidate it — the Jupiter Perps mark. **Verified live 2026-09-21, no API key:**

```
GET https://perps-api.jup.ag/v1/market-stats?mint=<mint>   -> price
GET https://perps-api.jup.ag/v1/pool-info?mint=<mint>      -> borrow rate, open fee
GET https://perps-api.jup.ag/v1/positions?walletAddress=.. -> reconciliation
POST https://perps-api.jup.ag/v1/positions/increase        -> open
POST https://perps-api.jup.ag/v1/positions/decrease        -> close
```

Every accepted print passes the same single-poll anomaly gate as the spot oracle
(`pricePassesGate`), so a glitched print cannot drive a hedge or close.

Observed: SOL mark ≈ swap-venue price (~0.06% apart) → **no basis to farm**, which is
why hedging/direction (not carry) is the right use. JLP is a basket-price exposure,
not a clean funding capture — correctly set aside.

## 6. Safety posture on execution

`PerpBroker` obeys the **same guards as the spot live path**:
- `dryRunEnabled()` — builds + validates but never sends until `LIVE_ARM=1`,
- `liveExecutionKilled()` — hard-stops the perps path too,
- refuses to open without a usable entry/liquidation price,
- refuses to open unless our stop is verified inside liquidation,
- venue minimum $10 collateral is surfaced before any fees are spent.

## 7. Dashboard / observability

- **Perps tab** (`/api/perps`): status, venue mark + feed health, principal floor,
  eligible profit, sleeve budget, edge %, grid net-long + exposure %, open position,
  liquidation buffer, sleeve PnL/fees, and the last sizing decision.
- **Perps ledger tape** (`/api/perps/ledger`): every open/close/halt/reject with
  collateral, notional, PnL, price, and reason.
- **Audit endpoint** (`/api/audit`) continues to reconcile the spot book; the perps
  book is reconciled separately so spot accounting is never polluted.

## 8. Module layout (as built)

| File | Role |
|---|---|
| `src/perpPrice.ts` | keyless venue mark feed + anomaly gate |
| `src/perpBroker.ts` | open/close/positions; kill-switch + dry-run guarded |
| `src/perpStrategy.ts` | pure sizing + safety rules (budget, decision, stop-inside-liq) |
| `src/perpStore.ts` | isolated perps ledger (principal floor, halt, realized PnL) |
| `src/perpSleeve.ts` | controller wired into the engine loop; dashboard view |
| `src/config.ts` | `PERPS_*` env knobs (sleeve off by default) |
| `public/index.html` | Perps tab + ledger tape |
| `test/perps.test.ts` | 16 invariant tests |

## 9. Recommended rollout

1. Leave `PERPS_ENABLED` off until the spot book clears the admission gate
   (≥30 positive days, PF>1.5, DD<10%, `booksMatchChain` true daily, fees<25% gross).
2. Enable on **paper** with `PERPS_PRINCIPAL_FLOOR_USD` set to current equity.
3. Enable the Tier 2 hedge live at tiny size; confirm `/api/audit` stays clean.
4. Only then consider Tier 3 overlay.

## 10. Caveats (honest status)

- Verified end-to-end in **paper** mode against the live perps API. The live send
  path is implemented and guarded but has not been exercised with real funds yet.
- The venue minimum is **$10 collateral**; below that the sleeve correctly idles.
- `git diff` changes are uncommitted.
