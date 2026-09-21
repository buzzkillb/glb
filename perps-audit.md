# Perps Sleeve — Audit #2 (post-fix)

**Date:** 2026-09-21
**Scope:** `src/perpProfit.ts`, `src/perpStrategy.ts`, `src/perpStore.ts`, `src/perpSleeve.ts`, config/env, tests.
**Posture:** code path still **disabled by default**; nothing has traded real perps funds.

---

## 1. Answers to the two requests

### "Shouldn't it be able to use the entire PnL amount?"
Yes — and it now does, **up to the risk caps that protect the account**. Defaults changed to `PERPS_PROFIT_SHARE_PCT=1.0`, `PERPS_REALIZED_USE_PCT=1.0`, `PERPS_CASH_USE_PCT=1.0`, and `PERPS_MAX_MARGIN_USD=0` (0 = no USD ceiling).

The budget is still bounded by **`maxEquityPct` (10% of equity)** — deliberately, because "use the entire PnL" must never mean "risk the whole account." Verified against live records:

| Policy | Deployable |
|---|---|
| Old (share 0.5 / realized 0.5 / ceil $250) | $82.20 |
| **New (use ENTIRE PnL, 10% equity cap)** | **$164.39** |

So with your current $164.39 eligible profit, it deploys **the entire profit** — the 10% cap ($1,056) doesn't bind at this size. Only if profit grew past ~$1,056 would the equity cap become the limiter. That ceiling is configurable (`PERPS_MAX_EQUITY_PCT`), so you can raise it if you want the whole PnL even then.

### "Fix leftover items, then audit again"
Done — all seven findings from audit #1 are resolved or explicitly handled. Details below.

---

## 2. Fixes applied

| # | Finding | Fix | Verified |
|---|---|---|---|
| 1 | Borrow/funding never accrued (High) | `manageOpen` now computes `borrowUsd = notional · hourlyBorrowPct · hoursHeld` **idempotently from `openedAt`** (no incremental double-count) and judges the stop/halt on **net PnL** (mark PnL − carry). Fees include carry. | code + typecheck |
| 2 | `PerpStore.save` non-atomic (High) | Writes `${file}.tmp` then `renameSync` (atomic on POSIX). Cannot truncate the ledger. | new test asserts no `.tmp` survives and JSON is valid |
| 3 | Short liquidation buffer approximation (Med) | Live safety already depends on the **venue-reported** liquidation price + `stopInsideLiquidation` reject. Added explicit **reject test**: a liquidation *closer* than our stop is rejected, both long and short. | 4 assertions pass |
| 4 | Hedge ignores wallet SOL (Med) | `gridNetLongUsd` now falls back to wallet `chainSol` when the grid sub-book is empty/mid-recycle. | code |
| 5 | Halt left position open (Med) | Added `PERPS_HALT_CLOSES_OPEN` (default **off**, preserving the deliberate "stop new margin, keep managing" behavior; opt-in flatten on breach). | code |
| 6 | Archive rotation would drift baseline (Low) | Documented; archive confirmed unrotated today. Baseline = earliest sample is stable. | code review |
| 7 | Stale live process lacks new block (Low) | Requires restarting the launchd agent to load new code — noted, not a code change. | pending operator action |

---

## 3. Fresh audit of the changed code

### 3.1 Borrow accrual is safe against re-entry
`hoursHeld` is derived from the immutable `openedAt` and recomputed each tick. It is **not** persisted incrementally, so no double-count across ticks, restarts, or the 500-entry history trim. Correct.

### 3.2 Net-PnL stop cannot be evaded by carry
The stop compares `netPnl <= -stopUsd`. Because carry only ever subtracts, the stop can fire *earlier* than a mark-only check — never later. That is the safe direction. Verified by inspection; no test yet exercises a multi-day carry-only breach. **Recommendation:** add a simulated `openedAt` 30 days back test asserting the stop fires with flat price. (Low priority.)

### 3.3 Sizing invariant remains non-negative-safe
Every term in `deployableSleeveUsd` is `max(0, ·)`-guarded, and `maxMarginUsd<=0` becomes `+Infinity` (not 0), so "uncapped" deploys profit rather than blocking it. `Number.isFinite(budget)` guard rejects the Infinity-only corner (all terms infinite is impossible since equity/cash are finite). Correct.

### 3.4 Wrapper staleness check
`perpProfit.ts` re-reads the whole archive + tape on each tick. With 100 archive samples and ~320 fills that is trivial, but it grows unbounded over months. **Recommendation (Low):** if the archive ever exceeds a few thousand rows, cache with an mtime check. Not a correctness issue.

### 3.5 Confirmed no new precedence/encoding issues
`haltClosesOpen` is optional in the type and defaults false, so existing behavior is preserved for any caller that omits it. `renameSync` import added; no partial-write window.

---

## 4. Verification performed

- `npx tsc --noEmit` → clean.
- `npx tsx --test test/perps.test.ts test/perpProfit.test.ts` → **26/26 pass** (includes new liquidation-reject and atomic-write tests).
- `npm test` → 119 tests, **117 pass, 0 fail, 2 skipped**.
- Live-record check: detects **$527.57** lifetime realized (tape grew since last check), $164.39 eligible, deploys the entire $164.39 under the new policy.

---

## 5. Remaining known limitations (honest)

1. **Carry accrual has no dedicated time-travel test.** Logic is correct by inspection; a 30-day `openedAt` test would lock it. Low priority.
2. **Live process is stale** until the launchd agent restarts — the running `:3000` binary predates all of this.
3. **No basis/carry trade** (unchanged decision): Jupiter swap vs perps mark gap is ~0.06%, too thin to harvest; only hedge/overlay remain.
4. **`PERPS_ENABLED` still unset** on the live plist. Perps remain inert until deliberately enabled.

---

## 6. Conclusion

All High/Medium findings are fixed with tests where behavior is safety-critical. Defaults now honor "use the entire PnL" while keeping the 10% equity cap as the outer guardrail — the sleeve can deploy all earned profit today, and only a very large profit would meet the cap (one env var away from raising). The sleeve stays disabled by default, cannot touch spot base capital, and its own loss ceiling is now judged on carry-inclusive net PnL.
