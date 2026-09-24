# grid-lord

A local Solana trading bot that buys and sells SOL/USDC using a grid plus a
dollar-cost-averaging (DCA) strategy, with an optional profit-funded Jupiter
Perps sleeve that hedges the spot book's downside. It runs on your machine,
pulls live on-chain prices, shows what it is doing on a local dashboard, and by
default trades on paper (simulated) money so you can prove the strategy works
before you let it touch real funds.

Live execution is built in and it does work, but it is deliberately locked
behind several switches. See [Live trading](LIVE.md) before you ever turn it on.

Licensed under the MIT License. See [LICENSE](LICENSE).

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [How pricing works](#how-pricing-works)
- [Risk and safety rails](#risk-and-safety-rails)
- [Perps sleeve](#perps-sleeve)
- [How grid, DCA, and perps work together](#how-grid-dca-and-perps-work-together)
- [Dashboard and accounting](#dashboard-and-accounting)
- [Secrets and GitHub safety](#secrets-and-github-safety)
- [Setup](#setup)
- [Configuration](#configuration)
- [Live trading](#live-trading)
- [Scripts](#scripts)
- [Repository layout](#repository-layout)
- [Tests](#tests)

## What it does

The bot runs a loop that reads the price and decides whether to place orders.
There are three strategy components:

- **Grid.** It lays a ladder of buy and sell orders around the current price,
  denser near the middle and wider toward the edges. When a buy fills it
  re-arms a sell one step up, and vice versa, so it harvests small moves while
  keeping one order per level. The band is sized from recent on-chain price
  history and from volatility, and it re-centers itself as the price drifts
  (after confirming a drift is real, not a single glitched print).
- **DCA.** It buys on a regular interval, or early if price dips below the
  rolling VWAP. It also runs a trailing take-profit: once price climbs a set
  percentage above the average cost, it tracks the peak and sells a slice when
  price gives back a set percentage from that peak. This keeps the DCA book
  from giving all its gain back.
- **Meme slot (optional).** A self-contained strategy for graduated pump.fun
  tokens (e.g. the bundled `CYB` slot). It admits a token only after real 24h
  volume and pool liquidity clear configured minimums, and exits on a
  liquidity-decay signal. Real data only.

Because every swap carries a real network and routing fee, the grid levels are
never spaced tighter than what a full round trip needs to clear fees, and the
DCA refuses to fire a buy so small that the fee would eat the whole gain. A
sell is never opened below the average cost of the lots it was bought from.

## Requirements

- Node.js 20.10 or newer (22.12 or newer to run the compiled build with
  `npm start`, because a dependency of `@solana/web3.js` needs `require()` of
  ES modules)
- Local npm and network access to the public Solana RPC and Jupiter API

## How pricing works

The SOL/USDC feed uses Jupiter's public Swap API for the quote that drives both
strategy signals and execution, so the price you see is the price you would get.

The feed is **hardened against bad data and venue failures**, because a single
glitched quote can trigger a real crossed-fill or re-center the grid on a fake
price:

- **Jupiter is primary, and it backs off on failure.** Repeated failures open an
  exponential cooldown (capped at ~2 minutes) instead of hammering the endpoint
  and tripping its rate limiter; a probe detects recovery and resets the streak.
- **Bad data is corroborated, never trusted alone.** On a suspicious print the
  bot queries several independent keyless sources (CoinGecko, Binance, Coinbase)
  and commits only a **cross-source corroborated median**. A lone outlier is
  discarded rather than averaged in, and a single unverified number is never
  committed.
- **Suspicious prints are classified, not hard-rejected.** A flat percentage
  reject would freeze the feed during a genuine sharp move. Instead a suspicious
  jump is held pending: if it recurs on the next poll it is promoted to a real
  move, and two corroborating sources commit immediately. Flash glitches are
  still held.

No API key is needed for the SOL book.

For the meme slot the bot primarily uses **GeckoTerminal's public OHLCV API,
which needs no key at all**. An optional free BirdEye key can be supplied for
extra depth, but it is entirely optional, read from an environment variable, and
never committed. See [Secrets and GitHub safety](#secrets-and-github-safety).

## Risk and safety rails

These are built in and need no action beyond configuration:

- **Realized hard-stop** — pauses the whole bot if cumulative realized PnL drops
  below `RISK_HARD_STOP_PCT` of the live position cap. Once latched it stays
  latched until cleared.
- **Unrealized draw-down guard** — pauses *new deployment* (but keeps selling) if
  the open SOL basket is underwater by more than `RISK_UNREALIZED_STOP_PCT` of
  the cap. It **clears and resumes** once the book recovers, so a dip cannot
  permanently freeze new buying; the realized hard-stop remains latched
  separately.
- **Deployment cap** — `RISK_MAX_USDC` bounds total deployed grid + DCA capital.
- **Price sanity gate** — a single-poll anomaly is classified and re-confirmed
  before it is committed (see [How pricing works](#how-pricing-works)).
- **Per-slot loss ceilings** — each meme slot halts accumulation once its
  realized loss breaches `CYB_MAX_LOSS_USD`, ring-fencing a rug so it cannot
  drain the SOL book.
- **Dead-book / exit-liquidity exit** — if a meme's real pool liquidity decays
  past `CYB_LIQ_DECAY_EXIT_PCT` from its peak, the slot defensively sells out.
- **Native-SOL fee floor and reserve** — every live send is gated on the wallet
  holding at least `WALLET_FEE_FLOOR_SOL` native SOL, and the bot never sells the
  wallet below `SOL_FEE_RESERVE_SOL`. It self-funds its own network fees.
- **Auto circuit-breaker** — if all live price feeds stay stale for
  `RISK_MAX_STALE_POLLS`, the kill-switch arms and halts the swap path.
- **Kill-switch and dry-run arming** — live execution requires `TRADE_MODE=live`,
  a real wallet key file, and `LIVE_ARM=1`; without the last, swaps are built and
  validated but never sent.
- **Notifications** — key events (take-profit banks, realized losses, hard stops)
  are appended to `.botstate/events.log`; optional Telegram push via
  `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`.

## Perps sleeve

On top of the spot grid and DCA, the bot has an **isolated perps sleeve** that
uses Jupiter Perps. It is deliberately a *satellite*, not a second strategy:

- **It is funded only by profit.** No principal is ever risked on perps. The
  sleeve computes a dynamic principal floor from the real trading-origin cost
  basis and only spends equity *above* that floor. If the strategy is flat or
  down, the sleeve deploys nothing.
- **It has its own ledger and risk budget.** It never shares `RISK_MAX_USDC`
  with the spot strategies, so a perps loss cannot starve the grid.
- **It is off by default.** Nothing happens until `PERPS_ENABLED=1`.
- **It never liquidates.** Every open is checked against the venue's maintenance
  requirement, and our own stop is asserted to sit far inside liquidation before
  the position is ever sent. A hard stop closes the position first.

### Live execution path

Jupiter Perps is not a submit-to-the-RPC venue. A build reply carries
`requireKeeperSignature: true`, and the **keeper must co-sign and land the
transaction**. The broker therefore signs the user's side locally and then POSTs
the signed bytes to `/transaction/execute`, which returns the real on-chain txid;
the broker confirms that txid before it books anything. This is verified live by
`scripts/perpBrokerAcceptance.ts`, which opens and fully closes a real position
through the bot's own `PerpBroker`.

Two venue rules the broker enforces, both verified against the live API rather
than assumed:

- **Collateral is side-dependent.** A *short* posts USDC as margin; a *long* must
  post the market token itself. The broker picks the mint by side and converts
  the USD size into that token's raw base units.
- **Leverage has a hard floor of 1.1x.** The venue rejects anything lower,
  including exactly 1x, so the fail-safe and the derived number are both clamped
  to a buildable value (`PERP_MIN_LEVERAGE`).

There are two intents, and both are **trims**, never a full conversion:

- **Hedge (Tier 2).** The spot book's net-long is the strategy's directional
  upside, *not* accidental risk. So the hedge does **not** neutralize the whole
  bag. `PERPS_MAX_NET_EXPOSURE_PCT` is the exposure we are happy to keep; the
  hedge targets only the **excess above it**. Hedging the entire book would mean
  paying carry/funding on notional many times the sleeve's size and giving up
  the edge the strategy exists to capture.
- **Directional overlay (Tier 3).** A small profit-seeking position, only when
  enabled.

### Leverage is derived, never hardcoded

There is no "use 5x" anywhere in this repo. The leverage is **computed on every
poll from live state** and is the product of a market-derived survival bound and
three penalties, any of which can only pull the number *down*:

```
survivalBound = stopLossMarginPct / (volMultiplier * vol24RangePct)   # venue volatility
               * exposureFactor    (our bag's concentration vs the exposure cap)
               * momentumFactor    (falling market -> less leverage)
               * liquidityFactor   (thin 24h volume -> less leverage)
```

The survival bound comes from the venue's live 24h high/low: we size so the
position survives an adverse move of `volMultiplier` × the day's range before our
stop fires, so ordinary noise can never shake us out. The bag factor scales down
when our spot net-long is over-concentrated. The momentum and liquidity factors
back off in a falling or thin market. If volatility data is missing the bot
**fails safe at 1x** — it never guesses a big number. Every penalty is surfaced on
the dashboard so the resulting leverage is auditable, not a black box.

Policy inputs (all env-overridable) are shock tolerance and market floors, not
leverage results:

| Setting | Default | What it does |
|---|---|---|
| `PERPS_ENABLED` | `0` | Master switch; sleeve is inert until set to `1` |
| `PERPS_MAX_LEVERAGE` | `0` | Policy ceiling override. `0` = no hardcoded cap; the ceiling is derived from venue volatility |
| `PERPS_LEVERAGE_VOL_MULTIPLIER` | `1.2` | How many 24h ranges of adverse move the position must survive |
| `PERPS_LEVERAGE_MIN_VOLUME_USD` | `10000000` | 24h volume floor; below it leverage is scaled down |
| `PERPS_MAX_NET_EXPOSURE_PCT` | `0.35` | Net-long we keep; the hedge trims only the excess above it |
| `PERPS_HEDGE_LEVERAGE` / `_MAX` | `1` / `3` | Hedge leverage floor and hard ceiling (market model still caps it) |
| `PERPS_STOP_LOSS_MARGIN_PCT` | `0.25` | Hard stop as a fraction of posted margin |
| `PERPS_PROFIT_SHARE_PCT` | `1.0` | Fraction of PnL above the principal floor the sleeve may deploy (the funding source) |
| `PERPS_REALIZED_USE_PCT` | `1.0` | Fraction of banked realized PnL the sleeve may risk; `0` disables that term |
| `PERPS_CASH_USE_PCT` | `1.0` | Physical USDC ceiling on simultaneous margin — limits how much of the PnL is postable; it can never *add* funding |
| `PERPS_USDC_FLOOR_USD` | `USDC_MIN_RESERVE` | Hard USDC floor the sleeve may never spend, so perps cannot drain the spot book's working cash |
| `PERPS_SHORT_ONLY` | `1` | Hard guard: refuse to open a LONG at all — the sleeve only ever shorts |
| `PERPS_OVERLAY_SIDE` | `short` | Direction the Tier-3 overlay takes; a long needs both this `=long` and `PERPS_SHORT_ONLY=0` |

### Funding source: PnL only, and the two books do not double-deploy

The sleeve is funded **exclusively from profit** — equity above the untouchable
principal floor plus banked realized PnL. The raw USDC bag is **not** a funding
source: `PERPS_CASH_USE_PCT` can only *limit* how much of that PnL is postable at
once, never inflate the budget. Tests assert that a small profit against a large
bag yields a budget equal to the profit, and that equity below the floor yields
**$0**.

Because that profit is the same money spot sizing could sweep into grid/DCA, the
engine wires the sleeve's live claim into the spot sizer: `WalletSizer` sizes
against **equity net of the perps claim**, so grid/DCA and perps never deploy one
dollar of profit twice. The claim is derived live from the sleeve's own numbers
(0 when perps is off/flat), so spot sizing is unchanged while perps is disabled.

### Direction: short-only by default

The sleeve **never longs** unless explicitly told to. The hedge is always a short
(it trims net-long spot SOL), and the Tier-3 overlay defaults to `short` with a
hard `PERPS_SHORT_ONLY=1` guard that refuses a long outright. To allow the
overlay to go long you must set **both** `PERPS_OVERLAY_SIDE=long` and
`PERPS_SHORT_ONLY=0` — two deliberate acts, never an accident.

Our hedge is a **short**, and at this venue a short posts **USDC** as margin —
never SOL. So the SOL fee reserve the spot book keeps (so grid/DCA can always
transact) is structurally untouched: closing returns USDC, and the round trip is
USDC → USDC. A *long* (unused here) would post the market token instead.

The real risk was the sleeve eating the spot book's *USDC*, since that is also
what spot spends. That is closed off: `deployableSleeveUsd()` subtracts
`PERPS_USDC_FLOOR_USD` (default: the spot `USDC_MIN_RESERVE`) before sizing, so
only cash **above** the floor is spendable and cash below it deploys nothing.

### Banking the hedge and the take-profit

The hedge is **profit-seeking, not just insurance**. When the downtrend exhausts,
a dynamic take-profit banks the position and closes it, freeing the margin and
realizing the gain. The exit is computed live from venue volatility and momentum
rather than a fixed number:

| Setting | Default | What it does |
|---|---|---|
| `PERPS_HEDGE_TAKE_PROFIT_PCT` | `0.25` | Floor share of posted margin that banks the hedge |
| `PERPS_HEDGE_TAKE_PROFIT_MAX_PCT` | `0.6` | Ceiling the dynamic target may ride to while the downtrend holds |
| `PERPS_HEDGE_TAKE_PROFIT_VOL_FACTOR` | `1.0` | Scales the dynamic target with venue volatility |
| `PERPS_HEDGE_REARM_COOLDOWN_MINUTES` | `30` | Wait after a close before re-arming, so the sleeve cannot churn venue fees re-entering at the same mark |
| `PERPS_HEDGE_REARM_MIN_NEW_EXPOSURE_USD` | `25` | New unhedged exposure (vs. the exposure at the last close) that justifies re-arming **inside** the cooldown. `0` disables early re-arm |

**Post-close gap, explicitly closed.** After a winning hedge banks, the re-arm
cooldown starts. A dip during that window can fill fresh grid/DCA buys that the
closed hedge no longer covers — leaving real inventory unhedged until the clock
lapses. The sleeve therefore records the **hedgeable exposure at the moment of
the close** and re-arms **immediately** when the current exposure exceeds it by
more than `PERPS_HEDGE_REARM_MIN_NEW_EXPOSURE_USD`, i.e. only when genuinely new
unhedged inventory has appeared. Re-entry at the same or lower exposure still
waits, so the fee-churn guard is intact.

Closed positions always unwind reactively against **real inventory**: the
position is reduced when the spot book's net-long actually falls, never on a
guess.

## How grid, DCA, and perps work together

The three components are wired into one system so a crash triggers a single
coordinated response rather than three unrelated reactions:

- **The hedge arms against actual *and* planned accumulation.** The sleeve reads
  the spot book's live net-long and *also* the buys the grid is about to catch
  below the mark (armed levels) plus the next DCA slice. This matters because a
  crash fills those buys *into* the decline; hedging only today's bag would make
  the hedge perpetually lag the dip. The dashboard exposes `plannedAccumUsd` and
  `hedgeableExposureUsd` so the target is auditable.
- **One profit pool, no double-deploy.** The sleeve claims its deployable profit
  before the spot sizer runs, so grid/DCA and perps can never spend the same
  dollar twice.
- **Shared risk gate.** Both books answer to the same pause/halt state and price
  health, so a stale feed or a hard stop stops both.

## Dashboard and accounting

The dashboard at `http://localhost:3000` is a local, read-only view of the bot's
own state (plus `/api/state`, `/api/history`, `/api/audit`, `/api/perps`, and
`/api/perps/ledger`, and `/api/pause` / `/api/resume`).

It exposes:

- **All-in net.** One honest figure: spot realized **net of fees** plus the perps
  sleeve **net of fees and carry**, realized and open, with a grand total and the
  perps contribution broken out so it is never hidden. The per-strategy books
  (grid, DCA, meme, perps) are shown separately beneath it.
- **Perps state.** Hedge active/coverage, sleeve budget, principal floor, peak
  equity and eligible profit, the open position's live net PnL (after borrow and
  funding carry) with a sparkline, planned vs. hedgeable exposure, the live
  dynamic take-profit plan, the re-arm state, and the liquidation buffer.
- **Accounting audit.** `/api/audit` reconciles the recorded trade tape against
  the real on-chain inventory and equity movement, so "the bot reports +$X" can
  be cross-checked against real wallet movement. SOL that no fill explains (a
  deposit or manual transfer) is flagged as *untracked* and valued at market,
  which keeps the strategy books summing to the wallet.

Performance telemetry is measurement-only and windowed (24h / 7d / all-time).

## Secrets and GitHub safety

This repo is safe to publish. It is built so **no secret can reach a commit**:

- **Nothing secret is tracked.** `.env`, `wallet.key`, and the `.botstate/`
  runtime directory (state, journals, logs) are all git-ignored. A `git ls-files`
  check confirms no `.env`, `.pem`, keypair, or wallet JSON is under version
  control.
- **Only `.env.example` is tracked**, and it carries placeholder values only — no
  real key, no real address. The one optional key (`BIRDEYE_API_KEY`) is a
  filler string.
- **The wallet is a local file path**, never pasted into code or config. The
  code never contains your wallet's public key; it reads the keypair from the
  file at `WALLET_KEY_PATH` (default `./wallet.key`) at runtime and derives the
  address from it.
- **No wallet-specific numbers are baked into the code.** The source contains no
  hardcoded balances, PnL, or prices tied to any particular wallet. Numeric
  defaults are policy floors and thresholds; comments that cite a figure are
  clearly illustrative examples, not asserted state. The only literal addresses
  in the source are **public mint addresses** (wrapped SOL, USDC, and the bundled
  meme token), not secrets and not anyone's private key.

Before pushing, verify with:

```bash
git ls-files | grep -iE '\.env$|\.pem$|wallet.*json|keypair'   # expect: nothing
git grep -nE 'sk-|ghp_|AKIA|BEGIN .*PRIVATE KEY' -- . ':!package-lock.json'
git grep -nE '_KEY=|_SECRET=|_TOKEN=' -- .env.example           # placeholders only
```

## Setup

```bash
npm install
npm run build        # compiles the TypeScript
npm run paper        # starts the bot in paper mode
```

Then open the dashboard at http://localhost:3000. You should see the live SOL
price and, as the grid fills, orders and trades appear with timestamps.

To check Jupiter is reachable:

```bash
npm run quote
```

## Configuration

Copy `.env.example` to `.env` and adjust. The bot runs in paper mode with no
other setup and no key. Live mode additionally needs a wallet key file (see
[Live trading](LIVE.md)).

Key settings:

| Setting | Default | What it does |
|---|---|---|
| `TRADE_MODE` | `paper` | `paper` (simulated) or `live` (real swaps) |
| `SOLANA_RPC_URL` | mainnet-beta | Solana RPC endpoint |
| `JUPITER_API_URL` | `api.jup.ag/swap/v2` | Jupiter Swap API base |
| `GRID_LEVELS` | `8` | Number of grid levels |
| `GRID_USDC_PER_LEVEL` | `20` | USDC per grid level |
| `GRID_REANCHOR_MIN` | `240` | Min minutes between re-anchors |
| `GRID_REANCHOR_CONFIRM_POLLS` | `3` | Consecutive polls a drift must persist before re-anchoring |
| `GRID_HISTORY_HOURS` | `48` | Hours of history used to size the band |
| `DCA_INTERVAL_MIN` | `120` | Minutes between DCA buys |
| `DCA_USDC_PER_BUY` | `25` | USDC per DCA buy |
| `DCA_TP_PCT` | `1.0` | Take-profit arms once price is this % above avg cost |
| `DCA_TP_SLICE_PCT` | `50` | % of held SOL banked per take-profit sell |
| `DCA_MIN_BUY_USD` | `15` | Never buy below this notional (fee-aware floor) |
| `RISK_MAX_USDC` | `400` | Hard cap on deployed grid + DCA capital |
| `RISK_HARD_STOP_PCT` | `0.25` | Pause if realized PnL drops this % of the cap |
| `RISK_UNREALIZED_STOP_PCT` | `0.20` | Pause new deployment if the open basket is underwater by this % of the cap |
| `RISK_MAX_SINGLE_JUMP_PCT` | `0.05` | Classify/re-confirm a single-poll price move larger than this fraction |
| `SOL_FEE_RESERVE_SOL` | `1.0` | Native SOL held back from sells to cover network fees |
| `WALLET_AUTO_SIZE` | `true` | Live-only: derive budgets as % of real equity |
| `PORT` | `3000` | Dashboard port |

The perps sleeve has its own full set of settings (see
[Perps sleeve](#perps-sleeve)). Perps remains **off** unless `PERPS_ENABLED=1`.

The `.env` and `wallet.key` files are git-ignored. Only `.env.example` is
tracked, and it carries no real key. A stale Jupiter URL in a config file is
detected and upgraded automatically, so an old `.env` will not break the bot.

## Live trading

Paper is the default and is the safe way to start. To move real funds, three
things all have to be present: `TRADE_MODE=live`, a real `wallet.key`, and
`LIVE_ARM=1`.

Without `LIVE_ARM`, live mode runs in dry-run: it builds and validates the swaps
but never sends them.

```bash
LIVE_ARM=1 npm run paper
```

Full detail, including the funding split, the safety gates, the kill-switch, and
a zero-funds verification path, is in [LIVE.md](LIVE.md).

## Scripts

- `npm run build` - compile TypeScript to the `dist/` folder
- `npm run paper` - run the bot (paper by default; add `LIVE_ARM=1` for real)
- `npm run quote` - print a live SOL-to-USDC quote from Jupiter
- `npm run check` - typecheck without emitting
- `npm test` - run the unit/integration tests
- `npm run test:live` - run the env-gated on-chain transaction tests

`scripts/` also holds focused probes used during development and acceptance,
including the live Perps round-trip (`perpBrokerAcceptance.ts`) and the gated
live smoke test (`liveSmoke.ts`).

## Repository layout

- `src/` - all source: strategies, engine, brokers, price oracle, store, server
- `test/` - unit and integration tests
- `public/` - the dashboard HTML
- `scripts/` - smoke-test and probe helpers
- `.botstate/` - runtime state and event logs (git-ignored)

### Trade journal and long-memory history

To make the algorithm auditable over months (not just the last week), the bot
writes append-only JSONL files under `.botstate/` and never prunes them:

- `trades-<mode>.jsonl` - one raw fill per line (the full audit tape). The live
  in-memory ledger is capped, but this file keeps every fill forever.
- `equity-<mode>.jsonl` - coarse equity samples (one every 15 min), so the equity
  curve survives past the dashboard's rolling ring and long drawdowns stay
  analyzable.

On startup the bot replays that journal to rebuild every daily rollup in
`history-sol.json`, so days the bot was offline (or fills that aged out of the
ledger) are recovered rather than silently lost; offline days are written as
explicit `noData` rows so the dashboard shows `-` instead of a misleading `$0`.

## Tests

The test suite covers the important invariants: asset conservation, the grid
never deploying past its capital cap, the one-order-per-level rule, the
take-profit sell never closing below the cost basis, the price sanity gate and
bad-data corroboration, re-anchor confirmation, the fee reserve, the no-replay
rule after a restart, and the perps sleeve's safety invariants — the stop always
sitting inside liquidation, the hedge trimming only the excess above the exposure
cap, hedging planned accumulation, leverage staying bounded by the
market-derived survival bound and failing safe at 1x when data is missing,
banking the hedge at a dynamic take-profit, the post-close re-arm gap, and the
cross-book claim that stops spot and perps from double-deploying the same profit.

```bash
npm install
npm test
```

If you changed any TypeScript, run `npm run build` before `npm run paper` or
before running tests against the compiled output.
