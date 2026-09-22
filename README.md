# grid-lord

A local Solana trading bot that buys and sells SOL/USDC using a grid plus a
dollar-cost-averaging (DCA) strategy. It runs on your machine, pulls live
on-chain prices, shows what it is doing on a local dashboard, and by default
trades on paper (simulated) money so you can prove the strategy works before
you let it touch real funds.

Live execution is built in and it does work, but it is deliberately locked
behind a few switches. See [Live trading](LIVE.md) before you ever turn it on.

Licensed under the MIT License. See [LICENSE](LICENSE).

## What it does

The bot runs a loop that reads the price and decides whether to place orders.
There are two strategies:

- **Grid.** It lays a ladder of buy and sell orders around the current price,
  denser near the middle and wider toward the edges. When a buy fills it
  re-arms a sell one step up, and vice versa, so it harvests small moves while
  keeping one order per level. The band is sized from recent on-chain price
  history and from volatility, and it re-centers itself as the price drifts.
- **DCA.** It buys on a regular interval, or early if price dips below the
  rolling VWAP. It also runs a trailing take-profit: once price climbs a set
  percentage above the average cost, it tracks the peak and sells a slice when
  price gives back a set percentage from that peak. This keeps the DCA book
  from giving all its gain back.

Because every swap carries a real network and routing fee, the grid levels are
never spaced tighter than what a full round trip needs to clear fees, and the
DCA refuses to fire a buy so small that the fee would eat the whole gain. A
sell is never opened below the average cost of the lots it was bought from.

There are also safety rails: a hard stop on realized losses, a pause on new
buying if the open position gets too far underwater, a cap on total deployed
capital, and a price sanity gate that rejects a single bad quote so a glitch
cannot trigger a fake fill or re-center the grid on a bogus price.

## Requirements

- Node.js 20.10 or newer (22.12 or newer to run the compiled build with `npm start`, because a dependency of `@solana/web3.js` needs `require()` of ES modules)
- Local npm and network access to the public Solana RPC and Jupiter API

## How pricing works

The price feed uses Jupiter's public Swap API for SOL/USDC. The same quote that
drives the strategy signals is what execution would use, so the price you see
is the price you would get. CoinGecko is used as a fallback if Jupiter is
unreachable. No API key is needed for the SOL book.

For the meme-coin slot the bot primarily uses **GeckoTerminal's public OHLCV
API, which needs no key at all**. An optional free BirdEye key can be supplied
for extra depth, but it is entirely optional, read from an environment variable,
and never committed. See [Secrets and GitHub safety](#secrets-and-github-safety).

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
- **Directional overlay (Tier 3).** A small profit-seeking long, only when
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
once, never inflate the budget. Tests assert a $50 profit against a $100k bag
yields exactly **$50**, and equity below the floor yields **$0**.

Because that PnL is the same profit spot sizing could sweep into grid/DCA, the
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

## Secrets and GitHub safety

This repo is safe to publish. It is built so **no secret can reach a commit**:

- **Nothing secret is tracked.** `.env`, `wallet.key`, and the `.botstate/`
  runtime directory (state, journals, logs) are all git-ignored. A `git ls-files`
  check confirms no `.env`, `.pem`, keypair, or wallet JSON is under version
  control.
- **Only `.env.example` is tracked**, and it carries placeholder/empty values
  only — no real key, no real address.
- **The wallet is a local file path**, never pasted into code or config.
- **The only optional key is BirdEye**, read from `BIRDEYE_API_KEY`; the bot
  works without it via keyless GeckoTerminal, and the value lives only in your
  local `.env`.
- **The base58 strings in the code are public mint addresses**, not secrets
  (e.g. wrapped SOL, USDC). No private key, API secret, or token ever appears in
  source or config.

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
| `RISK_MAX_SINGLE_JUMP_PCT` | `0.05` | Reject a single-poll price move larger than this fraction |
| `SOL_FEE_RESERVE_SOL` | `1.0` | Native SOL held back from sells to cover network fees |
| `PORT` | `3000` | Dashboard port |

The `.env` and `wallet.key` files are git-ignored. Only `.env.example` is
tracked, and it carries no real key. A stale Jupiter URL in a config file is
detected and upgraded automatically, so an old `.env` will not break the bot.

## Live trading

Paper is the default and is the safe way to start. To move real funds, three
things all have to be present: `TRADE_MODE=live`, a real `wallet.key` in the
repo directory, and `LIVE_ARM=1` on the command line when you start it.

Without `LIVE_ARM`, live mode runs in dry-run: it builds and validates the
swaps but never sends them.

```bash
LIVE_ARM=1 npm run paper
```

On Windows PowerShell, set the variable first: `$env:LIVE_ARM="1"; npm run paper`.

The full go-live procedure, including how to fund the wallet (USDC for buys,
native SOL for fees) and a description of every runtime safety gate, is in
[LIVE.md](LIVE.md).

## Scripts

- `npm run build` - compile TypeScript to the `dist/` folder
- `npm run paper` - run the bot (paper by default; add `LIVE_ARM=1` for real)
- `npm run quote` - print a live SOL-to-USDC quote from Jupiter
- `npm run check` - typecheck without emitting
- `npm test` - run the unit/integration tests
- `npm run test:live` - run the env-gated on-chain transaction tests

## Repository layout

- `src/` - all source: strategies, engine, broker, price oracle, store, server
- `test/` - unit and integration tests
- `public/` - the dashboard HTML
- `scripts/` - smoke-test helpers
- `.botstate/` - runtime state and event logs (git-ignored)

### Trade journal and long-memory history

To make the algorithm auditable over months (not just the last week), the bot
writes two small append-only JSONL files under `.botstate/` and never prunes
them:

- `trades-<mode>.jsonl` - one raw fill per line (the full audit tape). The live
  in-memory ledger is capped (~5000 fills), but this file keeps every fill
  forever, so a year of trading is only a few hundred KB.
- `equity-<mode>.jsonl` - coarse equity samples (one every 15 min), so the
  equity curve survives past the ~7-day dashboard ring and long drawdowns stay
  analyzable.

On startup the bot replays that journal to rebuild every daily rollup in
`history-sol.json`, so days the bot was offline (or fills that aged out of the
ledger) are recovered rather than silently lost; offline days are written as
explicit `noData` rows so the dashboard shows `-` instead of a misleading `$0`.

The store also reconciles the SOL cost basis against the trade tape and the
real on-chain balance: SOL that no fill explains (a deposit or manual transfer)
is flagged as *untracked* and valued at market, which keeps the strategy books
summing to the wallet. The **Accounting Audit** panel and `/api/audit` expose
this reconciliation so the bot's reported PnL can be cross-checked against real
wallet movement.

## Tests

The test suite covers the important invariants: asset conservation, the grid
never deploying past its capital cap, the one-order-per-level rule, the
take-profit sell never closing below the cost basis, the price sanity gate,
re-anchor confirmation, the fee reserve, the no-replay rule after a restart,
the 24h window used by the dashboard header, and the perps sleeve's safety
invariants — the stop always sitting inside liquidation, the hedge trimming only
the excess above the exposure cap, and leverage staying bounded by the
market-derived survival bound and failing safe at 1x when data is missing. Run
it with `npm test`.

```bash
npm install
npm test
```

If you changed any TypeScript, run `npm run build` before `npm run paper` or
before running tests against the compiled output.
