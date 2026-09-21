# Perps Sleeve — Code & Algorithm Audit

**Date:** 2026-09-21
**Scope:** `src/perpPrice.ts`, `src/perpBroker.ts`, `src/perpStrategy.ts`, `src/perpStore.ts`, `src/perpSleeve.ts`, `src/perpProfit.ts`, wiring in `src/engine.ts` / `src/server.ts` / `public/index.html`, plus config/env.
**Posture:** read-only analysis of a code path that is **disabled by default** (`PERPS_ENABLED` unset). Nothing has traded real perps funds.

---

## 1. What was requested and what was done

Three asks:

1. **Wire in the tracked "Realized PnL +521.10 $"** as a live funding source — not a literal.
2. **No hardcoding.** Every number must come from config or live records.
3. **Clone-friendly config, no secrets**, then **audit the code** for algorithmic/setup problems.

Outcome:

- Added `src/perpProfit.ts` — a dynamic profit detector that reads the bot's **own persisted records** (equity archive + trade journal) to compute eligible profit with **no hardcoded floor**. Verified against the real tape: it detects **lifetime realized PnL = $521.10** exactly, matching the dashboard figure.
- Banked realized PnL is now a **deployable ceiling** (`realizedProfitUsePct`, default 0.5, 0 disables). It caps risk to money actually banked, and cannot make the budget negative.
- Every previously-magic constant (window hours, min fills, open fee, hourly borrow, leverage, hedge ratio, stops, caps) is now an env-configurable field with a safe default.
- `.env.example` documents all 22 perps knobs with no secrets; the perps mark feed is keyless.
- Full audit below. 8 new invariant tests; suite is 115 passing / 0 failing.

---

## 2. Verified live values (evidence)

| Signal | Value | Source |
|---|---|---|
| Lifetime realized PnL on live tape | **$521.10** | `readJournal('live')` — 320 fills |
| Equity archive baseline (first sample) | $10,402.87 @ 2026-09-20 | `readEquityArchive('live')` — 100 samples, append-only |
| Current equity | $10,567.26 | live `/api/audit` |
| Free USDC (spendable margin) | $10,447.95 | live `/api/audit` |
| New profit above baseline | $164.39 | computed |
| Deployable with defaults | **$82.20** | capped by realized×0.5=260.55, profit×0.5=82.20 |

The detected **$521.10** matches the number you quoted. It is read from the trade journal, never typed in.

---

## 3. Algorithm review

### 3.1 Sizing invariant — correct
`deployableSleeveUsd` returns `min(profitShare·newProfit, realizedShare·banked, cashUse·freeCash, maxEquity·equity, maxMargin)` and is `0` when not ready or when `newProfit <= 0`. Every term is `max(0, ·)`-guarded, so a drawdown collapses the budget to exactly 0 — never negative, never touching principal. Directly answers "what if profits go negative."

### 3.2 Baseline anchoring — correct **only because the archive never rotates**
`detectProfit` sets the floor to the **earliest** archived equity sample. I confirmed `readEquityArchive` reads the whole file with **no retention cap**, so the earliest sample is stable. If a future change adds archive rotation, the baseline would drift upward and silently shrink eligible profit. **Recommendation:** if rotation is ever added, persist the baseline separately (one row, never pruned).

### 3.3 Realized-PnL double-count — handled
Banked realized gains are already inside `newProfit` (they raise equity). Using `realizedShare·banked` as a **cap, not an addend**, prevents double-counting. Correct.

### 3.4 Short-side liquidation math — a real bug in the strategy layer
In `stopInsideLiquidation`, for a **short**, `liqMove = (liquidation - entry)/entry`. For a short, liquidation sits **above** entry, so this is positive — correct. But `line ~156` reasoning elsewhere and the paper `localQuote` uses `adverseToLiq = 1 - 1/lev` symmetrically, which is a crude approximation that ignores the venue's maintenance-margin ratio. The real Jupiter Perps liquidation is driven by maintenance margin + borrow, not `1/lev`. **Risk:** the paper estimate can claim a buffer that differs from the venue's actual liquidation price. **Mitigation:** `openPosition` re-checks the **venue-reported** liquidation price before booking, and rejects if our stop is not strictly inside it. So live safety depends on that venue check, not the paper estimate. **Recommendation:** add an explicit test that a venue liquidation price *closer* than our stop causes a hard reject.

### 3.5 Borrow cost is never accrued — **accounting gap**
`hourlyBorrowPct` is defined in config and surfaced in the type, but **no code applies it** (`grep` shows 0 usages in `perpSleeve.ts`/`perpStore.ts`). Real Jupiter Perps charges borrow/funding on open positions. Consequences:
- Paper PnL is **optimistic** — it ignores carry on the short.
- The loss ceiling (`maxLossUsd`) and stop (`stopLossMarginPct`) fire on PnL that excludes borrow, so a slow bleed via borrow can go undetected longer than intended.
**Recommendation:** accrue `hourlyBorrowPct · notional · hoursHeld` into `feesPaidUsd` on each tick and subtract it from the PnL used by stop/halt checks. Small but real over multi-day holds.

### 3.6 Halt ceiling halts new margin but does **not** close the open position
`setHalt` is sticky (permanent until cleared) and blocks new margin, but an already-open position stays open and continues to be managed. That is defensible (avoid dumping at the worst moment), but the name "halt" can read as "flat." **Recommendation:** document explicitly, and/or add a `haltClosesOpen` option (default off).

### 3.7 Hedge sizing uses grid `baseQty` — inventory risk
`gridNetLongUsd` reads `this.store.strategies.grid.subBook.baseQty`. If the grid sub-book is empty/mid-recycle, exposure reads 0 and no hedge arms even when the wallet holds SOL. **Recommendation:** fall back to the wallet's actual SOL balance when the sub-book is empty.

### 3.8 `PerpStore.save` is non-atomic
`save()` does a plain `writeFileSync` of the whole ledger to a fixed path. A crash mid-write can truncate/corrupt the ledger, which would reset the loss ceiling and floor memory. **Recommendation:** write to `file.tmp` then `renameSync` (atomic on POSIX). Same pattern should be checked in the main state store.

### 3.9 Ledger corruption fails closed — good
`readEquityArchive` skips malformed lines; `PerpStore.load` should do the same. Confirmed the archive parse is defensive. If the perps ledger is unreadable, it should default to empty + `halted:false`, which is safe (budget recomputes from live signal).

### 3.10 Feed anomaly gate — reasonable
`PerpPriceFeed` shares the spot `maxSingleJumpPct` gate and aborts after `timeoutMs` (8s default). Combined with `markHealthy`, a glitchy print won't trigger an open. Fine.

---

## 4. Setup / secrets review

| Check | Result |
|---|---|
| Secrets in source | **None.** Only `BIRDEYE_API_KEY` (optional, meme) and wallet file path. Perps API is keyless. |
| Secrets in repo | `.env` not tracked (verify `.gitignore`); `.env.example` documents all knobs with placeholder-free defaults. |
| Clone-run path | Perps default `enabled:false`; a fresh clone runs spot-only until `PERPS_ENABLED=1`. |
| Hardcoded floor | Removed as required value; `PERPS_PRINCIPAL_FLOOR_USD=0` ⇒ dynamic baseline. |
| Danger default for clone | `PERPS_MAX_MARGIN_USD=250`, `PERPS_MAX_LEVERAGE=3`, stop 25% margin, halt at −$75. Conservative. |

**One caveat:** the live process on `:3000` was started before these edits, so its `/api/perps` lacks the `profit` block until the agent restarts. Code is on disk; the running process is stale.

---

## 5. Priority findings

| # | Severity | Finding | Action |
|---|---|---|---|
| 1 | **High** | Borrow/funding never accrued → optimistic paper PnL, late stops | Accrue per tick; subtract from stop/halt PnL |
| 2 | **High** | `PerpStore.save` non-atomic → corruption can reset floor/halt | tmp+rename |
| 3 | Medium | Short liquidation buffer uses `1/lev` approximation | Rely on venue liquidation check; add reject test |
| 4 | Medium | Hedge ignores wallet SOL when grid sub-book empty | Fall back to wallet balance |
| 5 | Medium | Halt blocks new margin but leaves position open | Document / optional close-on-halt |
| 6 | Low | Archive rotation would drift the baseline | Persist baseline separately if rotation added |
| 7 | Low | Stale live process lacks new profit block | Restart agent to load new code |

---

## 6. Verification performed

- `npx tsc --noEmit` → clean.
- `npx tsx --test test/perpProfit.test.ts` → 8/8 pass (baseline derivation, cash limit, zero-floor collapse, realized cap, disable path, negative-tape safety).
- `npm test` → 117 tests, **115 pass, 0 fail, 2 skipped**.
- Live-record read: detected **$521.10** realized and $82.20 deployable from real data.

---

## 7. Conclusion

The profit-funding redesign meets all three asks: realized PnL is wired live (not hardcoded), the floor is dynamic from the bot's own records, constants are configurable for clones, and there are no secrets. The sleeve remains **disabled by default** and cannot touch spot base capital: budget is 0 whenever equity is at/below baseline, and every term is non-negative-safe.

Two items should be fixed before enabling live perps: **borrow accrual** (#1) and **atomic ledger writes** (#2). Neither blocks the code as-is because live sending is separately gated by `LIVE_ARM`, but both affect the accuracy of the safety ceilings that protect real margin.
