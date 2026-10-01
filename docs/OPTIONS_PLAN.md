# Options: Status Assessment and Development Plan

Date: 2026-09-21
Scope: `contracts/contracts/Option*.sol`, `contracts/contracts/libs/Black76Lib.sol`, `options-ui/`, and the
cross-product `PortfolioMarginEngine` in the external `collateral-margin` package.

---

## 1. Where we are

The options stack was built in a burst between late March and early April 2026 (commits `3d6261a` through
`776e29d`), received Greek-sign and performance fixes in August 2026 (`bba2a57`, `976b0ea`, `83010d1`), and has
had **no options-specific commits since 2026-08-09**. Everything after that is shared perps/PME work.

What exists today is a **complete-looking, locally-runnable prototype**. Five upgradeable contracts, ~2,800 lines
of Solidity including libs, ~153 Hardhat tests that all run in CI, a local deploy script, and a demo UI. That is
real progress and the shape of the architecture is sound.

It is **not** close to shippable. The gap is not missing features — it is that the three things that make an
options venue actually work (settlement, liquidation, margin) each have a flaw that makes them fail under an
adversary or, in two cases, under normal use.

### Inventory

- `OptionMarketRegistry.sol` (185 lines) — series metadata, lifecycle status, settlement price. **Done.**
- `OptionOrderBook.sol` (346) — tick-bitmap + FIFO CLOB, router-gated writes. **Done, good quality.**
- `OptionMatchingRouter.sol` (341) — validation, TIF, margin gate, match loop, premium/position/IV. **Partial.**
- `OptionMarginEngine.sol` (669) — positions, EWMA IV, stress margin, vault movements, settlement PnL, liquidation. **Partial.**
- `OptionSettlement.sol` (221) — post-expiry observation window, "TWAP", claims. **Prototype only.**
- `libs/Black76Lib.sol` (241) — pricing, Greeks, Newton–Raphson implied vol. **Done.**
- `libs/FixedPointMathLib.sol` (350) — ln/exp/sqrt/normal CDF. **Done.** Note: GPL-3.0 header while the options
  contracts are MIT — resolve before any public deployment.

### Readiness by layer

- Contract logic: **prototype**, see Section 2.
- Unit/integration tests: **good functional coverage**, zero fuzz, zero invariants, zero upgrade tests.
- Local deployment: **works** (`contracts/scripts/deploy-local.ts`, addresses in `config/local.env`).
- Testnet/mainnet deployment: **does not exist**. No Option* entries in `config/dev.env`, `config/prd.env`, or
  `perps-abi/deployments.json`. Options ABIs are not in the `hardhat.config.ts` codegen list, so they are not
  published to `perps-abi` either.
- Indexer: **does not exist**. `indexer/subgraph.yaml` has one data source, `HashPowerPerpsDEX`.
- e2e: **does not exist**. Zero option references under `e2e/`.
- UI: **local demo**. `options-ui/src/wagmi.ts` supports chain 31337 only; no cancel, no settlement, no portfolio
  view; CI runs lint and typecheck but never builds.
- Docs: the original plan (`contracts/docs/clob_options_on_perps_d2fc8c9b.plan.md`) still marks all seven phases
  `pending`, and neither README mentions options as a product.

---

## 2. Critical design and correctness problems

These are ordered by how badly they break the product. Every one was verified against the source.

### 2.1 Settlement lets shorts walk away — the payoff is not zero-sum

`OptionSettlement.claimSettlement` reads `engine.getPosition(_msgSender(), seriesId)`
(`OptionSettlement.sol:154-166`). Only the position holder can trigger their own settlement. Nobody can force a
short to settle.

`OptionMarginEngine.settlePosition` (`OptionMarginEngine.sol:238-267`) pays in-the-money longs **out of the
insurance fund**, and collects from shorts **into the insurance fund** — as two independent, separately triggered
events. Longs are motivated to claim; shorts are motivated never to claim.

The result is that at expiry, longs race to drain the insurance fund, get `BadDebtRecorded` once it is empty, and
shorts simply do not call the function. Worse, once the series is `Settled` there is nothing holding the short's
collateral: `_seriesParams` clamps `tSec` to `1` past expiry (`OptionMarginEngine.sol:626`), which collapses
gamma and vega, so the short's maintenance margin rounds to near-nothing and they withdraw. **The core economic
promise of the venue does not hold.**

This is architectural, not a patch. Settlement has to be push-based (permissionless crank over shorts first,
longs paid from collected proceeds) rather than pull-based per account.

### 2.2 The settlement "TWAP" samples the same oracle round repeatedly

`finalizeSettlement` computes `w.cumulativePrice / w.observationCount` (`OptionSettlement.sol:142`) — an
unweighted mean of however many snapshots happened to be recorded. `recordObservation`
(`OptionSettlement.sol:118-130`) has **no minimum spacing**, so `initiateSettlement` plus two `recordObservation`
calls in a single transaction satisfies the default `minObservations = 3`.

The sharper problem is that observations are taken from `latestRoundData()` at caller-chosen moments rather than
from distinct oracle rounds. The perps staleness window is one hour
(`HashPowerPerpsDEXBase.sol:35`), which implies the hashprice feed publishes on roughly that cadence. Three
observations inside a 30-minute window therefore read **the same oracle round three times**. The current
implementation is not a TWAP that is merely weak — it is a single oracle round divided by three.

That relocates the real risk. Hashprice is BTC price times block reward times blocks per day, divided by network
hashrate inferred from difficulty. Difficulty steps every 2016 blocks and cannot be moved by a trader; BTC/USD is
expensive to move. So the *index* is inherently hard to manipulate — but the *feed* is a single external pusher
(`Lumerin-protocol/hashprice-oracle`, outside this repo) with unknown cadence and unknown signer count, read with
no staleness check at all in settlement (`OptionSettlement.sol:212-216` checks only `answer > 0`, while the margin
engine enforces `MAX_ORACLE_STALENESS`).

The fix is therefore about oracle rounds, not window length: settle from **N distinct round IDs** weighted by
their round timestamps, with the window sized to the actual publish cadence, and reject repeated or non-advancing
rounds. Before designing this, confirm the feed's publish cadence, signer set, and whether the published value is
already smoothed upstream — none of which is determinable from this repo.

### 2.3 Settlement can deadlock permanently

If the window elapses with `observationCount < minObservations`, `finalizeSettlement` reverts with
`InsufficientObservations` and `recordObservation` reverts with `WindowClosed`. `initiateSettlement` reverts with
`AlreadyInitiated`. There is no admin reset and no fallback path. The series is stuck `Active` forever, positions
never settle, and the collateral backing them is never released. One lazy keeper bricks a series.

### 2.4 Trading stays open after expiry at known intrinsic value

`submitOrder` checks only `s.status != Active` (`OptionMatchingRouter.sol:109-110`). Nothing checks
`block.timestamp < s.expiryTs`, and the registry never auto-freezes. Between expiry and whenever someone finishes
the settlement dance (initiate, 30-minute window, finalize) the book is fully open on an option whose payoff is
already known.

It compounds with the `tSec = 1` clamp: selling a deep in-the-money expired option past expiry requires almost no
margin, because the Greeks-based stress margin has decayed to nothing. Free money against any stale resting order.

### 2.5 Self-trading is unrestricted, and implied vol is derived from trades

`_match` never compares `maker.trader` to `ctx.taker` (`OptionMatchingRouter.sol:237-255`). A user can cross their
own orders; premium moves from their vault account to their vault account, and their position nets to zero.

The cost is approximately zero, and the effect is not: `updateIV` (`OptionMarginEngine.sol:344-371`) inverts the
implied vol from the last fill price and feeds it into an EWMA that drives **every account's margin in that
series**. The per-update clamp (`maxIVChangeBps`) only slows this down; the bounds are 1% and 500%. Repeated
free self-trades walk the IV to either extreme — push it up to force liquidations on other shorts, or push it
down to open shorts at a fraction of honest margin.

Perps already ships self-trade prevention (`feat/perps-self-trade-prevention`); options has none.

### 2.6 A resting bid can permanently DoS a series

Buy orders reserve no margin at all (`OptionMatchingRouter.sol:170-175` only reserves when `!p.isBuy`). Premium
is collected at fill time, and `transferPremium` **reverts** when the buyer is short of funds:

```
if (vault.balanceOf(from) < tokenAmount) revert InsufficientCollateral();
```
(`OptionMarginEngine.sol:326-327`)

So: place a resting bid at the top of the book, then withdraw your collateral. `_match` always takes the best
level first, so every subsequent sell order in that series reverts. Only the owner can cancel
(`cancelOrder` checks `o.trader != _msgSender()`), and `cancelSettledOrders` only works once the series is
`Settled`. The series is unsellable until expiry, for the cost of one order.

### 2.7 Reserved margin leaks and is never recoverable

`_releaseProportionalIM` (`OptionMatchingRouter.sol:283-297`):

```
uint256 reserved = _orderReservedIM[makerOrderId];   // current remaining reservation
uint256 release  = reserved * fillSize / originalSize;  // divided by ORIGINAL size
```

The numerator shrinks with each partial fill but the denominator stays at the original order size, so releases
are systematically short. Two fills of half the order release `0.5R` then `0.25R`, leaving `0.25R` reserved. When
`o.remaining == 0` the code does `delete _orderReservedIM[makerOrderId]` **without releasing the residual**, so
`_reservedMargin[user]` stays permanently inflated.

That number is not cosmetic: PME adds it directly to the portfolio requirement
(`PortfolioMarginEngine.sol:384, 423`). Every partially-filled sell order permanently bricks a slice of the
maker's collateral. Market makers are exactly the users who partially fill, so this degrades fastest for the
accounts the venue needs most.

### 2.8 Liquidation is economically irrational, so it will not happen

`liquidate` (`OptionMarginEngine.sol:283-307`) hands the short position to the liquidator and pays a fee of
`liquidationFeeBps` (5%) of the **margin** of the liquidated slice. The liquidator therefore accepts an unbounded
liability in exchange for a fee sized off a Greeks-based stress number.

For the case that matters — a deep in-the-money short that actually needs liquidating — the option's liability
far exceeds its stress margin, so the fee is nowhere near compensation. No rational liquidator calls this. There
is also no check that the liquidator can support the inherited short, and `_updatePosition` on the liquidator can
revert on `MaxSeriesExceeded`.

Perps settles liquidations against the oracle; options tries to transfer the position. These need to be the same
mechanism.

### 2.9 Two margin models that disagree

The engine has its own `MarginConfig` with an acknowledged duplicate-ownership comment
(`OptionMarginEngine.sol:44-49`), and `computeAccountIM`/`computeAccountMM` sum **standalone per-series** margin
with longs skipped entirely (`OptionMarginEngine.sol:580-594`). Meanwhile, the number that actually gates trading
is PME's: `canPlaceOrder` and `_isHealthy` call `portfolioMargin.computePortfolioIM/MM`
(`OptionMarginEngine.sol:400-403, 569-571`), which nets `getNetGreeks` across all series.

Two consequences:

- The engine's own IM/MM views are effectively dead code that reports a different (much more conservative) number
  than the one enforced. Anything reading them — the UI does — is lying to users.
- PME nets delta, gamma and vega into **three scalars** across all strikes and all expiries and applies a single
  spot/vol shock. Vega is not fungible across tenors, and a single shock cannot see strike-specific convexity. A
  short butterfly or a calendar spread can net to near-zero Greeks while carrying real pin risk, and would be
  margined at approximately nothing. The original design
  (`contracts/docs/OPTIONS_DESIGN.md`) called for full revaluation under a scenario grid; the implementation is a
  Taylor approximation on netted Greeks, which is strictly weaker.

Also note `canPlaceOrder` and `_isHealthy` revert outright if `portfolioMargin` is unset — there is no
zero-address guard, unlike the careful dependency validation on the perps side
(`HashPowerPerpsDEXBase.sol:309-329`).

### 2.10 Implied vol has no surface

Per-series IV is a single scalar seeded from `initialIV` at series creation and thereafter inverted from trade
prices. There is no skew, no term structure, and no admin or oracle-published surface — the `RiskOracle` from the
design doc was never built. A newly listed series with no trades carries whatever IV the admin typed in, and a
thin far-out-of-the-money series is the cheapest place to attack the margin of the whole account.

### 2.11 Smaller items

- No `Pausable` and no `ReentrancyGuard` anywhere in the options stack, despite external vault calls in
  `transferPremium`, `settlePosition` and `liquidate`.
- `OrderMatched` always emits `takerOrderId = 0` (`OptionMatchingRouter.sol:279`) — an indexer cannot reconstruct
  the taker side.
- `updateIV` uses only the last fill of a multi-level sweep (`OptionMatchingRouter.sol:156-160`); intermediate
  fills at other prices are ignored.
- IOC remainders are discarded with no event.
- `OptionOrderBook` stores `postOnly`/`reduceOnly` but never enforces them, and never consults series status —
  entirely dependent on the router being the only writer.
- Dead storage: `_collateral` (`OptionMarginEngine.sol:107`), `getPerpCollateral` hardcoded to `0`
  (`:545-547`), deprecated insurance slot (`:120-121`).
- No maker/taker fee anywhere — there is no revenue model in the contracts.

---

## 3. Cross-product consistency, and what the index actually is

Two constraints came out of comparing the options code against perps, futures and the wider market. Both change
the recommendations in Section 5.

### 3.1 Perps already solved three of these problems; options diverged from it

- **Liquidation.** Perps close the position at the oracle mark and pay the liquidator a bounded fee out of the
  liquidated account (`HashPowerPerpsDEXBase._doLiquidatePosition`, `_chargeLiquidationFee`). The liquidator never
  inherits a position. There is an over-liquidation guard enforcing that a partial close lands in the `[MM, IM]`
  band (`HashPowerPerpsDEX._revertIfOverLiquidated`) and an orders-first gate (`OrdersStillOpen`). Options does
  none of this and instead transfers the short to the liquidator.
- **Self-trade prevention.** Perps nets a self-cross out with no fill, no fee and no position change
  (`HashPowerPerpsDEXBase._netSelfCross`). Options has nothing.
- **Resting-order margin.** Perps expose `getRiskView` returning `buyOrderDelta`, `sellOrderDelta`,
  `buyOrderFillLoss` and `sellOrderFillLoss`, and PME stresses the post-fill delta endpoints and adds worst-case
  fill loss. Options reserves standalone per-order IM which PME then adds as a flat, unstressed `optionsReserved`
  term. The perps model is strictly better and options should expose an equivalent view instead.

A large part of Phases 2 and 3 is therefore porting existing, tested perps logic rather than designing new
mechanisms.

### 3.2 Futures already set an expiry-settlement precedent, and it is a single oracle read

`HashPowerFutures` (external `futures-marketplace` repo) cash-settles at expiry by pinning one oracle mark via
`settlePosition`, after which `settlementPrice(expirationAt)` is frozen and PME drops the leg's delta while
keeping its PnL marked at that frozen price. There is no TWAP. Note that
`docs/trading-limitations-analysis.md:283` claims futures use "Cash TWAP at expiry" — that contradicts both
`:166` in the same document and the keeper integration tests, and should be corrected.

This matters more than it first appears. Perps mark to the oracle with no smoothing
(`HashPowerPerpsDEXBase._marketPrice`), futures settle to a single oracle read, and PME nets option delta and
linear delta into **one scalar** (`PortfolioMarginEngine._marginInputs:379-384`). If options settled to a
multi-day average while the other two venues track spot, then during the averaging window the option's effective
delta decays toward zero while the perp's does not, and PME's netted number would be arithmetically wrong at
exactly the moment it matters most — a hedged account could be liquidated through no action of its own. **Any
change to the options settlement reference must be made jointly with futures, or not at all.**

### 3.3 Benchmarks: the margin model is the weakest link

PME's `_worstStressLoss` is an analytic Taylor expansion on three netted scalars —
`gammaTerm - |deltaPnl| - |vegaPnl|` — at a single shock size, defaulting to 10%/5% spot and 10/5 vol points. The
natspec describes it as a "4-scenario stress test"; there is no scenario loop.

No production venue margins options this way. Deribit runs 27 scenarios plus an extended tail table, Aevo 15,
Derive 23, all with full revaluation of each leg. All three additionally carry patches that exist specifically
because the grid alone was not enough:

- a per-naked-short absolute floor (Aevo's Floor Margin, Derive's 2% option contingency), because netting drives
  a butterfly's margin to zero;
- a per-expiry forward/basis contingency (Derive evaluates each expiry at 1.05x and 0.95x separately; Deribit adds
  a Roll Shock), because a uniform shock is structurally blind to calendar risk;
- a far-tail table (Deribit evaluates -66% to +500%), because a +/-15% grid values a far-OTM short at zero.

Netted Greeks under a single shock miss all three by construction. Deribit and Derive also scale the vol shock by
time to expiry, since short-dated implied vol moves far more than long-dated; PME applies a flat vol point shock.

### 3.4 There is no precedent for portfolio margin on a non-tradeable index

Every production system found for options or derivatives on a non-tradeable index is fully collateralized,
capped-payoff, or margined at a flat percentage of notional:

- Oiler's Pitch Lake (options on Ethereum base fee): vault-based, LPs collectively short, fully collateralized,
  no margin engine and no liquidation engine. Strike and reserve price are computed by a verifiable model because
  there is no market price to discipline them.
- Oiler v1 (hashrate options via difficulty): binary cash-or-nothing, 1 USDC locked per contract.
- Alkimiya Silica (hashrate): fully collateralized ERC-1155 positions.
- Luxor / Bitnomial hashrate futures: flat 18% (BTC-denominated) to 35% (USD) initial margin, not risk-based.

The reason is structural. Hashprice cannot be delivered or arbitraged, so no-arbitrage does not pin option
prices, the implied vol surface is a modelled object rather than an observable, and market makers who cannot
delta-hedge will demand a large risk premium. Whoever publishes the vol surface effectively sets everyone's
margin. This does not make uncapped portfolio margin impossible, but it means the model cannot be ported from
Derive and must be treated as novel, with a higher initial-margin factor and a larger insurance fund than a
BTC-options venue would need.

One clarification on terminology, since it has caused confusion: **capped versus uncapped is a property of the
instrument's payoff, not of collateral custody.** A capped instrument is one whose maximum loss is known at
trade time — a call spread rather than a naked call. Shared collateral across perps, futures and options is
preserved in every option below; it is already the architecture (one `CollateralVault`, one `PortfolioMarginEngine`
netting all three). What capping changes is that the margin requirement for a short leg has a hard ceiling that no
model error can exceed, which removes the deep-ITM liquidation problem entirely. Capped instruments can still be
portfolio-margined and still net against perps — only *full escrow* would remove a position from the shared pool,
and that is a separate and stronger choice.

## 4. The honest summary

The order book is good. The math library is good. The registry is fine. The problems are concentrated in
settlement, liquidation and the margin/IV loop — which is to say, in everything that distinguishes an options
venue from a generic CLOB.

Three of these (2.1, 2.2, 2.8) are not bugs to patch but mechanisms to redesign. My estimate is that reaching a
testnet-credible state is **8–12 weeks of contract work** before audit, not a fix-list sprint. The remaining
infrastructure (indexer, e2e, testnet deploy, UI) is another 4–6 weeks and can run partly in parallel.

The single biggest decision to make before writing any code is **2.1**: whether to keep bilateral cash settlement
(which requires push-based settlement plus a real backstop) or switch to a socialized-loss/clearing model where
the protocol is counterparty to every trade. That choice determines the shape of Phases 1 and 3 below.

---

## 5. Development plan

### Phase 0 — Decide and freeze the model (1 week, no code)

First, answer two factual questions about the hashprice feed, because three of the decisions below depend on
them and neither is determinable from this repo:

- **What is the oracle's publish cadence and signer set?** The external `Lumerin-protocol/hashprice-oracle` feed
  at `0x614dCAfa33AF0705C7b4A37667eF511F400F36d0` (prd) is the single source for all three venues. A one-hour
  staleness window implies roughly hourly rounds, which caps how many independent samples any settlement window
  can collect.
- **Is the published value already smoothed upstream?** If the feed already publishes a rolling average, the
  settlement-window design is largely moot and the current approach is closer to correct than it looks.

Then resolve, write down, and get sign-off on:

1. **Instrument scope.** Uncapped naked shorts under portfolio margin, versus capped structures (spreads) whose
   maximum loss is known at trade time, versus a flat percentage-of-notional requirement. All three keep shared
   collateral and cross-product netting; see 3.4. This is the decision that determines whether Phases 1 and 3 need
   a scenario grid and an auction engine at all.
2. **Settlement price reference.** Must be decided jointly with futures (see 3.2). The recommendation is to keep
   options consistent with futures — an oracle-derived point or short window — and to fix the *sampling*
   (distinct round IDs, time-weighted by round timestamp, staleness-checked) rather than lengthen the window.
   Lengthening the window in options alone would break PME's netting during the averaging period.
3. **Settlement mechanics.** Push-based permissionless crank over shorts first with longs paid from proceeds,
   versus a clearing model with socialized loss. Pull-based per-account claiming is not viable either way (2.1).
4. **Liquidation model.** Recommend porting the perps model: oracle-settled partial close-out at a model price,
   liquidator paid a bounded fee and never inheriting the position, with the `[MM, IM]` band guard. If uncapped
   shorts are in scope, a whole-portfolio Dutch auction (Derive's model) is the only approach found that makes
   liquidating a deep-ITM short reliably profitable.
5. **IV source.** Admin/oracle-published surface (ATM + skew + term) as the design doc intended, versus keeping
   trade-derived EWMA with hard guardrails. Trade-derived vol on an open CLOB is a standing manipulation surface
   (2.5), and on a non-arbitrageable index there is no external market to discipline it (3.4). Recommend the
   surface, published with an explicit confidence value that raises initial margin rather than halting trading.
6. **Margin model.** Keep the netted-Greeks Taylor approximation, or move PME to a scenario grid with full
   revaluation of option legs. Recommend the grid, plus the three standard patches from 3.3 (naked-short floor,
   per-expiry basis contingency, far-tail scenarios) and a time-scaled vol shock. Note that a perp-versus-index
   basis contingency needs to be sized well above Derive's 3%, since nobody can force convergence on hashprice.
7. **Fee model.** Maker/taker fees, settlement fee, insurance fund funding source. Options currently has no fee
   of any kind, so there is no revenue model and no organic way to fund the backstop.

Deliverable: `docs/OPTIONS_SPEC.md` with the chosen mechanisms and worked margin examples (short call, short
strangle, calendar, covered hedge, and a perp-hedged option position), replacing the stale
`contracts/docs/clob_options_on_perps_d2fc8c9b.plan.md`.

### Phase 1 — Settlement rebuild (2–3 weeks)

- Replace pull-based `claimSettlement` with a permissionless, batched, push-based crank: settle shorts first,
  credit longs from collected proceeds, then draw on the backstop only for the residual.
- Add series auto-expiry: reject `submitOrder` when `block.timestamp >= s.expiryTs` in
  `OptionMatchingRouter`, and add an `Expired` status (or an expiry check in `OptionMarketRegistry.isActive`) so
  the book closes automatically rather than by owner action.
- Make the book cancellable post-expiry by anyone — extend `cancelSettledOrders` to `Expired`, or add a
  permissionless sweep so reserved margin is freed without the series being settled first.
- Fix settlement sampling: require N **distinct, advancing oracle round IDs**, weight each by its round
  timestamp rather than counting calls, and add staleness validation to `_readOraclePrice`. Implement the
  accumulator as a cumulative `price * elapsed` aggregate (Derive's `LyraForwardFeed` pattern) so window length
  costs O(1) storage. Keep the window consistent with whatever futures settles to (3.2).
- Break the deadlock in 2.3: allow the window to extend or to be re-initiated when it closes short of
  `minObservations`, and add an owner-guarded fallback price with a timelock.
- Remove the `tSec = 1` clamp so post-expiry margin does not evaporate; margin past expiry should be intrinsic
  value, not a decayed Greeks number.

Tests: puts and calls, in/at/out of the money, shorts with insufficient collateral, backstop exhaustion, window
liveness edge cases, settle-twice, settle-with-open-orders.

### Phase 2 — Order book and router hardening (1–2 weeks)

- Self-trade prevention in `_match`, porting the perps net-out policy verbatim
  (`HashPowerPerpsDEXBase._netSelfCross`: cancel the overlapping size against the taker's own resting order, no
  fill, no fee, no position change, no IV update).
- Fix the reserved-margin leak in `_releaseProportionalIM`: track released-so-far explicitly, and release the
  exact residual when the order closes.
- Buy-side collateral: either reserve premium at order placement, or make an unfundable maker bid skip-and-cancel
  inside `_match` instead of reverting the taker's transaction. Skip-and-cancel is simpler and kills 2.6.
- Bound the match loop with a `maxFills` parameter, as perps already does, and return the unfilled remainder.
- Emit the taker order id in `OrderMatched`; emit an event for discarded IOC remainder.
- Add `Pausable` to router, engine and settlement; add `ReentrancyGuard` around vault-touching paths.
- Add a zero-address/dependency validation guard on `setPortfolioMargin` and `setSettlement`, matching
  `HashPowerPerpsDEXBase._requireVaultPin`.

### Phase 3 — Margin, IV and liquidation (3–4 weeks)

- Implement the Phase 0 IV decision. If a surface: a `RiskOracle` publishing ATM vol, skew and term slope per
  underlying with staleness bounds, and per-series interpolation in the engine. Keep trade-derived IV as a
  monitored signal, not a margin input.
- Collapse the duplicate margin model: delete or clearly deprecate `computeAccountIM`/`computeAccountMM` on the
  engine, or make them thin views over the PME result so the UI cannot display a number that is not enforced.
- Implement the Phase 0 margin decision in PME. If a scenario grid: revalue option legs under each
  (spot, vol) node rather than netting Greeks, and add a short-option floor and a per-strike concentration
  add-on.
- Replace standalone `computeOrderIM` reservation with a `getRiskView`-style interface so PME can stress option
  resting orders the way it already stresses perps orders (post-fill delta endpoints plus worst-case fill loss)
  instead of adding a flat, unstressed `optionsReserved` term. This also removes the leak in 2.7 by construction,
  since there is no per-order reservation ledger to drift.
- Rewrite liquidation as oracle-settled partial close-out against the insurance fund, consistent with
  `HashPowerPerpsDEX.liquidatePosition`, with a fee bounded by the actual deficit rather than a fraction of stress
  margin, and port `_revertIfOverLiquidated` so partial closes land in the `[MM, IM]` band. If uncapped shorts are
  in scope, this becomes a whole-portfolio Dutch auction instead, with a liquidator-supplied worst-case scenario
  id to keep gas bounded.
- Cross-venue: extend `crossVenueLiquidation.test.ts` to cover a mixed perp + option portfolio against the real
  `HashPowerPerpsDEX`, not `PerpsDEXMock`.
- Coordinate with the `collateral-margin` repo — PME is an external dependency and these changes span both.

### Phase 4 — Test depth (2 weeks, overlaps Phase 3)

- Foundry fuzz on `Black76Lib` (put-call parity, Greek signs and monotonicity, IV solver convergence at extreme
  moneyness and near expiry) and on the matching loop.
- Invariants: sum of positions per series is zero; sum of vault balances plus insurance fund is conserved across
  fill/settle/liquidate; `_reservedMargin` equals the sum of live order reservations; no account can end a
  transaction below maintenance margin except via liquidation.
- UUPS upgrade smoke tests for all five proxies (currently zero).
- Gas assertions with real thresholds on `gas-optionGreeks.test.ts` — it currently logs without asserting — plus
  a multi-series Greeks benchmark at `maxSeriesPerUser = 20`.

### Phase 5 — Infrastructure (3–4 weeks, parallelizable)

- **Deploy**: `contracts/scripts/deploy-options.ts` for base-sepolia, wired into the existing Safe upgrade flow
  from `feat/perps-safe-upgrade`. Populate `config/dev.env` and `perps-abi/deployments.json`.
- **ABIs**: add the five Option* contracts to the `hardhat.config.ts` codegen list so `perps-abi` publishes them.
- **Indexer**: options data sources in `indexer/subgraph.yaml`; entities for series, orders, trades, positions,
  IV history, settlement windows; handlers following the existing perps `getOrCreate*` pattern. Requires the
  taker-order-id event fix from Phase 2.
- **e2e**: an options flow test in `e2e/` reusing `deployLocalFullStackFixture` — place, match, partially fill,
  cancel, expire, settle — asserting both chain state and subgraph output.
- **UI**: testnet chain config, cancel orders, settlement/claim view, portfolio and Greeks view backed by the
  PME number rather than the engine's; add a build step to `options-ui-checks.yml`.

### Phase 6 — Pre-launch (ongoing)

- Resolve the GPL-3.0 / MIT license conflict in `libs/FixedPointMathLib.sol`.
- Anti-spam for the options book — the analysis in `contracts/docs/ANTI_SPAM_DESIGN.md` is perps-specific, and
  options currently has no price-level cap and no per-user order cap, only `maxSeriesPerUser = 20`.
- External audit, scoped to include the `collateral-margin` PME changes.
- Update both READMEs and the design docs to reflect what was actually built.

---

## 6. Suggested sequencing

Phase 0 gates everything. Phase 2 is independent of the Phase 0 decisions and is the best place to start coding
in parallel — it is well-defined, self-contained, and removes two of the cheapest attacks (2.5, 2.6) plus the
worst normal-use bug (2.7). Phases 1 and 3 are the heavy lifts and both need the spec first. Phase 5 can begin
once Phase 2 lands the event-schema changes the indexer depends on.
