# AGENTS.md — guide for AI agents working on GLB

This repo is **GLB (Glacier Boys)**, formerly `grid-lord`: a local-first Solana
SOL/USDC **grid + DCA trading bot** with an optional Jupiter Perps sleeve and
pump.fun meme slots. It runs on the owner's Mac under **launchd
(`com.buzzkillb.glb`)**, serves a local dashboard, and — critically — **it can
trade real funds.** Read this file fully before changing anything.

Other docs: [README.md](README.md) (strategy & config reference) and
[LIVE.md](LIVE.md) (live-arming procedure). This file is about *how to work on
the code safely*, including what to suggest to the owner.

---

## 1. Golden rules (read twice)

1. **Real money.** `TRADE_MODE=live` + `LIVE_ARM=1` sends real swaps. NEVER
   enable either, never "test" with them, never edit `.env` toward live. Paper
   mode (`TRADE_MODE=paper`) never constructs the live broker.
2. **Never touch secrets.** `.env`, `wallet.key`, and everything under
   `.botstate/` are git-ignored on purpose. Never print their contents, never
   paste keys in chat, commits, or logs. `wallet.key` is the owner's to manage.
3. **The bot is probably running right now** under launchd. Restarting it
   (`launchctl kickstart -k gui/$(id -u)/com.buzzkillb.glb`) is a visible
   action on a live system — **ask the owner first**. It is safe to *read*
   state files; writing them while the bot runs will be overwritten or can
   corrupt the ledger (back up to `.botstate/backup/` first if ever needed).
4. **Verify every change**: `npm run check` (tsc, must be 0 errors) and
   `npm test` (all green) before claiming done. Accounting/PnL changes also
   need a test, and dashboard changes need a live screenshot.
5. **Never invent fills, balances, or PnL.** All money math comes from the
   journal (`trades-*.jsonl`) and state files. If a number doesn't reconcile,
   report it — don't patch over it.
6. **Ask before strategy changes.** Sizing, bands, take-profits, leverage and
   guardrails are the owner's risk decisions. Propose, show math, let them
   approve. Code plumbing/UI/tests you can do directly.

## 2. Quick facts

| | |
|---|---|
| Runtime | Node ≥ 20.10 (**≥ 22.12 for `npm start`** — a web3.js dep needs `require()` of ESM) |
| Build | `npm run build` → `dist/`; dev via `tsx` (see `--experimental-detect-module` in scripts) |
| Tests | `npm test` (custom runner `scripts/run-tests.mjs`; ~238 cases in `test/`) |
| Dashboard | `src/server.ts` + `public/index.html` on `PORT` (default 3000) — tabs: Overview, SOL Book, Memes, Perps, History |
| Bot state | `.botstate/` (see §5) — the ledger; treat as source of truth |
| Live process | launchd label `com.buzzkillb.glb`, logs in `.botstate/launchd.log` / `launchd.err.log`, watchdog in `watchdog/` |
| Time | Everything UTC. Money = USDC. Amounts are floats in state but never fabricate them. |
| Repo location | `~/glb` (the `~/Desktop/Projects/trade` path is a symlink; the Mac requires Full Disk Access for launchd to read Desktop paths — hence the TCC/EPERM history) |

## 3. Commands

```bash
npm run check          # tsc --noEmit — run after EVERY edit
npm test               # full test suite (offline; add --live for live tests, gated)
npm run build          # compile to dist/
npm run paper          # run bot in paper mode via tsx (dev loop)
npm start              # run compiled dist/bot.js (uses whatever .env says)
node dryrun-live.mjs   # builds+signs REAL prod swaps with a THROWAWAY keypair, sends nothing
```

Probes under `scripts/` (perp round-trips, smoke tests, close-probes) touch
live APIs — read before running, and never run the ones that need `wallet.key`
without asking.

## 4. Architecture map (src/, one line each)

- **bot.ts** — entry point + main poll loop; wires everything.
- **config.ts** — env parsing/defaults. All knobs live here; many are derived
  at runtime instead of hardcoded (see regime.ts).
- **engine.ts** — per-tick orchestration: price → strategies → risk → journal.
- **broker.ts / paperBroker.ts / liveBroker.ts** — execution abstraction;
  paper never touches chain, live goes through Jupiter.
- **jupiter.ts** — quotes + swap build (SOL/USDC and meme pairs); primary
  price source with exponential backoff.
- **price.ts** — hardened feed: corroborates suspicious prints across keyless
  sources (CoinGecko, Binance, …), sanity-gates single-poll anomalies, auto
  circuit-breaker if all feeds go stale.
- **gridStrategy.ts** — SOL/USDC grid ladder (re-arming levels, re-centering,
  vol-scaled sizing, fee-aware spacing).
- **dcaStrategy.ts** — interval/dip buys + VWAP logic + trailing take-profit.
- **meme.ts** — pump.fun slots (currently CYB): admission gates on real
  volume/liquidity, per-slot loss ceilings, liquidity-decay exits.
- **pumpSwap.ts** — direct PumpSwap AMM fallback when Jupiter routing fails.
- **perpSleeve.ts / perpStrategy.ts** — profit-funded perps sleeve (delta
  hedge policy, tranches, TP). **perpProfit.ts** PnL accounting,
  **perpStore.ts** persistence, **perpBroker.ts** execution,
  **perpPrice.ts** mark pricing.
- **riskGate.ts** — realized hard-stop, unrealized drawdown guard (pause-new-
  buys but keep selling), deployment cap enforcement.
- **sizer.ts** — wallet-derived budgets: every cap is a % of real on-chain
  equity, re-derived on balance changes (no hardcoded dollars).
- **regime.ts** — derives strategy knobs (TP %, trails, perps leverage) from
  live market data each poll. **Don't reintroduce static literals here.**
- **fundingWatch.ts** — perps carry/borrow-rate gauge for the dashboard.
- **journal.ts** — append-only fills ledger (`trades-*.jsonl`); realized PnL
  and fees come from here.
- **history.ts** — daily accounting: per-day net PnL, equity samples
  (`equity-*.jsonl`), and the daily/weekly/monthly % gains vs total bag.
  Bag is `null` until first wallet sync (`walletSyncedAt`) — keep that guard.
- **store.ts** — state persistence (`state-*.json`), atomic-ish writes.
- **wallet.ts** — keypair loading (`wallet.key`), on-chain balances.
- **notify.ts** — events → `.botstate/events.log` (+ optional Telegram).
- **server.ts** — Express API + dashboard. Serves `public/index.html`; API
  endpoints (`/api/state`, `/api/history`, …) are the only way the UI gets
  data — never let the client compute PnL itself.
- **types.ts** — shared types; keep API payloads typed through here.

## 5. State & data files (`.botstate/`)

| File | Meaning |
|---|---|
| `state-live.json` / `state-paper.json` | Full book: lots, orders, realized PnL, budgets, `walletSyncedAt` |
| `trades-live.jsonl` / `trades-paper.jsonl` | Append-only fill journal — the source of truth for PnL math |
| `equity-live.jsonl` / `equity-paper.jsonl` | Periodic equity samples (dashboard curves, daily gains) |
| `perps-live.json` / `perps-paper.json` | Perps sleeve state (position, tranches, funding history) |
| `history-sol.json` | Rolling price history for grid band / regime derivation |
| `events.log` | TP banks, stops, pauses, errors — greppable incident history |
| `backup/` | Timestamped state backups — put any manual copy here |
| `launchd.log` / `launchd.err.log` | stdout/stderr of the launchd-run bot |

The status line in stdout (`SOL <price> | PnL <realized> | open <basket> | order <n> | running`) ticks every ~5s — a frozen line means a stalled bot.

## 6. Conventions

- **Commits**: conventional, scoped, one concern each — match existing style:
  `feat(dashboard): …`, `fix(accounting): …`, `chore: …`. No force-push.
- **Money math**: realized PnL excludes fees, then fees are subtracted
  separately; always state the convention in code comments and dashboards.
- **Dashboard**: single-file `public/index.html` (inline CSS/JS). After edits,
  hard-reload and screenshot; the file has a history of script-tail mangling —
  re-verify the whole file parses (one unterminated string once killed the
  entire script block).
- **Tests** live in `test/*.test.ts`, run by the custom runner; name them
  after behavior (`riskGate.test.ts`, `journal.test.ts`, …). Add one for any
  accounting/sign/fee change — regressions there cost real money.

## 7. Known gotchas & history

- **TCC/EPERM under launchd**: macOS blocks launchd from reading `~/Desktop`,
  so the real checkout is `~/glb` (Desktop path is a symlink). Old EPERM lines
  at the top of `launchd.err.log` are this, already fixed.
- **Post-restart placeholder zeros**: for ~30s after boot the wallet balances
  are zeros until first sync — `history.ts` guards with `walletSyncedAt` and
  serves `bag: null` so % gains can't spike 100x on a restart. Preserve it.
- **Journal pollution**: 6 synthetic rows (`orderId: test-sel…`, 2026-09-28,
  +$298.19 total) live in `trades-live.jsonl`. Real ledger sums exclude them
  by `orderId`; naive `wc`-style sums don't. Don't delete live state casually.
- **`grid SELL: input balance too low`** in the err log is a known benign
  retry, not a bug.
- **Zero-price equity samples**: the equity recorder occasionally logs
  `price: 0` rows when a feed blips; a `price > 0` guard is an open TODO.
- **CYB rows carry $0 realized PnL** in the journal — the meme sleeve is
  fully exited; thin accounting if it's ever re-enabled.

## 8. Verification checklist (any change)

1. `npm run check` → 0 errors.
2. `npm test` → all green.
3. If accounting/journal/PnL related: recompute the affected number by hand
   from `trades-*.jsonl` / `state-*.json` and assert it matches.
4. If dashboard related: restart (with permission) or run paper, `curl` the
   API endpoint, and screenshot the rendered tab — DOM populated, no NaN/"-".
5. If it touched the live bot: confirm the stdout status line ticks again
   post-restart and `events.log` shows no new errors.

## 9. What to suggest (agent idea backlog)

When the owner asks "what should we add or change?", these are current,
evidence-backed candidates — verify each is still relevant before proposing:

1. **Journal hygiene** — archive the 6 `test-sel…` rows out of
   `trades-live.jsonl` (backup first, bot stopped) so every consumer can sum
   naively; also add a regression test that synthetic orderIds can't enter
   the ledger.
2. **Zero-price guard in the equity recorder** — skip `price === 0` samples
   instead of logging near-zero net-worth points that dent daily charts.
3. **Meme-slot accounting** — journal rows for CYB carry $0 realized PnL;
   either record true realized PnL or mark the sleeve `retired` explicitly.
4. **README refresh** — title/branding still says `grid-lord`; could be
   updated to GLB with a link to AGENTS.md.
5. **Perps sleeve review** — position is small (≈1.1x short, ~$385
   collateral, lifetime realized ≈ −$39); worth an economic viability pass
   (fees vs hedge benefit) before scaling.
6. **Config ergonomics** — `.env.example` is 12KB+ of flat keys; grouping by
   strategy with comments (or deriving more in `regime.ts`) would cut
   misconfiguration risk.
7. **Alerting** — Telegram notifications exist; a hard-stop/pause webhook to
   a second channel would close the "silent stall" gap the watchdog can't
   see (it checks liveness, not accounting).
8. **Retention** — `.botstate` jsonl/journals grow unbounded; a compact +
   rotate job (e.g. monthly, keeping daily aggregates) would keep the
   dashboard and audits fast.

When suggesting, always: state the evidence (file/line or ledger number),
the risk if done wrong, and the smallest safe first step.
