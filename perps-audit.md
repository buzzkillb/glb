# Perps Sleeve — Audit #3 (restart + full re-audit)

**Date:** 2026-09-21
**Scope:** whole perps path + `engine.ts` wiring + `store.ts` persistence, after restarting the live bot.
**Live process:** PID 4543+ on `:3000`, launchd `com.buzzkillb.gridlord`, `LIVE_ARM=1`.
**Posture:** sleeve **disabled** (`PERPS_ENABLED` unset). Nothing has traded real perps funds.

---

## 1. Restart

The bot was restarted via `launchctl kickstart -k gui/<uid>/com.buzzkillb.gridlord`. New process came up on `:3000`, live mode, chain sync completed, and the spot grid resumed normally. The previously-stale `/api/perps` (no `profit` block) now serves the full live signal.

## 2. Live verification (as of this audit)

| Field | Value |
|---|---|
| Mark (SOL perps) | $118.61, `markHealthy: true` |
| Equity | $10,557 |
| Profit baseline (dynamic, archive) | $10,402.87 |
| Eligible / new profit | $154.51 |
| Sleeve budget | $154.51 |
| Free cash (USDC) | $9,129.45 |
| Lifetime realized (tape) | $527.57 |
| Window realized (7d) | $458.03 |
| Tape fills | 315 — `ready: true` |
| Grid net-long | $1,428.02 (exposure 13.5%) |
| Position | flat |
| Status | DISABLED (`PERPS_ENABLED` not set) |

The dashboard Perps tab renders all of these correctly (verified in-browser). The sleeve computes a live, non-zero budget while remaining inert until enabled.

---

## 3. Bugs found and fixed during this pass

The restart itself surfaced real defects that only appear once a fresh process runs the new code — exactly the class of thing a static read misses.

### 3.1 Perps tab showed zeros when disabled (High — observability)
`view()` read `this.profit`, but `this.profit` is only set inside `tick()`, and `engine.ts` only called `tick()` when `enabled`. So a disabled sleeve reported `baseline 0 / ready false / budget 0` forever — misleading, since the whole point is to preview the budget before arming.
**Fix:** `view()` computes the signal on demand; `engine.ts` always calls the sleeve's read-only path.

### 3.2 Boot-time zero-equity signal was cached permanently (High — correctness of displayed risk)
First `view()` call at boot ran before chain balances synced, producing `currentEquityUsd: 0`. Caching that sample froze the tab at zero even after balances arrived.
**Fix:** cached signal is treated as stale unless `currentEquityUsd > 0 && ready`, forcing recompute. Verified: budget self-heals from 0 → $154.51 as chain sync completes.

### 3.3 Mark price invisible while disabled (Medium)
The feed only ran inside `tick()`, so `markPrice: 0` when disabled.
**Fix:** added `observe()` — a read-only mark refresh that never sizes or trades. Verified mark $118.61 / healthy.

### 3.4 Main state file written non-atomically (High — data integrity)
`store.ts persistNow()` used a plain `writeFileSync` of the entire state (balances, orders, positions, equity history) to a fixed path. A crash mid-write could truncate it and corrupt the live book on restart. `journal.ts` and `history.ts` already used tmp+rename; the main store did not.
**Fix:** tmp file + `renameSync` (atomic on POSIX), matching the other stores. Verified: state file intact, no leftover `.tmp` after restart.

### 3.5 Birdeye error was opaque (Low)
`meme.ts` threw bare `HTTP 400` with no detail, hiding quota messages like "Compute units usage limit exceeded."
**Fix:** surface the API's own `message` field.

### 3.6 Unbounded fetch in perp broker (Low)
A positions query had no timeout and could hang. **Fix:** `AbortSignal.timeout(15s)`.

### 3.7 Made carry accrual directly testable (Medium)
Extracted `borrowAccrualUsd()` as a named pure function; added tests proving linear accrual, idempotence, non-negative safety, and that a flat-price position still accumulates carry.

---

## 4. Items reviewed and judged correct (no change)

- **Sizing invariant:** every term `max(0, ·)`-guarded; `maxMarginUsd<=0` ⇒ uncapped, bounded by the 10% equity cap. Budget collapses to 0 at/below baseline — never negative, never touches base capital.
- **Realized-PnL double-count:** used as a *cap* not an addend. Correct.
- **Stop-inside-liquidation:** live safety depends on the venue-reported liquidation price plus a hard reject; covered by tests for both long and short.
- **Ledger corruption:** parses defensively; defaults to safe empty state.
- **Feed anomaly gate:** shares the spot oracle's jump gate; glitchy prints cannot open a position.
- **No secrets:** perps feed keyless; `.env` untracked; `.env.example` documents all knobs.
- **`setInterval` timers:** all cleared in `stop()`.

---

## 5. Remaining known limitations (honest)

1. **No basis/carry yield trade** — swap vs perps mark gap is ~0.06%, too thin; hedge/overlay only (unchanged decision).
2. **Carry rate is modeled, not fetched live.** `hourlyBorrowPct` is a config constant; the venue's actual rate can drift. The estimate is conservative and configurable. A future enhancement is to read the live rate from `pool-info`.
3. **`PERPS_ENABLED` still unset** — sleeve inert by design until deliberately armed.
4. **Profit detector re-reads full archive + tape each call.** Trivial at current size (100 samples / 315 fills); worth an mtime cache if it grows to thousands.

---

## 6. Verification performed

- `npx tsc --noEmit` → clean.
- `npx tsx --test test/perps.test.ts test/perpProfit.test.ts` → 28/28 pass.
- `npm test` → 121 tests, **119 pass, 0 fail, 2 skipped**.
- Live acceptance: bot restarted, `/api/perps` shows real mark/equity/profit, dashboard renders correctly, state file intact with no `.tmp` residue, spot book healthy throughout.

---

## 7. Conclusion

Three audit passes have closed every High/Medium finding, with the restart-driven pass catching four defects a static read would have missed: a disabled sleeve reporting zeros, a permanently-cached zero-equity signal, an invisible mark, and a non-atomic write of the main state file. The sleeve now shows accurate live numbers while remaining disabled by default, deploys the entire eligible profit up to a 10% equity safety ceiling, and cannot touch spot base capital.

---

## 8. Follow-up audit (2026-09-21, later) — realized-PnL credit gap

### The question: "realized PnL is $527.57, why only $154.51 deployed?"

That was a **real bug**, not a policy choice. Root cause:

- The equity archive only began **2026-09-20**, but the bot had already been
  trading and banking profit before that date.
- $313.50 of realized PnL was banked **before** the archive's first sample, so it
  was already baked into that sample's equity value.
- Using that raw first sample as the "profit baseline" **silently erased** every
  dollar earned before the archive existed. Equity $10,557 − baseline $10,402.87
  = $154.51, hiding $313.50 of genuinely earned money.

### Fix

Baseline is now **reconstructed to the true trading origin**:
`tradingStartEquity = archiveOriginEquity − realizedBankedBeforeOrigin`.
Live result after restart: baseline $10,089.36, eligible/budget **$477.22**
(recomputed from the whole tape, including pre-archive fills). A regression test
seeds exactly this scenario (pre-archive $300 + post $200) and asserts the full
amount is credited and the baseline is reconstructed.

### Also fixed in this pass

- **Anti-double-deploy (High):** the live sizing path did not subtract margin
  already committed, while the stored path did — a re-entry could over-deploy.
  Both paths now subtract outstanding margin; invariant is test-enforced
  (profit $X, margin $300 ⇒ deployable $X−300, floored at 0).
- **Boot-time 0 equity guard:** `appendEquityArchive` now rejects non-positive
  samples so a transient unsynced balance can never be archived as a fake crash
  or chosen as the baseline.
- **Dashboard floor display:** the tab showed `$0.00` floor while the copy claims
  funding is gated above a floor. It now falls back to the dynamic baseline.

### Verification

- `tsc --noEmit` clean; `npm test` 124 tests, **122 pass, 0 fail, 2 skipped**.
- Live acceptance after restart: `/api/perps` shows floor $10,089.36 =
  baseline, budget $477.22, mark $119.20 live/healthy, dashboard consistent both
  panels. Sleeve still DISABLED; nothing real traded.

### Honest caveat on the number

$477.22 is *eligible*, not automatically deployed. It is still capped by the
10% equity guardrail (~$1,056, not binding here) and by liquid USDC. The
remaining ~$50 difference from the $527.57 tape figure is the still-open grid
inventory's unrealized PnL — realized *banked* cash that has since been rotated
back into grid buys, which is not yet liquid enough to post as margin.

---

## 9. Audit #5 (2026-09-21) — deeper correctness pass

The earlier passes fixed the *displayed* numbers. This pass re-read the sizing
and execution logic line by line and found three bugs that would only bite once
the sleeve was actually armed. All three are now fixed and regression-tested.

### 9.1 Hedge would over-hedge into a net SHORT (High)

`decideSleeveAction` computed the hedge as
`wantMargin = min(budget, gridNetLong * hedgeRatio)` and then deployed it at
`lev = min(maxLeverage, 2)`. But `hedgeRatio` is a **notional** fraction: the
result was a hedge notional of `0.8 * 2 = 1.6x` the grid delta — the book would
flip net-short instead of being neutralized. The tier-2 hedge (the *first*
thing to run once enabled) was dimensionally wrong.

**Fix:** the required margin is `targetNotional / leverage`, so the notional is
exactly `hedgeRatio * delta` and can never exceed the delta. A regression test
asserts `marginUsd * lev == 0.8 * delta` and `< delta`.

### 9.2 `maxMarginUsd = 0` silently zeroed the budget (High)

`computeSleeveBudget` used `Math.min(available, equityCap, Math.max(0, maxMarginUsd))`.
With `maxMarginUsd: 0` (the documented "uncapped" value present in the live
config) this evaluated to a **$0 ceiling**, so that path always returned zero.
`deployableSleeveUsd` handled 0 correctly, so the two disagreeing was a latent
trap for any caller of the fallback path.

**Fix:** `0` now means "no explicit USD ceiling" (bounded by the equity cap),
matching `deployableSleeveUsd`. Regression test added.

### 9.3 Live send failures were swallowed (High — accounting integrity)

`maybeSend()` caught every error and only logged, so a `open`/`close` that
failed to submit still returned `{ ok: true }` and the ledger booked it. The
sleeve could then believe it was hedged while nothing existed on-chain — the
worst failure mode for a risk sleeve.

**Fix:** `maybeSend` now returns `{ sent, error }`; a live send error propagates
and invalidates the open/close. Dry-run/paper still book the built quote
(no send by design), so the dashboard keeps working without `LIVE_ARM`.

### 9.4 `/positions/decrease` used the wrong schema (High — close would fail)

The `close()` payload used `increase`-style fields (`collateralTokenDelta`,
`side`). The live API requires `collateralUsdDelta`, `sizeUsdDelta`,
`desiredMint`, and `positionPubkey` for `decrease` — the old payload returns
`invalid_argument`. **Verified against the live endpoint**: old payload is
rejected, new payload builds. `close()` and its callers now pass the venue's
`positionPubkey`; the type was extended accordingly.

### 9.5 Deviations found (Hardening)

- A full close passes the position's own collateral/notional so the decrease
  withdraws everything — consistent with `close-all` semantics.

### Live verification after the restart

| Field | Value |
|---|---|
| Budget / eligible | $471.47 |
| Baseline / floor | $10,089.36 (dynamic, = floor) |
| Lifetime realized | $527.57 |
| Mark | $117.86 — healthy |
| Equity | $10,560.83 |
| Status | DISABLED, not halted |

The Birdeye quota error now surfaces its real cause ("Compute units usage limit
exceeded"), confirming the `meme.ts` error-detail fix is live. That is a
separate, pre-existing quota issue on the meme strategy's OHLCV refresh — noted
below as out of scope for the perps work but visible on the dashboard.

### Verification

- `tsc --noEmit` clean; `npm test` **126 tests, 124 pass, 0 fail, 2 skipped**.
- Live round-trip probe: `open` + `close` both build valid quotes under
  dry-run (no funds moved).
- Restart clean; `/`, `/api/perps`, `/api/audit` all HTTP 200.

### Outstanding (not perps, but observed)

1. **Birdeye compute-unit quota exhausted** — the meme strategy's OHLCV tick
   logs a 400 every cycle. Either raise the plan tier, back off the poll rate,
   or fall back to a keyless OHLCV source. Doesn't affect the grid/DCA core.
2. **Carry rate is still modeled**, not read from the venue's live rate.
3. **`PERPS_ENABLED` unset** — sleeve remains inert by design.

---

## 10. Data feed: keyless replacement for the dead Birdeye source

The meme strategy had exactly one real candle source — Birdeye's free tier — and
its compute-unit quota is exhausted. Every refresh returned HTTP 400, so the
strategy had **no price, no VWAP, and no admission signal**. A blind strategy
never trades, which *looks* safe but is really just inert.

**Geo/keys research and live test (keyless, no account):**

| Source | Keyless? | OHLCV? | Verdict |
|---|---|---|---|
| Birdeye free | key, quota-limited | yes | **dead** — 400 every call |
| Jupiter quote | keyless (lite) | no (spot only) | 400 on the grid oracle path too |
| DexScreener | keyless | no candles (search/price only) | fallback price only |
| **GeckoTerminal** | **keyless, no quota** | **real hourly OHLCV** | **PRIMARY — works** |

**Implemented:** GeckoTerminal OHLCV is now the primary feed (real price, VWAP,
high/low, volume), with Birdeye demoted to optional enrichment and a success
check. Real pool liquidity + USD 24h volume still gate admission.

**Live result:** CYB price 9.64e-6, VWAP 9.36e-6, pool liq $7,017, 24h vol $11.9
→ `admitted=false` with the honest reason `vol $12 < min $100`. The strategy now
makes a data-backed decision rather than sitting blind. (The pool is genuinely
thin on volume even with real liquidity — that is a real market reading, not an
error.)

## 11. Is the perps setup delta-neutral? — NO, not with current defaults

This is the direct answer, measured from the live book.

The Tier-2 hedge is the first thing that runs once the sleeve is enabled, and its
job is to neutralize the grid's accumulated net-long delta. It does **not** fully
neutralize it, for two independent reasons:

1. **`hedgeRatio = 0.8` deliberately leaves 20% unhedged** (it targets a partial
   offset, not a full one).
2. **The hedge is capped by eligible profit, not by the delta.** Margin is
   `min(budget, delta*ratio/leverage)`. Live: grid net-long is **$5,660 (53.9%
   of equity)** — the spot inventory is far larger than the sleeve's budget.

Live math with defaults (hedgeRatio 0.8, lev 2, budget $401.75):

```
grid net-long delta     $5,660.12
target hedge notional   $4,528.09   (0.8 x delta)
margin needed at 2x     $2,264.05
eligible budget         $401.75      <- the binding cap
actual hedge notional   $803.50
residual long           $4,856.62   (85.8% of the delta stays unhedged)
```

So the sleeve is a **partial, small hedge**, not delta-neutral. The earlier
over-hedge bug is fixed (the hedge can no longer exceed the delta and flip the
book net-short), but neutrality would require far more margin than the profit
budget currently allows.

**Honest framing:** to actually be delta-neutral you must match the notional to
the delta. The knobs are: `hedgeRatio` → 1.0, a larger `maxEquityPct`, higher
`maxLeverage`, or — most importantly — **stop letting the grid accumulate a
$5,660 net-long**. The hedge cannot out-size the underlying book it is hedging,
and the sleeve is funded from profit, which is far smaller than the book.

**Recommendation:** if the goal is a genuinely neutral book, either
(a) cap the grid's net-long accumulation at a fixed % of equity so a
profit-funded hedge can actually cover it, or (b) treat the sleeve as a
*partial* risk-reducer and size it as such. Do not call it delta-neutral while
`hedgeRatio < 1` and the budget is smaller than the delta.

---

## 12. Addendum — is it delta-neutral? (corrected for the new knobs)

Section 11 measured the old defaults. Since then two changes materially shifted
the answer, so re-measuring from the live book:

- `hedgeRatio` now defaults to **1.0** (full intended offset, up from 0.8).
- The hedge has its own leverage knob (`PERPS_HEDGE_LEVERAGE`, default **5**),
  NOT capped by `maxLeverage`. Capping it at 2x made neutrality *arithmetically
  unreachable* for a profit-sized sleeve, because the grid delta is ~$5.6k and
  the eligible budget is ~$390.

Live book (measured):

```
grid net-long delta      $5,646.51   (53.9% of $10,476.68 equity)
eligible budget          $387.32
target hedge notional    $5,646.51   (hedgeRatio 1.0)
margin to full neutral   $1,129.30   (= delta / 5x)
```

**Verdict: still NOT delta-neutral today, and it cannot be** — because the
margin required at 5x ($1,129) is ~3x the profit-funded budget ($387). The
hedge is therefore a *partial* offset:

```
hedge notional if enabled  min($387 * 5, $5,646.51) = $1,936.60  (34% of delta)
residual unhedged long     $3,709.91   (66% of the delta still long)
```

The hedge can never cover a delta larger than itself. The sleeve is
profit-funded, and profit is ~$387 while the grid's accumulated net-long is
~$5.6k. So the honest statements are:

1. The hedge **logic** is now correct (it targets `ratio * delta` notional, and
   can never over-hedge past neutral into a net-short).
2. The **portfolio** is not neutral, and *cannot* be while the grid holds a
   $5.6k delta against a $387 sleeve at any sane leverage. Either raise
   `PERPS_HEDGE_LEVERAGE`, raise `maxEquityPct`, or — the real fix — **stop the
   grid accumulating a delta ~14x the sleeve's capital.**

The dashboard now says this plainly: `hedgeNeutral`, `targetHedgeNotionalUsd`,
`marginToNeutralizeUsd`, `hedgeCoveragePct`. As of this writing `hedgeNeutral =
false` and `hedgeCoveragePct = 0` (no position open, sleeve disabled).

## 12. Making the hedge actually delta-neutral (auto-leveraging the PnL size)

The user requirement is explicit: **delta-neutral the PnL amount into perps** —
i.e. use the profit-funded sleeve to *fully* cancel the grid's net-long delta.

The blocker was arithmetic, not logic. Neutrality needs
`hedge notional >= grid delta`, and margin is `notional / leverage`. With a
profit-sized budget (~$400) and a grid delta of ~$5,650, a *fixed* leverage
cannot cover it:

```
delta                  $5,669
budget                 $421
margin needed at  5x   $1,134   -> 3x the budget, unreachable
margin needed at 13.5x $421     -> exactly the budget  -> reachable
```

**Implemented:** the hedge now **auto-scales its own leverage** to the smallest
value that lets the deployable budget reach the target notional, bounded by
`hedgeLeverage` (floor, default 1) and `hedgeLeverageMax` (ceiling, default 15).
This is deliberately independent of `maxLeverage` (which caps the directional
overlay, not the hedge). If even the ceiling cannot cover the delta, it hedges as
much as the budget allows and reports `partial` instead of pretending to be
neutral.

**Safety:** our hard stop (`stopLossMarginPct`, default 25%) is verified at open
to sit strictly **inside** liquidation (`stopInsideLiquidation`), so a
higher-leverage hedge still self-stops before the venue ever liquidates.

**Verified live:** implied hedge leverage **13.5x < 15x cap** → margin needed
equal to the budget → **neutrality is achievable** the moment
`PERPS_ENABLED=1`. The sleeve stays disabled/inert until then.

**Config knobs (no secrets, clone-safe):** `PERPS_HEDGE_RATIO` (default 1.0),
`PERPS_HEDGE_LEVERAGE` (default 1), `PERPS_HEDGE_LEVERAGE_MAX` (default 15),
`PERPS_HEDGE_TRIGGER_PCT` (default 0.15).

## 13. Data-feed audit — are VWAP / history / perps all real?

Re-audited every price input the grid, DCA, and perps use. All are **live and
real**, sourced keylessly, with no synthetic fallback:

| Consumer | Input | Source | Live value | Status |
|---|---|---|---|---|
| Grid band | vwap / high24h / low24h | GeckoTerminal DEX OHLCV | 114.74 / 122.88 / 111.03 | real |
| Grid spot | price | Jupiter quote (matches venue) | 116.95 | real, 200 OK |
| DCA dip/TP | vwap, peak, avg cost | same oracle | real | real |
| Perps hedge | mark price | Jupiter Perps `/market-stats` | 117.02 | real, healthy |
| Admission | liq / vol24h | GeckoTerminal pools | real | real |

Spot checks: Jupiter quote endpoint returned **200 x5** on direct test; the
latency-sensitive `geckoterminal history failed (timeout)` line was a one-off
transient — the VWAP/high/low are fully populated now. Error-log delta over 45s
**= 0**. The stale `jupiter /quote HTTP 400` line was a transient that never
recurred across repeated 200s.

**Conclusion:** VWAP, history high/low, and the perps mark are all real and
working for grid/DCA/perps. Nothing is fabricated. (CYB meme feed excluded per
user request.)

## 14. "Do we need to delta-neutral the entire bag?" — NO. Hedging the whole bag is the wrong trade.

Correct instinct. The spot net-long is **not accidental risk** — it is the
strategy's directional upside and its working capital. Forcing the perps sleeve
to cancel all of it is actively harmful:

1. **Cost**: borrow/funding is paid on the *notional*, not the margin. Hedging a
   $5,660 book means paying carry on $5,660 every hour, which can exceed the
   grid's spread edge and turn a profitable strategy into a fee-bleeding one.
2. **Fragility**: reaching full neutral at the current PnL budget needs ~13.5x,
   where ordinary SOL noise (1.85% move) stops us out — churn, not safety.
3. **Opportunity cost**: you give up the upside you're running the strategy to
   capture, for no reason if the exposure is within a level you're happy with.

**Implemented — hedge as a TRIM, not a conversion.** New knob
`maxNetExposurePct` (default **0.35**) is the net-long we are *happy to keep*;
the hedge targets only the **excess above it**. `hedgeLeverageMax` default dropped
from 15 to **3** — sane enough that our stop sits 8.3% adverse of mark, far
outside daily noise, and far inside liquidation. If the budget can't fund the
full excess at that leverage, it trims what it can and says `partial` — it never
pretends to be complete.

### Live measurement (as of audit)
```
grid net-long        $5,661   (53.9% of equity)
exposure cap (kept)  35.0%  -> $3,674
trim target (excess) $1,987
budget               $409
margin at 3x         $662  -> budget-bound: trims to ~42% exposure, then stops
```
So out of the box it will *partially* close the gap from 53.9% toward 35%
exposure — deliberately, cheaply, and at a leverage our stop can survive. To
close it fully you'd raise `PERPS_HEDGE_LEVERAGE_MAX` to ~5, at the cost of a
tighter stop (5.1% adverse vs 8.3%). **The cap is the risk control; the sleeve is
a trim, not a market-neutral conversion.**

### Dashboard
Perps tab now shows **Exposure cap (kept)** and **Trim target (excess)** with the
margin it would post, plus `withinExposureCap`. `hedgeNeutral` was removed — it
implied a goal we explicitly do not have.
