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
