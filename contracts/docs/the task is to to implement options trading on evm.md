<img src="https://r2cdn.perplexity.ai/pplx-full-logo-primary-dark%402x.png" style="height:64px;margin-right:32px"/>

# the task is to to implement options trading on evm blockchain, specifically options on futures. could you overview how options work? difference between spot options and futures options and how usually options are implemented onchain

Here is a comprehensive overview of options fundamentals, the spot-vs-futures distinction, and how they are implemented on-chain—relevant to your goal of building options on futures on EVM.

***

## Options Fundamentals

An option gives the buyer the **right, but not the obligation**, to buy (call) or sell (put) an underlying asset at a predetermined **strike price** on or before an **expiry date**. The buyer pays an upfront **premium** to the seller (writer), who takes on the obligation and open-ended risk.[^1_1][^1_2]

Key option styles affecting exercise:

- **European** — exercised only at expiry; standard for most DeFi and crypto options[^1_2]
- **American** — exercised any time before expiry; more flexible but harder to price[^1_2]
- **Cash-settled** — PnL paid in stablecoins at expiry (most common on-chain)
- **Asset-settled** — physical delivery of the underlying

The price (premium) is driven by five factors: spot price, strike price, time to expiry, implied volatility, and interest rates — captured by the **Greeks**: Delta (Δ), Gamma (Γ), Vega (ν), and Theta (Θ).[^1_3]


| Greek | Futures | Options |
| :-- | :-- | :-- |
| **Delta (Δ)** | ±1 per contract (constant) | 0 to ±1, changes with spot |
| **Gamma (Γ)** | 0 | Non-zero; accelerates Δ near ATM |
| **Vega (ν)** | 0 | Sensitivity to implied volatility |
| **Theta (Θ)** | 0 | Time decay, erodes premium daily |


***

## Spot Options vs. Futures Options

The critical difference is what the option settles *into* upon exercise.[^1_4]


| Dimension | Spot Options | Futures Options |
| :-- | :-- | :-- |
| **Underlying** | The spot asset (e.g. ETH itself) | A futures contract on ETH |
| **Exercise outcome** | Deliver/receive the asset or cash equivalent | Take a long/short position in the futures contract |
| **Pricing reference** | Spot price | Futures mark price (includes basis/carry) |
| **Leverage** | Generally none (unless collateralized) | Inherent leverage from the futures |
| **Expiry coupling** | Independent of any other contract | Option expiry must align with or precede futures expiry |
| **Settlement** | At spot price at expiry | At futures settlement price |
| **Margin behavior** | Reg-T style (premium upfront) | SPAN/portfolio-margin style — stress-tested positions [^1_5] |

With futures options, exercise produces a **futures position, not the asset**. A call exercised ITM gives the holder a long futures position at the strike price; they can then immediately close it at the prevailing futures mark price for profit. This also means a futures options system needs a **functioning futures margin engine underneath** — the option layer is literally a second derivative.[^1_4][^1_1]

Additionally, different option expiries can map to *different* futures contract months. For example in crude oil, options expiring in March might settle into the April futures, while options expiring in June settle into the July futures. You need to explicitly model this expiry-to-underlying mapping.[^1_6]

***

## On-Chain Implementation Patterns

Four major architectural patterns exist in DeFi options today:[^1_7][^1_2]

### 1. Infrastructure / Settlement Layer

Protocols like **Opyn** and **Opium** create tokenized option contracts (ERC-20 oTokens) representing fully collateralized positions. Key mechanics:[^1_2]

- Writer locks collateral → mints option tokens
- Buyer purchases tokens; token = the option itself
- At expiry, a Chainlink or similar oracle reads the settlement price
- Buyer redeems tokens for payout; redemption is usually manual

This is the most common base layer pattern — it separates *creation* from *trading* (OTC/auction handles price discovery).

### 2. AMM-Based Options (Pool-to-Peer)

Protocols like **Hegic**, **Lyra/Derive**, and **Premia** replace order books with liquidity pools:[^1_8]

- LPs deposit stablecoins as collateral into market maker vaults (MMVs)
- The AMM acts as sole counterparty for all buyers
- Pricing is either **rate-based** (Hegic — uses historical vol, simpler) or **Black-Scholes-style** with an on-chain implied volatility surface (Lyra)[^1_8]
- Lyra hedges LP delta exposure via perps (GMX/Synthetix) to stay delta-neutral[^1_9]

The problem: full Black-Scholes on-chain is expensive — `log`, `exp`, and the normal CDF cost 30–50k gas per strike. Most protocols **pre-compute weights off-chain and feed them via oracle or calldata**.[^1_3]

### 3. Order Book + Off-Chain Matching

Protocols like **AEVO** and **Zeta** run matching engines off-chain (or on fast L2s) and use the chain only for settlement:[^1_2]

- Off-chain CLOB handles price discovery and matching
- On-chain contract handles collateral custody, margin, and final settlement
- Requires trust in the sequencer/matching engine, but achieves near-CEX UX


### 4. AMM-Powered (Uniswap-Native)

**Panoptic** re-interprets Uniswap V3 LP positions as options, since concentrated liquidity has an options-like payoff. This elegantly reuses existing liquidity but offers a payoff structure closer to linear than a vanilla option.[^1_2]

***

## Key Smart Contract Architecture for Futures Options

For your specific case — **options on futures on EVM** — the core contract modules you'll need:

1. **Futures contract registry** — tracks open futures positions by account, mark price, funding, PnL
2. **Option contract** — stores `(strike, expiry, optionType, underlyingFuturesId, premium, writer, buyer, exercised)`; very similar to Chainlink's reference pattern[^1_10]
3. **Oracle module** — Chainlink feed (or TWAP) for both spot and futures mark price; used at exercise and for margin checks
4. **Margin / collateral engine** — writers must post collateral; for futures options this must be SPAN-style (stress-test spot × vol shocks) rather than simple premium collection[^1_5][^1_3]
5. **Exercise / settlement logic** — on exercise, instead of delivering an asset, the contract opens a futures position in the futures registry for the option buyer at the strike price, then cash-settles the difference vs. mark price
6. **Greeks-aware liquidation** — because gamma can spike sharply near ATM and expiry, margin requirements must be dynamic, not static[^1_3]

The biggest on-chain challenge specific to futures options is that **your margin engine must track both the futures PnL and the options Greeks simultaneously** — a short call on a futures position can go deeply negative very fast if the futures price spikes, and a naive margin model will miss this.[^1_3]

The current state-of-the-art approach is to **compute full SPAN-style margin weights off-chain, commit them to the contract via a signed oracle update, and use on-chain lookup tables** — saving the 30–50k gas of on-chain Black-Scholes while maintaining acceptable precision.[^1_3]
<span style="display:none">[^1_11][^1_12][^1_13][^1_14][^1_15][^1_16][^1_17][^1_18][^1_19][^1_20][^1_21][^1_22][^1_23][^1_24][^1_25][^1_26][^1_27][^1_28][^1_29][^1_30]</span>

<div align="center">⁂</div>

[^1_1]: https://www.tastylive.com/concepts-strategies/futures-options

[^1_2]: https://threesigma.xyz/blog/options/defi-options-landscape-guide

[^1_3]: https://mixbytes.io/blog/deep-dive-into-defi-derivatives

[^1_4]: https://www.investopedia.com/terms/o/options-on-futures.asp

[^1_5]: https://www.schwab.com/learn/story/trying-out-futures-options-here-are-key-differences-vs-equities

[^1_6]: https://tastytrade.com/learn/trading-products/futures/what-are-futures-options-how-to-trade-them/

[^1_7]: https://www.p2v.ventures/blog/designing-on-chain-options

[^1_8]: https://arxiv.org/html/2512.20190v1

[^1_9]: https://blog.synthetix.io/lyra-finance-the-leading-onchain-options-protocol/

[^1_10]: https://blog.chain.link/defi-call-option-exchange-in-solidity/

[^1_11]: https://www.youtube.com/watch?v=1gkNySo6tJQ

[^1_12]: https://nextrope.com/services/defi-protocol

[^1_13]: https://www.metrotrade.com/spot-vs-futures-markets/

[^1_14]: https://coinmarketcap.com/academy/article/crypto-options-vs-crypto-futures-what-s-the-difference

[^1_15]: https://www.metrotrade.com/futures-contract-expiration-explained/

[^1_16]: https://finance.yahoo.com/news/differences-spot-vs-futures-trading-000907922.html

[^1_17]: https://www.kucoin.com/learn/kucoin-guide/crypto-futures-vs-options-trading-similarities-and-differences

[^1_18]: https://www.strike.money/options/expiry

[^1_19]: https://chainstack.com/base-rpc-providers-2026/

[^1_20]: https://www.ig.com/en/news-and-trade-ideas/futures-prices-vs-spot-prices--what-are-the-differences--210730

[^1_21]: https://yellow.com/research/defi-options-trading-in-2025-how-lyra-dopex-and-panoptic-are-reshaping-derivatives

[^1_22]: https://onchain.org/magazine/real-world-smart-contract-use-cases/

[^1_23]: https://www.eecg.utoronto.ca/~veneris/cryptoex24.pdf

[^1_24]: https://eips.ethereum.org/EIPS/eip-6123

[^1_25]: https://www.gemini.com/cryptopedia/hegic-hegic-defi-options-trading-protocol-on-ethereum

[^1_26]: https://blog.eigencloud.xyz/principles-and-best-practices-to-design-solidity-events-in-ethereum-and-evm/

[^1_27]: https://pmc.ncbi.nlm.nih.gov/articles/PMC8762990/

[^1_28]: https://defiprime.com/canton-vs-evm

[^1_29]: https://www.youtube.com/watch?v=WoGIjHPIc8A

[^1_30]: https://forum.bionicturtle.com/threads/options-on-futures-contracts.13966/


---

# Can in be options on perps?

Yes — options on perps are a real and actively developed primitive, formally called **Everlasting Options** (or Perpetual Options / XPOs). They are to dated options what perpetual futures are to dated futures.

***

## The Core Concept

The **Everlasting Option** was formally introduced in a 2021 Paradigm paper by Dave White and Sam Bankman-Fried. The insight is elegant: instead of expiring, the option *rolls perpetually* using a **funding fee mechanism** borrowed from perps.[^2_1][^2_2]

In a standard perp, funding = `mark − index` (keeps perp price anchored to spot).
In an everlasting option, funding is:

$$
\text{Funding Fee}_N = \frac{\text{mark} - \text{payoff}}{N}
$$

where `payoff` is the current intrinsic value of the option (e.g. `max(spot − strike, 0)` for a call) and `N` is the number of funding periods per day. This keeps the option price anchored to its fair Black-Scholes value rather than drifting. If the option is overpriced relative to payoff, buyers pay sellers; if underpriced, sellers pay buyers.[^2_3][^2_4]

***

## How It Differs from Dated Options on Futures

| Dimension | Dated Option on Futures | Everlasting / Perp Option |
| :-- | :-- | :-- |
| **Expiry** | Fixed date, ties to a futures contract month | None — holds indefinitely |
| **Underlying** | A specific futures contract | Perp mark price (or spot) |
| **Theta (time decay)** | Exists; option bleeds to zero | Does not exist — replaced by funding |
| **Premium payment** | Paid upfront in full | Paid continuously via funding each period |
| **Effective tenor** | Days to expiry | Roughly equivalent to a dated option expiring in 1 funding period (~24h) [^2_5] |
| **Liquidity** | Fragmented across strikes × expiries | Consolidated — only strikes, no expiry dimension [^2_6] |
| **Rolling cost** | Must manually close + re-open each expiry | Zero — position holds automatically |
| **Settlement on exercise** | Assigns a futures position at strike | Cash-settles the intrinsic payoff |

The liquidity consolidation point is significant for you as a builder: dated options scatter liquidity across a strike × expiry matrix (e.g. 20 strikes × 12 monthly expiries = 240 separate markets). Everlasting options collapse this to just the strike dimension, making AMM-based market making far more capital-efficient.[^2_6]

***

## Pricing: Replication via a Portfolio of Dated Options

The theoretical value of an everlasting option is a **weighted sum of dated options** with exponentially decaying weights:[^2_2]

$$
V_{\text{everlasting}} = \sum_{k=0}^{\infty} \frac{1}{2^{k+1}} \cdot V_{\text{dated},\, T_k}
$$

The first dated option (expiring soonest) gets 50% weight, the next 25%, then 12.5%, etc.. In practice, only the first 4–6 terms matter, as the tail weights are negligible. This replication formula is what the **funding payment** enforces: at each funding interval, the contract pays out the value of the "top" expiring option and rolls into the next basket.[^2_7]

***

## Protocols Implementing This On-Chain

- **Panoptic** — reuses Uniswap V3 concentrated liquidity positions as perpetual options; no oracles, no expiry, premia stream every Ethereum block (~12s)[^2_8][^2_9]
- **Paradex** — implements perpetual options as an order-book hybrid; prices them as "a dated option expiring in one funding period" and charges funding continuously[^2_5]
- **Opyn/Squeeth** — power perpetuals: tracks ETH², a special case of an everlasting option with payoff = `spot²`; the first major on-chain perpetual derivative product[^2_10]

***

## Key Implementation Challenges for Perp Options on EVM

Since you're building this, the hardest parts relative to dated options are:

1. **Funding accrual per block** — you need an efficient per-position accumulator (similar to how Aave tracks interest with an index), not per-block iteration; use a global `fundingIndex` and snapshot it on position open[^2_8]
2. **Mark price for funding** — you must derive a reliable mark price for the option itself (not just the underlying), since funding = `mark − payoff`; this is harder than a perp where mark ≈ spot
3. **No natural delta hedge** — dated options protocols hedge delta via the futures they reference; perp options need a continuous hedge (e.g. against the underlying perp), requiring tight integration between both engines
4. **Margin under continuous funding** — a buyer who runs out of margin to pay funding gets liquidated even if their option is ITM; you must deduct funding from margin reserves on every interaction (or accumulate lazily with the index approach)
<span style="display:none">[^2_11][^2_12][^2_13][^2_14][^2_15][^2_16][^2_17][^2_18][^2_19][^2_20][^2_21][^2_22][^2_23][^2_24][^2_25][^2_26][^2_27][^2_28][^2_29][^2_30]</span>

<div align="center">⁂</div>

[^2_1]: https://www.paradigm.xyz/2021/05/everlasting-options

[^2_2]: https://www.samchepal.com/a-theoretical-and-empirical-analysis-of-everlasting-options/

[^2_3]: https://www.paradigm.xyz/static/everlasting_options.pdf

[^2_4]: https://panoptic.xyz/research/perpetual-futures-vs-options

[^2_5]: https://github.com/tradeparadex/paradex-docs/blob/main/fern/pages/options/differences-perps-dated-options.mdx?plain=1

[^2_6]: https://arxiv.org/html/2508.07068

[^2_7]: https://www.youtube.com/watch?v=wpUBuzLS80w

[^2_8]: https://panoptic.xyz/docs/trading/perpetual-options

[^2_9]: https://yellow.com/research/defi-options-trading-in-2025-how-lyra-dopex-and-panoptic-are-reshaping-derivatives

[^2_10]: https://github.com/0xperp/defi-derivatives

[^2_11]: https://chain.link/article/defi-derivatives

[^2_12]: https://metamask.io/news/guide-to-crypto-perpetual-futures-for-beginners

[^2_13]: https://www.osiztechnologies.com/blog/on-chain-perpetuals-in-defi-era

[^2_14]: https://lcx.com/en/understanding-perpetual-dexs-the-future-of-on-chain-derivatives

[^2_15]: https://university.mitosis.org/how-on-chain-perpetual-futures-actually-work-why-theyre-eating-spot-dexs/

[^2_16]: https://www.youtube.com/watch?v=FarI7f8qeEo

[^2_17]: https://www.youtube.com/watch?v=Xpvkuz4ZtEo

[^2_18]: http://panoptic.xyz/docs/trading/perpetual-options

[^2_19]: https://www.blockchainappsdeveloper.com/on-chain-perpetuals-in-defi-era

[^2_20]: https://www.youtube.com/watch?v=NAlXsnbcxIY

[^2_21]: https://thebitcoinmanual.com/articles/on-chain-perpetual-futures/

[^2_22]: https://learn.greeks.live/area/perpetual-futures-trading-strategies/resource/1/

[^2_23]: https://www.osl.com/hk-en/academy/article/options-vs-perpetual-contracts-vs-futures-contracts

[^2_24]: https://arxiv.org/pdf/2508.07068.pdf

[^2_25]: https://learn.backpack.exchange/articles/types-of-futures-contracts-crypto-trading

[^2_26]: https://www.fiahub.com/blog/everlasting-options-trong-defi-la-gi/

[^2_27]: https://blog.sei.io/trading/perps/perpetual-futures-vs-traditional-futures/

[^2_28]: https://cointelegraph.com/news/everlasting-options-and-perpetual-futures-here-is-how-one-platform-is-offering-both-with-a-defi-twist

[^2_29]: https://phillipcapitaldifc.ae/futures-settlement-methods/

[^2_30]: https://coin98.net/everlasting-options-la-gi


---

# Explain the mechanic of options trading for a beginner

Options trading gives you the right — but never the obligation — to buy or sell an asset at a fixed price before a set date. You pay a small upfront fee called a **premium** for this right, and your maximum loss as a buyer is always capped at that premium.[^3_1]

***

## The Two Types of Options

- **Call option** — the right to *buy* the asset at the strike price; you buy a call when you think the price will go *up*[^3_8]
- **Put option** — the right to *sell* the asset at the strike price; you buy a put when you think the price will go *down*[^3_8]

***

## The Key Terms

- **Strike price** — the fixed price you can buy/sell at, agreed when you open the contract[^3_6]
- **Expiry date** — the deadline by which you must exercise or let the option expire worthless[^3_1]
- **Premium** — the price you pay to buy the option contract[^3_2]
- **In the money (ITM)** — the option has real value (e.g. call with strike \$40 when price is \$50)[^3_6]
- **Out of the money (OTM)** — exercising would be unprofitable; the option will likely expire worthless[^3_6]

***

## A Concrete Example

Say ETH is at \$2,000. You buy a **call option** with a strike price of \$2,200, expiring in 30 days, for a premium of \$100.[^3_2]

- **ETH rises to \$2,500**: you exercise, effectively buying at \$2,200 and immediately gaining \$300, minus the \$100 premium = **\$200 profit**[^3_2]
- **ETH stays at \$2,000**: you don't exercise (it would be cheaper to just buy at market). You lose only the **\$100 premium**[^3_1]
- **ETH crashes to \$1,500**: you still lose only the **\$100 premium** — the option simply expires[^3_1]

This asymmetry is the core appeal: **limited downside, uncapped upside** for buyers.

***

## Buyers vs. Sellers (Writers)

The two sides of an option contract have very different risk profiles:[^3_1]


| Role | Action | Max Loss | Max Gain |
| :-- | :-- | :-- | :-- |
| **Buyer** | Pays premium | Premium paid | Unlimited (call) / Strike price (put) |
| **Seller (writer)** | Receives premium | Unlimited (call) / very large (put) | Premium received |

Sellers collect the premium upfront but take on the *obligation* to deliver if the buyer exercises. This is why selling naked (uncovered) options is the riskiest position in finance.[^3_6][^3_1]

***

## What Moves Option Prices

Options don't just track the underlying price — several forces affect the premium:[^3_9]

- **How far the price is from the strike** — deeper ITM = more expensive
- **Time remaining** — more time = more expensive; this erodes daily (**time decay / Theta**)
- **Volatility** — higher expected price swings = more expensive option (**Vega**)
- **Direction of the underlying** — price movement changes the option's delta (**Delta**)

***

## Common Beginner Strategies

- **Long call** — buy a call, bet price goes up; simple, limited loss[^3_1]
- **Long put** — buy a put, bet price goes down or use it as insurance on holdings[^3_2]
- **Covered call** — you own the asset and sell a call on it to earn recurring premium income[^3_8]
- **Straddle** — buy both a call and a put at the same strike; profits if the price moves *a lot* in either direction; used before major events like protocol launches or economic data[^3_9]

The most important mental model: options are **not a bet on direction alone — they are a bet on direction + magnitude + timing**. A call option can lose value even if the price goes up slightly, if time decay erodes more than the price gain delivers.
<span style="display:none">[^3_10][^3_11][^3_12][^3_13][^3_14][^3_15][^3_3][^3_4][^3_5][^3_7]</span>

<div align="center">⁂</div>

[^3_1]: https://www.investopedia.com/options-basics-tutorial-4583012

[^3_2]: https://www.ally.com/stories/invest/trading-options-for-beginners/

[^3_3]: https://www.youtube.com/watch?v=VS7E81cuEVs

[^3_4]: https://www.youtube.com/watch?v=hcalZ_sRtRY

[^3_5]: https://www.youtube.com/watch?v=T6LQgdqGllQ

[^3_6]: https://www.nerdwallet.com/investing/learn/how-to-trade-options

[^3_7]: https://www.youtube.com/watch?v=4CAFT3d45rs

[^3_8]: https://www.ishares.com/us/investor-education/investment-strategies/introduction-to-options

[^3_9]: https://www.sofi.com/learn/content/options-trading-for-beginners/

[^3_10]: https://www.wsoctv.com/news/beginners-guide-options-trading/RJICSRJW35IORKBUIUXDEKG46I/

[^3_11]: https://www.youtube.com/watch?v=O8EN51F6jUo

[^3_12]: https://www.reddit.com/r/stocks/comments/18o4rz7/i_have_no_idea_how_options_work_can_someone/

[^3_13]: https://www.youtube.com/watch?v=DC3eBxoCVts

[^3_14]: https://www.youtube.com/watch?v=z0qcwSjpMDA

[^3_15]: https://www.youtube.com/watch?v=XkexmQchA98


---

# Do one sells options?

Yes — selling options (also called **writing** options) is a very active and popular strategy, often more common among professional traders than buying options.[^4_7]

## Who Sells Options and Why

When you sell an option, you flip the trade around: instead of paying a premium, you **collect it upfront**. Your goal is simple — you want the option to expire worthless so you keep that premium as pure profit. Statistically, the majority of options do expire worthless, which is why many professional traders prefer the seller's side.[^4_6][^4_7]

The tradeoff is that your risk profile inverts completely:[^4_8]

- **Buyer** — limited loss (just the premium), unlimited upside
- **Seller** — immediate income (the premium), but potentially unlimited loss if the market moves sharply against you


## The Two Things You Can Sell

- **Sell a call** — you believe the price will *not* rise above the strike; you collect premium and profit if it stays below[^4_2]
- **Sell a put** — you believe the price will *not* fall below the strike; you collect premium and profit if it stays above[^4_2]


## Common Selling Strategies (From Safest to Riskiest)

- **Covered call** — you already own the asset and sell a call on it; if the buyer exercises, you simply hand over your asset at the strike price; very safe[^4_9]
- **Cash-secured put** — you sell a put and hold enough cash to buy the asset if assigned; worst case is you buy at a price you were already comfortable with[^4_13]
- **Credit spread** — sell one option and simultaneously buy a further OTM option as protection; caps your maximum loss[^4_2]
- **Naked option** — sell without owning the asset or holding hedging collateral; highest risk, as losses are theoretically unlimited on a naked call[^4_13]


## A Concrete Example

ETH is at \$2,000. You sell a call with a \$2,500 strike expiring in 30 days and collect \$80 premium.[^4_2]

- **ETH stays below \$2,500**: option expires worthless — you keep the full **\$80 profit**[^4_5]
- **ETH rises to \$2,700**: buyer exercises — you must sell ETH at \$2,500 when it's worth \$2,700, losing **\$200 minus the \$80 premium = \$120 net loss**[^4_2]
- **ETH skyrockets to \$5,000**: your loss is **\$2,500 minus \$80 premium** — this is why naked selling is dangerous[^4_8]


## Why Sellers Have a Statistical Edge

Option sellers benefit from **time decay (Theta)** working *in their favor* — every day that passes without a big price move erodes the option's value, putting money in the seller's pocket. This is the opposite of the buyer's experience. Sellers also profit in **sideways or low-volatility markets** where buyers keep losing premium. For this reason, many systematic and institutional traders are net option sellers, using defined-risk spreads to cap the downside.[^4_3][^4_7]
<span style="display:none">[^4_1][^4_10][^4_11][^4_12][^4_14][^4_15][^4_4]</span>

<div align="center">⁂</div>

[^4_1]: https://www.bajajfinserv.in/selling-options

[^4_2]: https://www.home.saxo/content/articles/options/from-zero-to-hero---selling-options-12092023

[^4_3]: https://www.youtube.com/watch?v=2Vqz9GXkr5I

[^4_4]: https://www.youtube.com/watch?v=6OYHKlPHz7g

[^4_5]: https://laresalgotech.com/what-is-option-selling-and-how-option-selling-works/

[^4_6]: https://www.onlinenifm.com/blog/post/382/stock-market/option-selling-for-beginners

[^4_7]: https://www.mastertrust.co.in/blog/option-selling-basics-beginners-guide

[^4_8]: https://www.investopedia.com/options-basics-tutorial-4583012

[^4_9]: https://www.selloptions.net/learn

[^4_10]: https://www.youtube.com/watch?v=0awxX1mt0Tc

[^4_11]: https://www.ec-undp-electoralassistance.org/fetch.php/libweb/58NNAp/The-Complete-Guide-To-Option-Selling.pdf

[^4_12]: https://www.youtube.com/watch?v=TOOZuntPTLs

[^4_13]: https://www.home.saxo/en-sg/content/articles/options/from-zero-to-hero---selling-options-12092023

[^4_14]: https://www.youtube.com/watch?v=lzicm7giQxM

[^4_15]: https://www.reddit.com/r/options/comments/pxe1wj/the_ultimate_guide_to_selling_options/


---

# How the smart contract should work

Given your goal of building **options on futures/perps on EVM**, here is a complete breakdown of how the smart contracts should be structured — from data model to lifecycle flow.

***

## Core Data Model

Every option position is stored as a struct on-chain. At minimum it needs:[^5_1]

```solidity
struct Option {
    address writer;        // seller who posted collateral
    address buyer;         // current owner of the option
    uint256 strikePrice;   // fixed price at which option can be exercised
    uint256 expiry;        // block.timestamp deadline
    uint256 amount;        // size of the position
    uint256 premium;       // price paid by buyer
    OptionType optionType; // CALL or PUT
    bool exercised;
    bool cancelled;
}

enum OptionType { CALL, PUT }
mapping(uint256 => Option) public options;
uint256 public nextOptionId;
```

For futures/perps options, you add a reference to the underlying futures position ID and the futures contract address.[^5_1]

***

## Contract Modules

The system should be split into at least four separate contracts:

- **OptionsFactory** — creates and stores option contracts, manages the ID registry
- **CollateralVault** — holds locked collateral from writers and premium from buyers; never mixed
- **Oracle** — reads Chainlink price feed (or perp mark price) for settlement; must validate for staleness[^5_2]
- **SettlementEngine** — handles exercise, expiry, and liquidation logic

This separation matters for security: the vault should have no pricing logic, and the oracle module should be upgradeable independently.[^5_3]

***

## The Full Option Lifecycle

Each state transition maps to a function call:

### 1. Write (Sell)

The writer calls `writeOption()`, specifying strike, expiry, amount, and option type. The contract immediately pulls collateral from the writer into the vault:[^5_1]

- **Naked call**: lock the underlying asset (e.g. ETH or perp position)
- **Cash-secured put**: lock `strike × amount` in stablecoins
- **Futures option**: lock margin equivalent to max potential loss under stress

```solidity
function writeOption(uint strike, uint expiry, uint amount, OptionType t) 
    external returns (uint optionId) {
    _collectCollateral(msg.sender, strike, amount, t); // pull from writer
    options[nextOptionId] = Option(msg.sender, address(0), strike, expiry, amount, 0, t, false, false);
    return nextOptionId++;
}
```


### 2. Buy

The buyer calls `buyOption(optionId)` and pays the premium. The contract transfers option ownership and routes premium to the writer:[^5_1]

```solidity
function buyOption(uint id) external payable {
    Option storage opt = options[id];
    require(opt.buyer == address(0), "Already sold");
    require(msg.value == opt.premium, "Wrong premium");
    opt.buyer = msg.sender;
    payable(opt.writer).transfer(msg.value); // premium to writer immediately
}
```


### 3. Exercise

The buyer calls `exercise(optionId)` before expiry. The contract checks the oracle price, validates profitability (ITM check), and pays out the difference:[^5_4][^5_1]

```solidity
function exercise(uint id) external {
    Option storage opt = options[id];
    require(msg.sender == opt.buyer, "Not owner");
    require(!opt.exercised, "Already exercised");
    require(block.timestamp < opt.expiry, "Expired");

    uint markPrice = oracle.getPrice(); // Chainlink or perp mark price
    uint payout = _calcPayout(opt, markPrice); // max(markPrice - strike, 0) × amount
    require(payout > 0, "Out of the money");

    opt.exercised = true;
    vault.releaseTo(opt.buyer, payout);         // pay buyer from collateral
    vault.releaseTo(opt.writer, remaining);     // return leftover collateral
}
```

For **futures options**, instead of a direct payout, `exercise()` opens a futures position in your futures engine at the strike price, then immediately cash-settles the PnL — or just does full cash settlement directly.[^5_5]

### 4. Expire Worthless

After `block.timestamp >= expiry` and `exercised == false`, anyone (or a keeper bot) calls `retrieveExpiredCollateral(optionId)`, which releases all locked collateral back to the writer:[^5_1]

```solidity
function retrieveExpiredCollateral(uint id) external {
    Option storage opt = options[id];
    require(block.timestamp >= opt.expiry, "Not expired");
    require(!opt.exercised, "Was exercised");
    vault.releaseTo(opt.writer, opt.collateral);
}
```


***

## Collateral Logic (Critical for Futures Options)

Standard spot options use **full collateralization** — the writer locks 100% of the worst-case payout, making the system safe but capital-inefficient. For futures options you typically want **margin-based collateral**, where the writer posts a percentage computed from volatility and position size:[^5_4][^5_3]


| Collateral Model | How It Works | Risk |
| :-- | :-- | :-- |
| **Full collateral** | Lock entire strike × amount | Zero insolvency risk, very capital-inefficient |
| **Margin-based** | Lock a % based on vol and delta | Capital-efficient, requires liquidation engine |
| **Portfolio margin** | Offset correlated positions | Most efficient, hardest to implement on-chain |

For margin models, you need a **liquidation function** that can be called by keepers when the writer's margin falls below the maintenance threshold — identical in concept to a perp liquidation.[^5_3]

***

## Oracle Integration

The oracle is the most critical security surface. Every pricing call should:[^5_2]

```solidity
(uint80 roundId, int price,, uint updatedAt,) = priceFeed.latestRoundData();
require(price > 0, "Invalid price");
require(block.timestamp - updatedAt < MAX_STALENESS, "Stale oracle"); // e.g. 60s
```

For perp options specifically, you need **two price feeds**: the spot/index price (for reference) and the perp mark price (for actual settlement), since the option is written on the perp, not the spot.[^5_6]

***

## Events (Essential for Off-Chain Indexing)

Every state change should emit an event so your frontend/indexer tracks positions without expensive on-chain reads:[^5_1]

```solidity
event OptionWritten(uint indexed id, address writer, uint strike, uint expiry);
event OptionBought(uint indexed id, address buyer, uint premium);
event OptionExercised(uint indexed id, uint payout, uint markPrice);
event OptionExpired(uint indexed id);
event CollateralReturned(uint indexed id, address writer, uint amount);
```

<span style="display:none">[^5_10][^5_11][^5_12][^5_13][^5_14][^5_15][^5_16][^5_17][^5_7][^5_8][^5_9]</span>

<div align="center">⁂</div>

[^5_1]: https://blog.chain.link/defi-call-option-exchange-in-solidity/

[^5_2]: https://www.nadcab.com/blog/oracles-smart-contracts-in-defi

[^5_3]: https://arxiv.org/html/2401.06044v1

[^5_4]: https://threesigma.xyz/blog/options/defi-options-collateralization-guide

[^5_5]: https://www.investopedia.com/terms/o/options-on-futures.asp

[^5_6]: https://github.com/tradeparadex/paradex-docs/blob/main/fern/pages/options/differences-perps-dated-options.mdx?plain=1

[^5_7]: https://docs.soliditylang.org/en/latest/contracts.html

[^5_8]: https://arxiv.org/html/2506.03006v2

[^5_9]: https://github.com/maxwoe/solidity_patterns

[^5_10]: https://www.youtube.com/watch?v=M6VNbegJjaM

[^5_11]: https://www.quicknode.com/guides/ethereum-development/smart-contracts/how-to-write-an-ethereum-smart-contract-using-solidity

[^5_12]: https://ceur-ws.org/Vol-3938/Paper_4.pdf

[^5_13]: https://help.public.com/en/articles/8460531-understanding-option-expiration-exercise-and-assignment

[^5_14]: https://developers.stellar.org/docs/learn/migrate/evm/solidity-and-rust-advanced-concepts

[^5_15]: https://arxiv.org/html/2512.20190v1

[^5_16]: https://www.quantconnect.com/docs/v2/writing-algorithms/trading-and-orders/order-types/option-exercise-orders

[^5_17]: https://www.openzeppelin.com/solidity-contracts


---

# How orders match?

In the context of your options on EVM system, "order matching" means connecting a **writer** (seller) who created an option with a **buyer** who wants to purchase it. There are three fundamentally different architectures to choose from, each with major tradeoffs.

***

## Architecture 1: Peer-to-Peer (Simple, No Matching Engine)

The simplest model — a writer creates an option on-chain and publishes it, and any buyer can claim it directly. There is no price negotiation; the premium is set unilaterally by the writer.[^6_1]

**Flow:**

1. Writer calls `writeOption(strike, expiry, premium, amount)` → contract locks collateral, records the offer
2. Buyer browses open offers on-chain/frontend, calls `buyOption(id)` → pays premium, receives option
3. No matching engine needed — it's a take-it-or-leave-it marketplace

**Best for:** simple bootstrapping, OTC-style desks, early-stage protocols. Bad for price discovery.

***

## Architecture 2: On-Chain Order Book (CLOB)

Buyers and sellers both post orders at their desired prices; a matching engine pairs them when prices cross. This is how traditional exchanges work.[^6_2]

**The on-chain problem:** continuously scanning all orders for matches is prohibitively expensive in gas — every order placement, cancellation, and match requires a transaction. A pure on-chain CLOB is currently not viable on EVM mainnet.[^6_3]

**The hybrid solution** used by AEVO, dYdX, and Derive:[^6_4]

```
[User] → submit order (signed message, off-chain)
                ↓
[Off-chain Matching Engine] → finds price/time priority matches
                ↓
[Smart Contract] → verifies signatures, settles, moves collateral
```

- Orders live off-chain (or in fast L2 sequencer memory)
- The smart contract only touches funds at settlement
- An off-chain matcher listens to events, identifies compatible buy/sell pairs, and calls `executeMatch(orderA, orderB)` on-chain[^6_4]

**Matching priority rule** (standard): **price-time priority** — the best-priced order wins; among equal prices, the oldest order wins.[^6_5][^6_2]

***

## Architecture 3: AMM / Pool-to-Peer

No orders at all — liquidity providers deposit collateral into a pool, and the pool acts as the sole counterparty for every buyer. Price is determined by a formula, not bids and asks.[^6_6]

**Flow:**

1. LPs deposit stablecoins into a vault (the "pool writer")
2. Buyer calls `buyOption(strike, expiry, amount)` — the AMM prices it via Black-Scholes or a simplified vol model and charges a premium
3. The pool is automatically the writer on all contracts
4. At expiry, profitable options are settled from the pool; LPs collect leftover premium

Used by **Hegic** (rate-based pricing) and **Lyra/Derive** (Black-Scholes with IV surface).[^6_3]

***

## Comparing All Three

| Dimension | Peer-to-Peer | Hybrid CLOB | AMM Pool |
| :-- | :-- | :-- | :-- |
| **Matching** | Manual / first-come | Off-chain engine, on-chain settle | No matching, formula pricing |
| **Price discovery** | Poor (writer decides) | Excellent | Moderate (formula-driven) |
| **Gas cost** | Low | Settlement only | Medium (per trade) |
| **Liquidity** | Thin, fragmented | Deep if MMs participate | Always available |
| **Trust** | Fully on-chain | Sequencer/matcher trust | Smart contract trust |
| **Complexity** | Low | High | Medium |
| **Best for** | MVP / OTC | Institutional, high volume | Retail, bootstrapping |


***

## Recommended Flow for Your Futures/Perps Options System

Given that you're already building a futures engine, the **hybrid CLOB** approach fits naturally:[^6_7]

1. **Writer signs an off-chain order** (`strike, expiry, collateralType, premium, nonce, signature`) — no gas until matched
2. **Buyer signs a matching order** at the same or better price
3. **Off-chain matcher** (your backend/keeper) pairs them and submits both signed orders to the contract
4. **Smart contract** verifies both signatures (EIP-712), pulls collateral from writer, pulls premium from buyer, opens the option position — all in one atomic transaction[^6_4]
5. On exercise or expiry, settlement runs entirely on-chain against your futures engine

The key Solidity primitive for this is `ecrecover` with EIP-712 typed structured data hashing — the same pattern used by Uniswap's `permit` and every off-chain order book in DeFi:[^6_7]

```solidity
bytes32 orderHash = _hashOrder(order);         // EIP-712 typed hash
address signer   = ECDSA.recover(orderHash, signature);
require(signer == order.writer, "Bad signature");
```

This lets you achieve near-CEX UX (fast matching, no gas on order placement) while keeping collateral and settlement fully non-custodial on-chain.[^6_7][^6_4]
<span style="display:none">[^6_10][^6_11][^6_12][^6_13][^6_14][^6_15][^6_16][^6_8][^6_9]</span>

<div align="center">⁂</div>

[^6_1]: https://blog.chain.link/defi-call-option-exchange-in-solidity/

[^6_2]: https://injective.com/blog/decentralized-exchange-designs-order-book-model-vs-automated-market-maker-amm

[^6_3]: https://threesigma.xyz/blog/options/defi-options-landscape-guide

[^6_4]: https://www.ijraset.com/best-journal/real-dex-on-chain-orderbook-dex

[^6_5]: https://verbalexx.com/terms/decentralized-exchange-dex-order-book-matching-algorithms

[^6_6]: https://encrypthos.com/guide/understanding-why-amms-are-replacing-traditional-order-books-in-defi/

[^6_7]: https://tranhvietad.com/why-institutional-traders-are-finally-taking-on-chain-order-book-dexs/

[^6_8]: https://learn.greeks.live/area/on-chain-order-matching/

[^6_9]: https://www.youtube.com/watch?v=JB_sLJcc_T8

[^6_10]: https://blog.bitunix.com/en/order-books-vs-liquidity-pools-explained-why-defi-moved-to-pools/

[^6_11]: https://www.youtube.com/watch?v=biEwVC3khrY

[^6_12]: https://www.chaincatcher.com/en/article/2075964

[^6_13]: https://learn.greeks.live/area/defi-order-book/resource/2/

[^6_14]: https://insights.derive.xyz/can-an-orderbook-be-a-public-good/

[^6_15]: https://www.bis.org/publ/qtrpdf/r_qt2112v.htm

[^6_16]: https://progressiveqatar.com/why-market-making-order-books-are-the-next-institutional-on-ramp-for-defi/


---

# Is it the same limit order book?

Yes and no — the **mechanics are the same**, but the **structure is fundamentally more complex**. A limit order book for options is significantly harder to operate than one for spot or futures.

***

## Where It's Identical

A standard CLOB (Central Limit Order Book) works the same regardless of the asset:[^7_1]

- Buyers post **bids** (max price willing to pay)
- Sellers post **asks** (min price willing to accept)
- When a bid ≥ ask, the engine **matches** them and executes the trade
- Priority rule: **best price first**, then **oldest order first** (price-time priority)

This logic applies identically to options. A buyer posting "I'll pay 0.05 ETH premium for a \$2,500 call expiring June 30" is just a limit order — it sits in the book until a writer posts a matching ask.

***

## Where Options Are Fundamentally Different

The critical difference is **dimensionality**. A spot or perp market has exactly **one order book** per asset:[^7_2]

```
ETH/USDC order book
Bids: 2,010 / 2,005 / 2,000...
Asks: 2,011 / 2,015 / 2,020...
```

An options market needs a **separate order book for every combination of strike × expiry × type**:[^7_2]

```
ETH $2,000 CALL June 27  →  its own order book
ETH $2,000 PUT  June 27  →  its own order book
ETH $2,500 CALL June 27  →  its own order book
ETH $2,500 CALL Sept 27  →  its own order book
... (potentially thousands)
```

In 2023, roughly **1.45 million individual options series** traded on US markets alone. This fragmentation means each individual book is thin and often has wide bid-ask spreads, making pure CLOB impractical for anything but the most liquid strikes.[^7_2]

***

## What This Means for Your Smart Contract

Your matching contract needs an extra layer of routing — every order must be tagged with its full instrument identifier:

```solidity
struct OptionsOrder {
    address maker;
    uint256 strikePrice;
    uint256 expiry;
    OptionType optionType;   // CALL or PUT
    uint256 size;
    uint256 limitPremium;    // the "limit price"
    OrderSide side;          // BUY or SELL
    uint256 nonce;
    bytes signature;         // EIP-712
}
```

The off-chain matcher groups orders by `(strike, expiry, type)` into separate mini-books, then applies standard price-time priority matching within each one. When a match is found, a single `executeMatch(orderA, orderB)` call settles on-chain.[^7_1]

***

## The Liquidity Problem \& Solutions

Because each strike/expiry pair has its own book, most of them will be empty most of the time. Three approaches exist to handle this:[^7_2]


| Approach | How it solves fragmentation |
| :-- | :-- |
| **RFQ (Request for Quote)** | Buyer requests a quote; market makers respond bilaterally; no public book needed |
| **AMM pool as backstop** | An LP pool quotes any strike at any time using a formula; CLOB is primary, AMM fills the gaps |
| **Liquidity concentration** | Only list a small set of standard strikes (e.g. 5 strikes per expiry); focus all liquidity |

AEVO and Derive use **RFQ + CLOB hybrid**: institutional market makers respond to RFQs off-chain, and the CLOB captures retail flow. For a perp options system where expiry doesn't exist, this problem largely disappears — you only fragment by **strike**, not strike × expiry, which is exactly why everlasting/perpetual options are so much more capital- and liquidity-efficient.[^7_3][^7_4]
<span style="display:none">[^7_10][^7_11][^7_12][^7_13][^7_14][^7_15][^7_16][^7_17][^7_5][^7_6][^7_7][^7_8][^7_9]</span>

<div align="center">⁂</div>

[^7_1]: https://verbalexx.com/terms/decentralized-exchange-dex-order-book-matching-algorithms

[^7_2]: https://www.exegy.com/market-structure-option-liquid-data/

[^7_3]: https://www.optaxe.com/post/liquidity-lessons-for-otc-fx-derivatives-why-the-market-needs-more-than-multi-bank-rfqs-clobs

[^7_4]: https://threesigma.xyz/blog/options/defi-options-landscape-guide

[^7_5]: https://www.youtube.com/watch?v=v3C8qJg3SVM

[^7_6]: https://www.tiktok.com/@jessicainskip/video/7529648320554274103

[^7_7]: https://www.youtube.com/watch?v=Zf37t7njppg

[^7_8]: https://www.youtube.com/watch?v=pnUmNqvXxkY

[^7_9]: https://www.youtube.com/watch?v=sT-tvc8GPQQ

[^7_10]: https://www.binance.com/en/square/post/24372803039113

[^7_11]: https://www.youtube.com/watch?v=xNi6K6QSg0k

[^7_12]: https://www.youtube.com/watch?v=cCz82_cfG8s

[^7_13]: https://www.youtube.com/watch?v=9sfRyEdNMng

[^7_14]: https://www.amf-france.org/sites/institutionnel/files/2020-01/the-impact-of-fragmentation-on-liquidity.pdf

[^7_15]: https://www.tiktok.com/@saccofinancial/video/7493259574997224735

[^7_16]: https://www.lseg.com/en/insights/data-analytics/fragmented-markets-unified-solutions-tackling-liquidity-with-lseg

[^7_17]: https://www.youtube.com/watch?v=OiYrAKbTL8o


---

# You fragment by strike, but what about price? What is strike?

Great question — the strike and the premium (market price of the option) are two completely different things, and beginners often confuse them. Here's the distinction clearly.

***

## Strike Price vs. Premium (Market Price)

Think of it this way: you're buying a **voucher** to purchase ETH at a fixed price in the future.

- The **strike price** is the fixed price written on the voucher — e.g. "buy ETH at \$2,500". It never changes for the life of that contract.[^8_1]
- The **premium** is what you pay *today* to buy that voucher — e.g. \$80. This is what fluctuates constantly like any market price.[^8_5]

The strike is not traded. The **premium is the thing that's traded** on the order book.[^8_3]

***

## A Concrete Example

ETH is trading at \$2,000 right now.


| Contract | Strike | Premium (market price) |
| :-- | :-- | :-- |
| ETH Call, June 27 | \$2,000 (ATM) | \$200 |
| ETH Call, June 27 | \$2,500 (OTM) | \$80 |
| ETH Call, June 27 | \$3,000 (deep OTM) | \$20 |

All three have **different fixed strikes**. What traders bid and ask on the order book is the **premium** of each. Each strike has its own separate order book where buyers and sellers post limit orders for the premium price.[^8_8]

***

## Why Strikes Are Discrete (Not Continuous)

Strikes are not arbitrary — they are offered at **standardized intervals** set by the exchange or protocol:[^8_11]

- In traditional markets: increments of \$2.50, \$5, or \$10 depending on asset price and volume[^8_11]
- In DeFi: the protocol chooses — common choices are round numbers (e.g. \$1,000 / \$1,500 / \$2,000 / \$2,500) or percentage-based intervals (e.g. every 10% from spot)

This discreteness is what creates the fragmentation problem mentioned earlier: **each fixed strike needs its own order book**, and you're trading the premium price *within* that book.[^8_8]

***

## So What Goes in the Order Book?

To summarize the full picture of an options order:

```
BUY  1 ETH  CALL  strike=$2,500  expiry=Jun27  @ premium ≤ $85
SELL 1 ETH  CALL  strike=$2,500  expiry=Jun27  @ premium ≥ $80
```

The **strike and expiry are the instrument identifier** — they define *which* order book you're in. The **premium is the price** — that's what bids and asks compete on, exactly like a spot limit order book. When a buyer's max premium ≥ a seller's min premium, the engine matches them and the trade executes at that premium.[^8_9][^8_8]
<span style="display:none">[^8_10][^8_12][^8_13][^8_14][^8_15][^8_2][^8_4][^8_6][^8_7]</span>

<div align="center">⁂</div>

[^8_1]: https://en.wikipedia.org/wiki/Strike_price

[^8_2]: https://www.reddit.com/r/explainlikeimfive/comments/1g6j2wo/eli5_whats_a_strike_price/

[^8_3]: https://www.heygotrade.com/en/blog/understanding-strike-price-in-options-trading

[^8_4]: https://carta.com/learn/equity/stock-options/strike-price/

[^8_5]: https://www.sofi.com/learn/content/strike-price-options-trading/

[^8_6]: https://fyers.in/blog/what-is-strike-price/

[^8_7]: https://www.ig.com/en/trading-strategies/option-strike-prices--how-to-pick-the-right-price-201109

[^8_8]: https://quickonomics.com/terms/strike-price/

[^8_9]: https://www.tastylive.com/concepts-strategies/strike-price

[^8_10]: https://www.ig.com/en-ch/glossary-trading-terms/strike-definition

[^8_11]: https://www.bankrate.com/investing/strike-price-of-an-option/

[^8_12]: https://ltse.com/insights/what-is-a-strike-price

[^8_13]: https://www.bajajfinserv.in/strike-price

[^8_14]: https://economictimes.indiatimes.com/s/strike-price/profileshow/50900885.cms

[^8_15]: https://groww.in/blog/what-is-strike-price-in-options


---

# Why cant you do matching onchain?

There are three separate but compounding reasons why full on-chain matching doesn't work well on EVM. It's not just one problem.

***

## Problem 1: Every Order Is a Transaction

On a CEX like Binance, placing, cancelling, or modifying an order is a free in-memory operation — it costs nothing and takes microseconds. On EVM, **every single state change is a transaction** that must be included in a block, validated by the entire network, and paid for in gas:[^9_1][^9_2]

- Place a limit order → transaction (~50k gas)
- Cancel it → another transaction (~30k gas)
- Modify it → cancel + replace → two transactions

A market maker updating quotes 10 times per second would spend thousands of dollars per hour just in gas, making it economically impossible to provide tight liquidity.[^9_1]

***

## Problem 2: Matching Scales Linearly with Gas

This is the most fundamental technical problem. When a large market order matches against multiple resting limit orders, the smart contract must loop through each one and settle it:[^9_3]

```
Taker buys 50 ETH → matches against 50 separate sell orders of 1 ETH each
→ contract loops 50 times → 50 × storage reads/writes → gas scales linearly
```

The more orders a single match touches, the more gas it consumes. In the extreme case, the gas cost exceeds the **block gas limit** (~30M on Ethereum mainnet), making the transaction literally impossible to execute. There is no such ceiling on a CEX.[^9_4]

***

## Problem 3: Latency (12 Seconds vs. Microseconds)

Options trading demands fast price updates because option premiums change continuously as the underlying moves. On Ethereum mainnet, a block confirms every **~12 seconds** — meaning even if you submit an order instantly, you wait up to 12 seconds for it to land. By that time:[^9_5]

- The underlying perp price has moved
- Your quoted premium is stale
- You could be arbitraged on the spread

Professional market makers require sub-millisecond latency. L2s help (Arbitrum ~250ms, OP Stack ~2s) but they still can't match CEX speed.[^9_1]

***

## The Numbers in Practice

| Environment | Gas per limit order | Latency | Viable for MM? |
| :-- | :-- | :-- | :-- |
| **Ethereum L1** | \$10–50 [^9_1] | ~12 sec | No |
| **EVM L2 (Arbitrum/OP)** | \$0.10–0.50 [^9_1] | ~0.25–2 sec | Barely |
| **Fast EVM (Monad, Hyperliquid)** | <\$0.01 [^9_1] | ~0.5 sec | Yes, with optimization |
| **Off-chain matching** | \$0 | <1 ms | Yes |


***

## What People Do Instead

Three pragmatic approaches have emerged:[^9_2]

1. **Hybrid CLOB (dYdX, AEVO, Derive)** — match off-chain for speed and zero-gas UX, settle on-chain for custody guarantees. The tradeoff is the operator can theoretically censor orders[^9_2]
2. **Optimized on-chain data structures** — projects like **Clober** on Monad use a segment tree (LOBSTER) to find the best price level in O(log n) instead of O(n), dramatically cutting gas per match. Still not CEX-speed, but viable on fast chains[^9_5]
3. **AMM as backstop** — skip the order book entirely; a formula always quotes a price, liquidity is always available, and there's no matching step at all[^9_6]

For your perp options system specifically, the hybrid approach is the most practical path: **EIP-712 signed orders off-chain, atomic settlement on-chain**. It gives you fast UX, non-custodial settlement, and avoids the gas wall entirely.
<span style="display:none">[^9_10][^9_11][^9_12][^9_13][^9_14][^9_15][^9_16][^9_7][^9_8][^9_9]</span>

<div align="center">⁂</div>

[^9_1]: https://www.chainscorelabs.com/de/blog/future-of-dexs-amms-orderbooks-and-aggregators/orderbook-dex-scalability/the-crippling-cost-of-consensus-for-every-order-update

[^9_2]: https://x.com/marvellousdefi_/status/1938344955044565294

[^9_3]: https://mirror.xyz/clober.eth/1wPvyq8JnP9bTn74CPr2vH7QFmmUVkzJyRPlj0YbJNE

[^9_4]: https://www.cointime.ai/news/cloberonchain-order-book-dex-for-the-ethereum-ecosystem-90909

[^9_5]: https://blog.monad.xyz/blog/understanding-lobster

[^9_6]: https://www.chaincatcher.com/en/article/2075964

[^9_7]: https://www.blog.blockscout.com/understanding-gas-fees-across-evm-chains/

[^9_8]: https://chainstack.com/zh/evm-practical-explanation-of-how-gas-fee-works/

[^9_9]: https://www.reddit.com/r/defi/comments/wmle4f/is_it_true_that_an_order_book_style_dex_on_evm/

[^9_10]: https://arxiv.org/html/2410.07893v2

[^9_11]: https://www.reddit.com/r/ethereum/comments/lobib9/for_those_who_are_new_to_ethereum_and_are/

[^9_12]: https://www4.comp.polyu.edu.hk/~csxluo/DoSEVM.pdf

[^9_13]: https://github.com/0xMiden/examples/discussions/138

[^9_14]: https://doc.aurora.dev/blog/evm-gas-near-gas-on-aurora/

[^9_15]: https://hackmd.io/@0xtrojan/clob

[^9_16]: https://oakresearch.io/en/analyses/innovations/clob-wars-new-dawn-for-dex-trading


---

# how can you provide transparency for off-chain matching engine?

You can’t make an off‑chain matching engine *as* transparent as a fully on‑chain CLOB, but you can design it so that **any rational participant can independently verify that you’re not cheating** — that’s the practical definition of transparency here. There are three main levers: **data**, **logic**, and **governance**.[^10_1][^10_2]

***

## 1. Keep the Dataset Verifiable

The minimal transparency guarantee is: everyone can *see* the full order book state and every trade. Common patterns:[^10_2][^10_3]

- **Public orderbook gateway**
Run a WebSocket / gRPC endpoint that exposes:
    - current orderbook (bids/asks per strike–expiry–type)
    - every order insert/delete/modify
    - every trade matched and settled
This is exactly how AEVO, dYdX, and Bluefin expose their off‑chain orderbooks.[^10_4][^10_2]
- **On‑chain state commitments**
Periodically post a **Merkle root** or **state commitment** of the orderbook on‑chain:

```solidity
function commitState(bytes32 root) external onlyOperator {
    stateRoots[now] = root;
}
```

Users can locally reconstruct the same orderbook and verify that the on‑chain root matches what the sequencer claims. This defends against *data hiding*, but not unfair logic.[^10_5][^10_3]

***

## 2. Make the Matching Logic Verifiable

The sequencer can still be malicious by changing the matching rules (e.g. priority, fee capture, MEV‑like behavior). To limit that:

- **Open‑source the engine**
Publish the full matching code under an auditable license. This doesn’t *prove* you run it as written, but it enables community audits and becomes socially hard to backdoor.[^10_6][^10_4]
- **Cryptographic proofs of correct execution**
Advanced architectures use **ZK or fraud proofs** so that *any* off‑chain computation can be verified on‑chain:[^10_7][^10_8][^10_3]
    - sequencer submits a ZK‑proof that “order X was matched at price Y according to the published rules”
    - contract verifies the proof in a single call, without re‑running the full book
    - if the proof fails, the sequencer is slashed (see roll‑up‑style designs like LayerN, Monad‑style orderbooks)[^10_8][^10_3]
- **Deterministic matching logs**
Store signed, sequential logs of:
    - `block_i: order X inserted`
    - `block_i: matched orders (A,B,C) → trades (a,b,c)`
Anyone can replay the engine from genesis and prove that the sequencer deviated if the replay mismatches the public logs.[^10_1][^10_6]

***

## 3. Governance and Operations Design

Transparency is not just technical; it’s also about **incentive alignment** and **exit paths**:[^10_9][^10_4]

- **Permissionless on‑chain trading**
Design your smart contracts so that users can always trade **directly peer‑to‑peer on‑chain** (EIP‑1271‑like orders, or a simple `directTrade()` function) as a fallback if the off‑chain book is suspicious.[^10_9][^10_4]
- **Decentralized sequencer set**
Instead of a single operator, run the matching engine on a **validator set** chosen by governance:
    - elected nodes maintain the orderbook
    - matching decisions are aggregated and signed collectively
    - slashing conditions if nodes deviate
Bluefin, LayerN‑style designs, and similar protocols are moving this way.[^10_4][^10_9]
- **Regulatory/compliance‑style reporting**
    - Daily on‑chain **settlement snapshots** (total volume, open interest, liquidation stats)
    - Quarterly audits of the sequencer by an independent firm
    - Public MEV‑like fee‑capture disclosures (e.g. “sequencer captured X% of total slippage”)[^10_10][^10_1]

***

## 4. Trust‑Minimized Architectural Pattern for You

For your perp/options system, a practical transparent stack looks like this:

1. **On‑chain**
    - Non‑custodial collateral vault
    - `executeMatch(EIP‑712 orders, signature, stateRoot)`
    - `commitState(bytes32 root)` for book snapshots[^10_11][^10_2]
2. **Off‑chain**
    - Open‑source matching engine implementing pure price‑time priority
    - Public WebSocket exposing full book + trades
    - Daily state‑root submitted by the sequencer, with a challenge window for proofs[^10_7][^10_8]
3. **User guarantees**
    - **You never lose custody** (funds are on‑chain only)
    - **You can replay and verify** (open‑source code + verifiable state)
    - **You can always fall back** (on‑chain fallback trading path)[^10_9][^10_4]

***

If you tell me whether you’re targeting a **fully self‑hosted** single operator or a **decentralized sequencer set**, I can sketch the exact contract‑level flow and data layout for your case.
<span style="display:none">[^10_12][^10_13][^10_14][^10_15]</span>

<div align="center">⁂</div>

[^10_1]: https://www.binance.com/en/square/post/292299002727250

[^10_2]: https://www.gate.com/learn/course/l2-deep-dives-aevo-aevo/off-chain-orderbook-and-on-chain-settlement

[^10_3]: https://www.ijraset.com/research-paper/real-dex-on-chain-orderbook-dex

[^10_4]: https://learn.bluefin.io/bluefin/bluefin-perps-exchange/trading/orderbook-design

[^10_5]: https://orochi.network/blog/on-chain-vs-off-chain-transactions

[^10_6]: https://ideasoft.io/blog/order-book-dex-development-guide/

[^10_7]: https://arxiv.org/html/2512.23618v1

[^10_8]: https://archetype.mirror.xyz/DVJFtcEcdTqk4DxC3VX4McgyjfktXF05pCG1LFtB4-E

[^10_9]: https://learn.bluefin.io/docs/bluefin-101/orderbook-design

[^10_10]: https://www.chainscorelabs.com/en/blog/security-post-mortems-hacks-and-exploits/front-running-and-mev-exploitation/the-future-of-mev-capture-will-it-move-completely-off-chain

[^10_11]: https://chain.link/article/onchain-vs-offchain-transactions

[^10_12]: https://chain.link/article/confidential-offchain-logic

[^10_13]: https://www.thestreet.com/crypto/innovation/trustless-order-matching-a-zk-matching-engine-poc-

[^10_14]: https://archetype.mirror.xyz/IOvUPajhe9olbEPU-FfHPTG6EdVzE9SkADkC_aF3Pdo

[^10_15]: https://news.ycombinator.com/item?id=46081501


---

# what about following commit-reveal approach for offchain order matching engine:

- user call matching engine with an intent to place order
- engine returns the hash of the state
- user stores the hash
- user calls engine revealing the order

this way engine theoretically can prove it included user order

Yes — a commit-reveal layer can help, but **not in the way you phrased it**. It can prove that the engine *saw* an order before some later time, but by itself it does **not** prove fair inclusion, fair ordering, or best execution.[^11_1][^11_2]

## What your scheme proves

In a commit-reveal scheme, the commitment phase proves that some data was known at a given time without disclosing the data, and the reveal phase proves the revealed data matches the earlier commitment hash. So if the engine returns a state hash after receiving a user's hidden order, that can help prove the order existed before that committed state.[^11_3][^11_4][^11_1]

That is an **inclusion witness**, not a fairness proof. It helps against the engine later claiming “we never received your order,” but it does not stop the engine from delaying reveal processing, reordering revealed orders, selectively omitting them from matching, or matching them at a worse price while still including them somewhere in the committed history.[^11_5][^11_2]

## The core weakness

A state hash is only meaningful if it commits to an **ordered dataset** and users can later obtain a proof that their exact order was included in that dataset. If the engine just returns “hash of state,” but users cannot inspect the underlying committed order queue or get a Merkle inclusion proof, then the hash is mostly a receipt with weak audit value.[^11_4][^11_5]

Even if inclusion is provable, the hard question is still: **was your order processed according to the published matching rules?** Commit-reveal does not answer that by itself, because matching correctness is a statement about the entire book evolution and execution path, not just about one order being present.[^11_2][^11_6]

## What a stronger design looks like

A better version is:

1. User sends `commit = H(order || salt || userNonce)` to the engine and optionally anchors the commitment on-chain or in a public append-only log [^11_1][^11_7].
2. Engine assigns a **sequence number** and publishes a commitment to the ordered intake log, typically via a Merkle root or append-only transparency log root.[^11_7][^11_4]
3. On reveal, the user submits `(order, salt)` and the engine must produce a **Merkle proof** showing the earlier commitment was included at a specific position in the ordered intake log.[^11_4][^11_7]
4. After matching, the engine publishes a new state root plus either a verifiable replay log or a proof that the resulting trades followed the matching policy.[^11_6][^11_5]

This gives you three properties: receipt of submission, ordering in the intake queue, and an auditable post-match state transition. Without the sequence number or ordered log, you only have “I saw something sometime.”[^11_5][^11_7]

## What it still does not solve

Commit-reveal adds latency and cost because it is a two-step flow, and that tradeoff is well-known in derivatives contexts. It also does not solve censorship by itself: the engine can accept the commit, then refuse to reveal, refuse to match, or keep the order in the queue until it is economically irrelevant unless there is a timeout/challenge mechanism or fallback path.[^11_8][^11_9][^11_2][^11_5]

It also does not solve best execution on its own. To claim best execution, you need either deterministic replayable matching logs, fraud proofs, or zk proofs that the engine applied price-time priority or whatever rule you published.[^11_6][^11_5]

## Practical recommendation

So the answer is: **good idea as one layer, insufficient as the full transparency model**. For your system, I would use commit-reveal only for **order intake fairness / anti-front-running**, then pair it with:[^11_1][^11_5]

- an append-only ordered log with sequence numbers[^11_7][^11_4]
- Merkle inclusion proofs for each accepted order[^11_4]
- public replay logs for all matches[^11_5]
- on-chain state root commitments per batch[^11_5]
- a challenge window or fallback direct settlement path if an accepted order is censored[^11_2]

A clean mental model is: **commit-reveal proves “my order existed,” transparency logs prove “where it sat in line,” and execution proofs prove “it was matched correctly.”**[^11_1][^11_7][^11_6]

Would you like a concrete protocol sketch for this, with the exact hashes, Merkle trees, and Solidity interfaces?
<span style="display:none">[^11_10][^11_11][^11_12][^11_13][^11_14][^11_15]</span>

<div align="center">⁂</div>

[^11_1]: https://chain.link/article/commit-and-reveal-schemes

[^11_2]: https://hackmd.io/@FranckC/S17_7RoO6

[^11_3]: https://learn.greeks.live/area/commit-reveal-process/

[^11_4]: https://www.cube.exchange/what-is/merkle-tree

[^11_5]: https://orochi.network/blog/on-chain-vs-off-chain-transactions

[^11_6]: https://github.com/0xMiden/examples/discussions/138

[^11_7]: https://smeiklej.com/files/ccs16.pdf

[^11_8]: https://learn.greeks.live/area/commit-reveal-protocol/

[^11_9]: https://pub.tik.ee.ethz.ch/students/2023-HS/BA-2023-18.pdf

[^11_10]: https://arxiv.org/html/2504.03936v2

[^11_11]: https://www.sciencedirect.com/science/article/pii/S2096720925001393

[^11_12]: https://www.linkedin.com/posts/tomzschach_the-next-big-unlock-for-blockchain-isnt-activity-7354149262349271040-HmKD

[^11_13]: https://arxiv.org/pdf/2512.23618.pdf

[^11_14]: https://www.sciencedirect.com/science/article/pii/S2096720926000436

[^11_15]: https://courses.grainger.illinois.edu/ece598pv/sp2021/lectureslides2021/ECE_598_PV_course_notes13.pdf


---

# if all practical recomendations are implemented, this data can allow user prove the system to be unfair, but it cannot guarantee user that their order is always executed fairly, right?

Yes — that’s exactly right, and you’ve put your finger on the core limitation.

### What the data *can* guarantee

With a full stack (commit‑reveal, ordered intake log, Merkle inclusion proofs, replayable matching logs, on‑chain state roots, and a challenge window), you can guarantee:

- **Receipt:** “My order was received by the engine at time `t`.”
- **Position:** “My order sat at position `k` in the intake queue right before the next matching batch.”
- **Visibility:** “The state root after that batch reflects a state that is consistent with that queue and my place in it.”
- **Challengeability:** “If the engine ran the matching logic incorrectly or censored my order, an honest observer can detect the inconsistency and raise a dispute.”[^12_1][^12_2][^12_3]

That is **reactive** fairness: you can prove retrospectively that the engine was unfair or buggy, and potentially trigger slashing, refunds, or governance action.[^12_4][^12_1]

***

### What it *cannot* guarantee in real time

No design like this can guarantee **proactive, real‑time fairness** in the way you describe:

> “My order will always be executed at the best available price with strict price‑time priority, every time, without delay or censorship.”

Reasons:

1. **Latency and timing races**
Even with commit‑reveal, the engine can still:
    - Delay reveal
    - Batch‑delay your order until the next tick
    - Insert a proprietary or privileged order in front of yours, as long as the resulting batch state is *internally* consistent with the published rules
This is the classic MEV / front‑running / priority‑censorship problem: the engine is still the **exclusive decision‑maker over when and how your order joins the matching pool**.[^12_3][^12_5]
2. **Ordering within the batch**
From the user’s perspective, “price‑time priority” means “whoever arrives first wins at the same price.” But the engine only has a **committed hash** of the state — the **actual ordering decision** still happens off‑chain, and you can’t force the engine to reveal that ordering in real time without recreating the latency and cost of a fully on‑chain CLOB.[^12_6][^12_3]
3. **Censorship via de facto timeout**
The engine can “accept” your order, return a state hash, but then:
    - Never match it, or
    - Match it too late to be economically meaningful
As long as the final state root is consistent with the log, there’s no on‑chain enforcement of “you must match this order within X seconds.” Only the **challenge window** or fallback mechanism can penalize that behavior after the fact.[^12_7][^12_1]
4. **Best‑execution discretion**
Even if the rules are written as price‑time, small relaxations (e.g., “this is our best effort”) are always possible unless the engine is **proven to run the same deterministic matching code** every time, which currently requires either full on‑chain replay or ZK‑style proofs — and those are either expensive or still in the experimental phase.[^12_8][^12_1]

***

### The pragmatic conclusion

You can design a system such that **users can prove unfairness after the fact** with high confidence, but you cannot eliminate the engine’s **operational discretion** in real time. That trade‑off is fundamental:

- **On‑chain CLOB:**
    - You can prove fairness in real time (price‑time is enforced by code).
    - But you pay the gas and latency cost of on‑chain state changes for every order.
- **Off‑chain sequencer + commitment layer:**
    - You get low‑latency trading.
    - Users get **verifiable hindsight** and **contestability**, but not **real‑time guarantees** over execution.

So yes, your intuition is correct: the practical stack you described makes the system **detectably unfair** if it cheats, but it does not and **cannot** guarantee, in the moment, that your order is always executed fairly. That’s the trade‑off of outsourcing matching logic to an off‑chain engine.

<div align="center">⁂</div>

[^12_1]: https://orochi.network/blog/on-chain-vs-off-chain-transactions

[^12_2]: https://www.cube.exchange/what-is/merkle-tree

[^12_3]: https://courses.grainger.illinois.edu/ece598pv/sp2021/lectureslides2021/ECE_598_PV_course_notes13.pdf

[^12_4]: https://arxiv.org/pdf/2512.23618.pdf

[^12_5]: https://www.chainscorelabs.com/en/blog/security-post-mortems-hacks-and-exploits/front-running-and-mev-exploitation/the-future-of-mev-capture-will-it-move-completely-off-chain

[^12_6]: https://www.chainscorelabs.com/de/blog/future-of-dexs-amms-orderbooks-and-aggregators/orderbook-dex-scalability/the-crippling-cost-of-consensus-for-every-order-update

[^12_7]: https://hackmd.io/@FranckC/S17_7RoO6

[^12_8]: https://github.com/0xMiden/examples/discussions/138


---

# is there a more complex setup that guarantees that your order will be processed?

Yes — there are more complex setups that get *much closer* to a **real‑time guarantee** that your order will be processed fairly, but even they are still probabilistic or conditional guarantees, not “absolute, atomic fairness in every scenario.”

***

## 1. **Frequent Batch Auctions + Fair Sequencing**

Instead of a CEX‑style continuous matching engine, you batch orders and clear them at fixed intervals with a deterministic rule (price‑time, pro‑rata, or randomized tie‑breaking).[^13_1][^13_2]

Typical setup:

- Orders land in a **mempool / intake queue** with timestamps.
- A **fair sequencer** (e.g., Fair Sequencing Service, FSS‑style) commits to a **randomized or time‑prioritized order** for the next batch, then executes it.[^13_3][^13_4]
- At the end of the batch, a **zk‑ or fraud‑proof** is submitted to L1 that proves the matching was run exactly as specified.

What this guarantees:

- **Bounded inclusion time:** If your order is accepted by the mempool, the sequencer must include it in the next batch or a small number of batches, or be slashed.[^13_4][^13_5]
- **Fair intra‑batch ordering:** all orders in the batch are treated under the same published rule (no front‑running within the batch).
- **Verifiable execution:** anyone can replay the batch and prove the engine deviated.

What it still does *not* guarantee:

- **Instant execution** — you still wait batch latency (e.g. 0.5–2 seconds).
- **No censorship by the sequencer** — if the sequencer ignores the mempool, you need a challenger or governance fallback.

***

## 2. **ZK Matching Engine (“zk‑DEX”)**

Projects like GRVT use a **hybrid model**: the off‑chain engine matches instantly, but then generates a **zero‑knowledge proof** over the entire matching run and submits it on‑chain.[^13_6][^13_7]

Structure:

- User submits order to the off‑chain matching engine.
- Engine batches orders, runs matching, updates off‑chain state, and **generates a ZK proof** that “all trades were computed correctly according to the code.”
- L1 contract only accepts the new state if the proof is valid.

What this guarantees:

- **Correctness:** the engine *must* run the matching function as written in the circuit; it cannot cheat the logic without breaking the proof.
- **Non‑censorship (if mempool is on‑chain)** — if orders are submitted on‑chain (e.g. as rollup inputs), the sequencer cannot ignore them without being detected.[^13_5][^13_4]

Limitations:

- **Still probabilistic:** ZK circuits are expensive and complex; if one fails, you fall back to fraud‑proof or governance.
- **Still batch‑oriented:** you are not executing in zero latency, and the circuit still has to define a concrete ordering rule.

***

## 3. **Rollup‑style Order‑book + Intents**

You can treat the entire order book as a **rollup** over your perp/options engine, where:

- User orders are **intents** (e.g. “I want to buy 1 call with strike X at premium ≤ Y”).
- A **sequencer** commits to a fixed order of intents.
- A **prover** then runs the matching logic and submits a proof of correct batch execution on L1.[^13_8][^13_6]

This gives you:

- **Cryptographic enforcing of the matching logic** (via ZK) or **in‑bounded‑time enforcement** (via fraud‑proofs).
- **State‑finality governance:** if someone discovers a match was unfair, the fraud‑proof can roll back the disputed state.

Again, this is **not** “every order executes instantly and perfectly,” but it is **executable‑by‑rule‑with‑cryptographic‑finality**.

***

## 4. **The “Strongest” Practical Setup for You**

If you want the strongest possible *practical* guarantee that your order is processed:

1. **On‑chain order submission**
User submits intent as an on‑chain transaction (or as a ZK‑rollup input) so inclusion is **censorship‑resistant**.[^13_4][^13_5]
2. **Fair sequencing service**
A sequencer commits to a **randomized or time‑based order** for the next batch; if it deviates, it can be slashed.[^13_3][^13_4]
3. **Frequent batch‑ Clearing**
Every batch (e.g. every block or 0.5s) uses a **fixed, deterministic matching rule** (price‑time, pro‑rata, random tie‑breaker).[^13_2][^13_1]
4. **ZK‑ or fraud‑proof finality**
The matching engine’s output is wrapped in a **proof** that it was computed correctly by the on‑chain circuit or contract logic.[^13_7][^13_6]
5. **Fallback: direct on‑chain P2P**
If the sequencer/batch system fails to match an order within a time window, the user can fall back to a **direct on‑chain P2P or AMM‑style** interaction, proving unfairness if the batch‑engine claims “we matched it” while the proof disagrees.[^13_1][^13_5]

***

## What this still cannot guarantee

Even this stack cannot guarantee:

- **Instant execution in every market condition** — you still deal with batch latency.
- **No latency or MEV‑style exploitation at the mempool level** — you can minimize it, but not universally eliminate it.[^13_9][^13_8]
- **No protocol‑level attacks** — if the code or the circuit has a bug, the proof only proves that the bug was followed consistently, not that it is correct.

So to answer your question precisely:
**Yes, there are more complex setups** (fair‑sequencer + batch‑clearing + ZK/fraud‑proofs + on‑chain order submission) that **push you much closer to a hard guarantee that your order will be processed fairly**, but they are still **bounded, probabilistic, and latency‑aware** guarantees, not an unconditional, real‑time, “always‑exactly‑fair” atomic guarantee.
<span style="display:none">[^13_10][^13_11][^13_12][^13_13][^13_14][^13_15]</span>

<div align="center">⁂</div>

[^13_1]: https://cow.fi/learn/what-is-mev-resistance

[^13_2]: https://www.binance.com/en-AE/square/post/33036090777314

[^13_3]: https://blog.sei.io/research/how-application-specific-ordering-redistributes-mev/

[^13_4]: https://blog.chain.link/arbitrum-and-chainlink-fair-sequencing-services/

[^13_5]: https://hackmd.io/@FranckC/S17_7RoO6

[^13_6]: https://research.bitwyre.com/zero-knowledge-proofs-for-high-performance-derivatives-exchanges/

[^13_7]: https://www.binance.com/en/square/post/296814487727905

[^13_8]: https://arxiv.org/html/2410.10797v2

[^13_9]: https://www.esma.europa.eu/sites/default/files/2025-07/ESMA50-481369926-29744_Maximal_Extractable_Value_Implications_for_crypto_markets.pdf

[^13_10]: https://www.sciencedirect.com/science/article/pii/S2096720926000321

[^13_11]: https://www.youtube.com/watch?v=Y4n38NPQhrY

[^13_12]: https://dev.to/spalladino/a-beginners-intro-to-coding-zero-knowledge-proofs-c56

[^13_13]: https://blog.availproject.org/nexus-runtime-zk-state-verification-powering-interoperability/

[^13_14]: https://www.archetype.fund/media/the-little-transaction-that-could-sequencers-mev-intents-and-more

[^13_15]: https://www.ey.com/content/dam/ey-unified-site/ey-com/en-us/insights/financial-services/documents/ey-an-introduction-to-maximal-extractable-value-on-ethereum.pdf


---

# i am optimising and considering offchain matching for market makers that make a lot of transactions when price is moving. What if we incorporate some onchain market-maker features, like submitting a parameters for orders like relative price level (to market) and quantity, and shift from market price and then just update these when market-maker decides instead of updating all orders

Yes — that direction is **very sensible**, and in practice it becomes a hybrid between a CLOB and an RFQ/JIT/pegged-order system. It can reduce maker churn **a lot** because the maker updates a compact quote policy instead of constantly canceling and reposting every individual order.[^14_1][^14_2]

## The idea in plain terms

Instead of storing ten explicit limit orders like “bid at 99.5, 99.0, 98.5 …”, the maker posts a **quote template** such as “quote 5 bid levels and 5 ask levels at offsets from oracle/mid, with these sizes and protections”. Then the engine materializes executable orders from that template against the current reference price, so when the market moves the quotes move automatically without the maker resubmitting the whole ladder.[^14_2][^14_1]

That is basically a **parameterized pegged quoting model**. Traditional market makers already think in those terms — spread, skew, inventory target, order levels, size curve — rather than in isolated static orders.[^14_3][^14_1]

## Why it helps

The main benefit is that you compress many updates into one state object. A maker can submit:[^14_1]

- reference source: oracle, mark, midpoint, best bid/ask
- bid/ask spread offsets
- number of levels
- level spacing rule
- size per level or size curve
- inventory skew parameters
- kill-switch / max deviation guard

Then the engine recomputes the effective quotes when price changes, instead of forcing the maker to push a cancel/replace storm. This is especially attractive in options, where one MM may want to maintain dozens of quotes across strikes and expiries and where stale quotes are a major problem.[^14_4][^14_2][^14_1]

## The biggest design choice

The critical question is: **are these quotes firm executable orders, or just maker instructions that the engine may convert into orders?** That distinction matters a lot.


| Model | What it means | Pros | Cons |
| :-- | :-- | :-- | :-- |
| **Materialized resting orders** | Engine continuously derives actual book orders from the template | Familiar CLOB UX, visible depth | Still need deterministic repricing logic |
| **JIT / RFQ style** | Template is just maker willingness; fill is created when taker arrives | Best maker freshness, less stale quoting | Less transparent book, more solver-like |
| **AMM-like pool quoting** | Template feeds a pricing function, not discrete orders | Very cheap operationally | Less exact maker control over fills |

Drift’s JIT design is relevant here: makers compete to fill against the latest oracle rather than relying only on stale resting orders, specifically because fresh maker pricing often beats old book liquidity. Your idea sits in a similar design space.[^14_2]

## What I would recommend

For your use case, I would not make every derived level a literal on-chain order. I would store a **compact maker quote policy on-chain** and let the engine derive executable quotes off-chain, with deterministic rules that can be checked later.[^14_5][^14_2]

A good maker policy object could look like:

```solidity
struct QuotePolicy {
    address maker;
    bytes32 marketId;

    int24 refPriceSource;      // oracle / mark / index / mid
    int256 bidOffsetBps;       // e.g. -40 bps from ref
    int256 askOffsetBps;       // e.g. +45 bps from ref

    uint8 levelsPerSide;       // e.g. 5
    uint16 levelStepBps;       // spacing between levels
    uint128 baseSize;          // first level size
    uint128 sizeStep;          // increment / decrement by level

    int256 inventorySkewBps;   // adjust spread by inventory
    uint32 maxOracleAge;       // stale oracle guard
    uint16 maxRefDeviationBps; // disable if mark diverges from oracle too much

    uint64 expiry;
    uint64 nonce;
}
```

Then the derived quote for level `i` is something like:

- bid price = `ref * (1 - bidOffset - i * step)`
- ask price = `ref * (1 + askOffset + i * step)`
- size = `baseSize + i * sizeStep`

with additional skew based on maker inventory and risk.[^14_1]

## Why this is better than full auto-shifting on-chain

If you try to auto-shift executable orders **on-chain on every price change**, you reintroduce the same scalability problem in a different form. Something still has to trigger recomputation, touch state, and keep the book synchronized with the new reference price. So the efficient design is usually:[^14_6][^14_7]

- **on-chain:** maker policy, collateral, risk limits, signed consent
- **off-chain:** quote derivation, matching, frequent repricing
- **on-chain settlement:** only filled trades and occasional policy updates

That preserves the gas savings while still giving makers a persistent quoted presence.[^14_8][^14_2]

## Main risks you need to handle

This model is good, but only if you constrain it carefully.

- **Reference price manipulation** — if quotes are pegged to mark or mid, attackers may try to move the reference briefly; oracle guards and deviation clamps are mandatory[^14_9][^14_10]
- **Ambiguity** — “relative to market” is dangerous unless “market” is defined exactly: oracle, index, mark, midpoint, or best bid/ask[^14_9]
- **Stale-policy execution** — if the engine delays recomputation, takers may hit stale derived quotes; include freshness windows and reject fills when reference age exceeds threshold[^14_9]
- **Adverse selection** — pegged quotes are easier to pick off during jumps unless the maker can widen spreads, skew inventory, or temporarily disable quoting[^14_1]
- **Fairness** — if the engine materializes quotes privately, users need deterministic derivation rules and auditable fill logs to verify the engine did not selectively improve or worsen quotes[^14_5]


## Best version of this architecture

The strongest design is a **hybrid pegged quote book**:

1. Maker posts a signed/on-chain quote policy with risk bounds and collateral[^14_1]
2. Engine computes live derived quotes from oracle/index/mark[^14_9]
3. Takers interact with visible derived depth, not hidden maker logic
4. On fill, settlement contract verifies:

- maker policy was active
- reference source and timestamp were valid
- derived fill price was consistent with the published formula
- size did not exceed remaining maker limits

That last step is the key. If the contract can verify the fill price formula from the stored policy and trusted reference data, then the engine cannot arbitrarily fill at a worse price while claiming it came from the pegged strategy.[^14_5][^14_9]

## My practical view

So yes — **I think this is one of the best optimizations you can make** for active market makers in a fast-moving derivatives system. It effectively turns many order updates into **parameter updates**, which is much closer to how professional market makers actually manage books.[^14_2][^14_1]

If I were designing it, I would aim for:

- **parameterized maker policies on-chain**
- **off-chain derived quote book**
- **deterministic fill verification on-chain**
- **optional JIT auction for large taker flow**
- **fallback AMM or vault for residual liquidity**[^14_11][^14_2]

That gives you lower maker churn, fresher quotes, and better gas efficiency without fully giving up verifiability.

Would you like me to sketch a concrete Solidity + matching-engine design for this “pegged quote policy” model?
<span style="display:none">[^14_12][^14_13][^14_14][^14_15][^14_16][^14_17][^14_18][^14_19]</span>

<div align="center">⁂</div>

[^14_1]: https://hummingbot.org/strategies/v1-strategies/pure-market-making/

[^14_2]: https://docs.drift.trade/developers/market-makers/orderbook-and-matching

[^14_3]: https://gist.github.com/ariejan/3f85ef242c3c82bcb1edd2589903876c

[^14_4]: https://www.exegy.com/market-structure-option-liquid-data/

[^14_5]: https://docs.aori.io/docs/orderbook

[^14_6]: https://www.chainscorelabs.com/de/blog/future-of-dexs-amms-orderbooks-and-aggregators/orderbook-dex-scalability/the-crippling-cost-of-consensus-for-every-order-update

[^14_7]: https://x.com/marvellousdefi_/status/1938344955044565294

[^14_8]: https://www.gate.com/learn/course/l2-deep-dives-aevo-aevo/off-chain-orderbook-and-on-chain-settlement

[^14_9]: https://help.dydx.trade/en/articles/166981-perpetual-order-types-on-dydx-chain

[^14_10]: https://docs.dydx.xyz/concepts/trading/orders

[^14_11]: https://coinmarketcap.com/academy/glossary/automated-market-maker-amm

[^14_12]: https://gist.github.com/nimaafraz/c4ec7ad5c9408f761e6e5748c6e2e7d5

[^14_13]: https://docs.polymarket.com/developers/market-makers/trading

[^14_14]: https://www.youtube.com/watch?v=9jiy0bMaKyY

[^14_15]: https://www.mexc.com/news/252763

[^14_16]: https://arxiv.org/abs/2411.08145

[^14_17]: https://docs.polymarket.com/market-makers/trading

[^14_18]: https://help.dydx.trade/en/articles/8587511-perpetual-order-types-on-dydx-chain

[^14_19]: https://www.okx.com/web3/build/docs/waas/marketplace-order-model


---

# how would you prioritise orders of different makers if they requoted automatically?

You are asking the **core microstructure question** of a derivatives market maker book: how to decide which maker’s quote wins when multiple makers are auto‑quoting at the same level.

Short answer: in practice, almost all serious systems either:

- **Give priority to the best price, then time**, or
- **Sprinkle the flow proportionally by size among the best‑price quotes**, and
- **Optionally** give the designated Lead Market Maker (LMM) a protected first‑fill slice.

Your auto‑requote model is compatible with all of these, but it changes the **unit of priority** from individual orders to **maker quote‑profiles**.

***

## 1. **Price‑Time Priority on Maker Levels (Simple)**

Treat each **current maker quote at a given level** as if it were a traditional limit order. Priority:

1. **Best price first**
All bids at 101.0 are better than all at 100.8.
2. **Maker quote‑creation time (and revision) second**
If two makers are quoting 101.0, the one whose quote was either:
    - originally created earlier, or
    - last updated earlier (common practice)
gets priority.[^15_1][^15_2][^15_3]

In your auto‑requote system, that might look like:

```solidity
struct MakerQuote {
    address maker;
    uint256 refPrice;          // 100.0
    int128 bidOffsetBps;       // -100 bps
    uint128 size;              // 100
    uint64 lastUpdateTime;     // for price‑time
}
```

For a fill at 101.0:

- layer 1: collect all maker quotes where `ref * (1 + offset) ≈ 101.0`
- layer 2: sort by `lastUpdateTime` (oldest first)
- allocate fill to each maker in that sorted list until the taker quantity is exhausted.[^15_2][^15_1]

**Pros:**

- Trivial to explain and audit.
- Very close to “normal” CLOB behavior.

**Cons:**

- Auto‑requotes that correct by a tiny epsilon can kick the maker to the back of the queue, which is bad for maker‑quote‑churn incentives.[^15_4][^15_5]

***

## 2. **Price‑Size‑Time on Maker Levels (Pro‑Rata)**

Spread the fill **proportionally** among all makers at the best price. Classic “pro‑rata” allocation:

1. **Group by price level**
All makers currently quoting 101.0 form a pool.
2. **Allocate by size share**
Maker A has 70 contracts at 101.0; Maker B has 30 → A gets 70% of the fill at that level, B gets 30%.[^15_6][^15_7][^15_8]

In your system, the engine effectively:

- computes the **current effective size** each maker has at the fill price,
- computes the **total size** at that price,
- allocates taker size `Q` to each maker as `Q * (makerSize / totalCount)`.[^15_5][^15_6]

**Pros:**

- Much smoother for makers; one tiny quote update doesn’t destroy your allocation share.
- Reduces “quote‑jumping” latency‑racing.

**Cons:**

- Harder to explain and verify post‑facto.
- You must define precisely whether you use:
    - raw size, or
    - size adjusted by inventory skew, fee‑structure, or risk.[^15_8][^15_6]

***

## 3. **Lead‑Market‑Maker Protection (LMM‑Style)**

Some exchanges give **designated** market makers a **lead‑first** slice at the best price, then either price‑time or pro‑rata for the rest.[^15_9][^15_10][^15_11]

Typical rule:

- If a **Lead Market Maker (LMM)** is quoting at the best price:
    - the first `X` contracts of a taker order are **reserved for the LMM**.
    - the remaining `Q - X` are allocated to the rest of the book (often pro‑rata).
- If the LMM is not quoting at the best price, the usual rule applies.

In your auto‑requote book, this becomes:

```solidity
mapping(bytes32 level => address leadMaker) lmmAtLevel;
```

At fill time:

- check if `lmmAtLevel[fillPrice] == makerA`
- if yes, grant `min(Q, leadLimit)` to `makerA` first
- then allocate the rest among all eligible makers at that price.[^15_12][^15_11][^15_9]

**Pros:**

- Incentivizes the LMM to keep tighter, more persistent spreads.
- Very attractive for options‑style books that need deep, stable liquidity.

**Cons:**

- It’s **not** “pure” fairness; a retail maker can be outrun at the best price even if they quote tight.
- You must carefully define:
    - which makers are LMMs,
    - what level they “protect” (by strike/expiry?),
    - and how often you re‑evaluate LMM status.[^15_10][^15_13]

***

## 4. **Time‑Pro‑Rata / Hybrid Models (Sophisticated)**

Some modern options‑style engines use **time‑pro‑rata**:

1. **Best price first.**
2. **Among that price, allocate a fixed “priority slice” by time**
    - e.g. the first 50 lots at 101.0 go to the earliest‑arrived maker.
3. **The remaining lots at 101.0 are allocated pro‑rata to all remaining makers at that price**.[^15_14][^15_5]

This gives:

- a small **time‑priority incentive** (reward for being first),
- plus **less‑toxic pro‑rata** for the long tail.

This is attractive for your model because:

- it still favors **stable** makers (who don’t chase price by constantly re‑quoting),
- but **softens** the damage of a periodic re‑quote to the same level.

***

## 5. **How to Map This to Auto‑Quotes**

Because your makers **don’t submit discrete orders**, but instead update a **quote‑policy**, the priority logic must run on **derived instantaneous quotes**, not on static order IDs.[^15_15][^15_16]

Conceptually, your engine:

1. **Lock** a reference price and timestamp when the taker submits.
2. **Snapshot** all active maker quote‑policies.
3. **Derive** effective bid/ask quotes at each level from:
    - reference price,
    - offset,
    - size curve,
    - inventory skew,
    - max size / limits.[^15_17][^15_4]
4. **Apply** a chosen priority rule (price‑time, price‑pro‑rata, or time‑pro‑rata + LMM) **on those derived quotes**.
5. **Write** the allocation per maker on‑chain, with a log that an external observer can replay to check that the rule was followed.[^15_18][^15_4]

This is essentially the **batch‑auction + parameterized quoting** pattern: taker flow arrives, the engine “bakes” the current maker‑quote universe, and allocates using the chosen priority model.

***

## 6. **Practical Recommendation for You**

For your use case (options on perps, with frequent maker‑updates), I would choose:

- **Base rule:**
**price‑pro‑rata within level**, with **maker size** as the share numerator.
- **Optional enhancement:**
    - one **Lead Market Maker** per strike/expiry that gets a **small fixed lead slice** at the best price.
- **For very aggressive options‑style books (very low inventory tolerance):**
    - **price‑time‑priority among makers**: first maker whose quote is at the best price wins, with a tie‑breaker by `lastUpdateTime`.

This keeps two things aligned:

- **Fairness / UX:** feels like a normal book to takers.
- **Maker economics:** rewards persistence, not useless quote‑churn; auto‑requote updates are still a “tune‑your model,” not a frantic latency‑bidding war.[^15_4][^15_8]

If you tell me:

- whether you want **one LMM** or **many equal‑status makers**, and
- whether takers are mostly market orders or limit orders,

I can sketch the **exact matching algorithm** (code‑like pseudocode) for your priority rule.
<span style="display:none">[^15_19][^15_20][^15_21][^15_22][^15_23][^15_24][^15_25][^15_26][^15_27][^15_28][^15_29][^15_30][^15_31][^15_32][^15_33][^15_34]</span>

<div align="center">⁂</div>

[^15_1]: https://www.reddit.com/r/quant/comments/1h1eugq/pricetime_vs_pricesize_priority_orderbooks/

[^15_2]: https://optiver.com/explainers/orders-and-the-order-book/

[^15_3]: https://www.cmegroup.com/tools-information/lookups/advisories/market-regulation/SER-5633.html

[^15_4]: https://arxiv.org/html/2505.12465v1

[^15_5]: https://www.kareljanecek.cz/userfiles/matching-algorithms_16432884904395.pdf

[^15_6]: https://www.euronext.com/sites/default/files/2019-10/Euronext Trading Procedures - Annexe Three - Trading algorithms - EN - 2019.10.18.pdf

[^15_7]: https://rulebook.sgx.com/rulebook/regulatory-notice-416-trade-matching-algorithms-applicable-sgx-dt-market

[^15_8]: https://researchers.mq.edu.au/en/publications/an-empirical-analysis-of-price-and-time-priority-and-pro-rata-tra/

[^15_9]: https://connect.euronext.com/sites/default/files/it-documentation/Euronext Derivatives_How%20the%20Market%20Works%20v5.1.pdf

[^15_10]: https://www.eurex.com/resource/blob/265876/cd151c02c16c6dac364bc8e80827d94e/data/cf2582007e.pdf.pdf

[^15_11]: https://www.eurex.com/resource/blob/2448162/b668c6977c68c4785e74570bd42413c6/data/presentation_trading-safeguards.pdf

[^15_12]: https://www.eurexchange.com/resource/blob/293032/a59e519d0662d45e398d5f79d39009a6/data/cf2022005e.pdf.pdf

[^15_13]: https://www.eurexchange.com/resource/blob/51800/9f9d30305fe3896c1f022f85095b004d/data/er17082e.pdf

[^15_14]: https://www.youtube.com/watch?v=gttv9yBQdqo

[^15_15]: https://docs.drift.trade/developers/market-makers/orderbook-and-matching

[^15_16]: https://docs.dydx.xyz/concepts/trading/orders

[^15_17]: https://hummingbot.org/strategies/v1-strategies/pure-market-making/

[^15_18]: https://docs.aori.io/docs/orderbook

[^15_19]: https://www.linkedin.com/pulse/designating-market-maker-behaviour-limit-order-book-markets-peters

[^15_20]: https://solutionshub.epam.com/blog/post/market-maker-trading-strategy

[^15_21]: https://www.eurex.com/ex-en/trade/order-book-trading/matching-principles

[^15_22]: https://papers.ssrn.com/sol3/Delivery.cfm/861.pdf?abstractid=623890\&mirid=1\&type=2

[^15_23]: https://docs.infor.com/m3udi/16.x/en-us/m3beud/scexechs/gdd1567529734675.html

[^15_24]: https://stackoverflow.com/questions/35238966/modelling-price-time-priority-using-orderbook-data-in-r

[^15_25]: https://th.tradingview.com/scripts/marketmaker/

[^15_26]: https://flexciton.com/blog-news/to-batch-or-not-to-batch

[^15_27]: https://web.stanford.edu/class/cme241/lecture_slides/Tour-OrderBook.pdf

[^15_28]: https://www.sciencedirect.com/science/article/pii/S0307904X16306655

[^15_29]: https://bookmap.com/blog/inside-the-market-order-books-and-what-youre-missing-out-on

[^15_30]: https://www.semanticscholar.org/paper/An-Empirical-Analysis-of-Price-and-Time-Priority-in-Frino-Hill/60220e44c2f31c7f9520d4c4bee65b7cf76c7083

[^15_31]: https://www.youtube.com/watch?v=dLfnEKf1AFo

[^15_32]: https://www.govinfo.gov/content/pkg/FR-2013-12-30/html/2013-31129.htm

[^15_33]: https://www.cftc.gov/sites/default/files/files/submissions/dcodcm/dcm037f.pdf

[^15_34]: https://www.sec.gov/files/rules/sro/cboe/2023/34-98304.pdf


---

# yes, but prices are requoted when market price change automatically, so the first market maker will always be first.

You’re absolutely right: **if you naively apply “price‑time” to auto‑requotes, the first maker will always be first**. The reason is that **every time the engine auto‑requotes that maker’s levels, it “refreshes” their time‑stamp at the best price**, while the other makers either don’t requote or do so slightly later due to latency or model logic.

So your quote literally becomes a **self‑renewing priority monopoly** at the best price, which is exactly what you want to avoid if you care about fairness across makers.

***

## Why the standard “price‑time” breaks here

In a normal CLOB, time priority is meaningful because:

- If you amend an order (price or size), you usually **lose** your time‑priority place at that price.
- If you cancel and replace, you are **reinserted** at the end of the queue at that price.[^16_1][^16_2][^16_3]

That’s the intended friction: you don’t want makers to be able to keep their queue‑position forever by just tweaking numbers.

In your auto‑requote model:

- Every time the reference price moves, the engine **re‑emits** that maker’s quote at the same relative price level with a **fresh timestamp**.
- The matching engine sees “quote at 101.0 from makerA at time `t+1`, `t+2`, `t+3`, …” and keeps it at the **front** of the price‑time queue.[^16_4][^16_5]

So yes, you’ve correctly identified the fragility: **auto‑requote + price‑time = makerA always at the front**.

***

## How to fix it without killing the model

You have two main options:

### 1. **Decouple “quote creation time” from “auto‑requote time”**

Don’t update the **priority time** every time the engine auto‑re‑quotes.

Instead, define:

- `createTime` — when the maker **first enabled** this quote level or policy.
- `lastAmendTime` — when the maker **last changed** the quote policy (offset, size, skew, etc.).

Then apply price‑time priority based only on `createTime` (or `createTime` + `lastAmendTime` only when `amendFlags` actually matter):

```solidity
struct MakerLevel {
    address maker;
    uint128 price;
    uint128 size;

    uint64 createTime;      // fixed when level is first enabled
    uint64 lastAmendTime;   // can change if maker tweaks policy
    bool isNewAmend;        // flag if this amend affects priority
}
```

Auto‑requote changes the `price` and possibly `size`, but **does not change `createTime`** unless the maker explicitly reloads the level (e.g. toggles a flag). This way, makerA does not magically re‑refresh to the front every time the reference moves.[^16_2][^16_1]

### 2. **Switch to Pro‑Rata at the level**

If you really want to keep auto‑requote behavior simple (always update timestamps), then **drop price‑time priority and go fully pro‑rata at the level**.

At fill:

- For each price level, collect **all current effective quotes** from all makers at that price.
- Allocate taker size proportionally to maker size at that level, regardless of who “refreshed” first.[^16_6][^16_7][^16_8]

That solves your problem because:

- There is no queue position; every maker at 101.0 gets a share of every fill at 101.0.
- Auto‑requote is just a way to **re‑compute** your size and price, not a way to hijack the queue.

This is the standard solution used by many derivatives and options‑style venues when they want to avoid quote‑jumping.[^16_7][^16_9][^16_6]

### 3. **Hybrid: Time‑Pro‑Rata at the level**

If you want some time‑based incentive but not a hard queue‑monopoly:

- **First X contracts** at 101.0 go to the maker whose quote **was created earliest** at that price.
- **Remaining contracts** at 101.0 are allocated pro‑rata among all makers at that price.[^16_8][^16_10]

In this model, auto‑requote can:

- keep your quote active,
- but not let you **steal** the first X whenever price moves.

You pair this with the `createTime` / `lastAmendTime` logic above so that only explicit policy changes or level‑reloads trigger a new time‑stamp for the priority slice.

***

## 4. **Practical recommendation for your auto‑requote book**

For your use case, I would:

1. **Decouple** the priority time from auto‑requote timestamps using `createTime`.
2. **Use price‑pro‑rata at each level** as the main allocation rule.
3. **Optionally** add a small **time‑priority slice** for the first‑arrived maker at that level (time‑pro‑rata), if you want to mildly reward persistence.

This gives you:

- **No auto‑requote queue‑hijack** (because `createTime` is sticky).
- **Smooth allocation** across many makers, which is great for options‑style books with thin levels.
- **Explicit, auditable rules** that can be replayed from the on‑chain `QuotePolicy` and fill logs.

If you tell me whether you prefer:

- strict time‑priority‑like behavior, or
- pure pro‑rata, or
- a small “first‑maker” slice,

I can sketch the **pseudocode** for the exact matching logic under each model.
<span style="display:none">[^16_11][^16_12][^16_13][^16_14][^16_15][^16_16][^16_17][^16_18][^16_19][^16_20]</span>

<div align="center">⁂</div>

[^16_1]: https://stackoverflow.com/questions/35238966/modelling-price-time-priority-using-orderbook-data-in-r

[^16_2]: https://microstructure.exchange/papers/priority rules - Microstructure Exchange.pdf

[^16_3]: https://support.deribit.com/hc/en-us/articles/29514039279773-Order-Management-Best-Practices

[^16_4]: https://arxiv.org/abs/2504.00846

[^16_5]: https://www.reddit.com/r/algotrading/comments/1lds26y/broker_with_option_order_placement_latency_200_ms/

[^16_6]: https://www.euronext.com/sites/default/files/2019-10/Euronext Trading Procedures - Annexe Three - Trading algorithms - EN - 2019.10.18.pdf

[^16_7]: https://researchers.mq.edu.au/en/publications/an-empirical-analysis-of-price-and-time-priority-and-pro-rata-tra/

[^16_8]: https://www.kareljanecek.cz/userfiles/matching-algorithms_16432884904395.pdf

[^16_9]: https://rulebook.sgx.com/rulebook/regulatory-notice-416-trade-matching-algorithms-applicable-sgx-dt-market

[^16_10]: https://www.youtube.com/watch?v=gttv9yBQdqo

[^16_11]: https://www.forexfactory.com/thread/62367-what-does-requote-mean

[^16_12]: https://mintlify.com/fatelessdev/autonome/trading/simulator-setup

[^16_13]: https://onlinelibrary.wiley.com/doi/10.1155/2021/9949565

[^16_14]: https://arxiv.org/pdf/2507.05749.pdf

[^16_15]: https://axon.trade/price-time-priority-vs-speed-priority

[^16_16]: https://axon.trade/what-most-smart-order-routers-get-wrong-about-microstructure

[^16_17]: https://connect2.euronext.com/sites/default/files/it-documentation/request-quote-detailed-functional-specification-euronext-cash-markets-external-v53550.pdf

[^16_18]: https://www.luxalgo.com/blog/latency-standards-in-trading-systems/

[^16_19]: https://th.tradingview.com/chart/AXISBANK/VafVJ3O3-What-Is-Market-Microstructure/

[^16_20]: https://www.sciencedirect.com/science/article/pii/S0169207024000062


---

# but create time of first arrived market maker will be the smallest, so on every requote done by contract that market maker will have a priority

You’re absolutely right again — and this is why pure **price‑time** does not work with auto‑requote.

Your logic is correct:

- Maker A creates a quote at 101.0 with `createTime = t0`.
- Maker B later creates a quote at 101.0 with `createTime = t1 > t0`.
- When the engine **auto‑re‑quotes** both levels (e.g. when the reference moves), it recomputes `price = ref + offset`, but **does not touch `createTime`**.
- At fill, Maker A still has the **smallest** `createTime` at 101.0 → Maker A **always** wins the priority at that level.

So even with a fixed `createTime`, you still get **permanent priority for the first maker**, which is effectively a **monopoly at the best price** if they never explicitly disable their level. That’s bad for fairness and competition.

***

## Why this is fundamentally incompatible with “pure price‑time”

Price‑time priority relies on **arrival order** at the level to be meaningful and **dynamic**. In a normal CLOB, if you want to keep your queue‑position, you must either:

- keep your quote unchanged, or
- accept that amending or cancel‑replace will move you to the back of the queue at the new price.[^17_1][^17_2][^17_3]

In your auto‑requote model, the engine is **mechanically re‑projecting** the same maker’s quote onto the level whenever the reference moves, but the maker **never actually amends** it in the CLOB sense. So the “arrival order” becomes **frozen**: the first‑arrived maker is permanently first, and later makers can never catch up.

You can’t fix this with `createTime` surgery alone.

***

## What you *can* meaningfully change

To break the monopoly while keeping auto‑requote, you need to **decouple allocation from pure arrival‑order** and either:

### 1. **Switch to Pro‑Rata at the level**

Forget time‑based priority at the level, and allocate **by size share** at each price:

- At fill at 101.0:
`fill_to_maker = totalTakerAmount × (makerEffectiveSizeAt101 / totalSizeAt101)`.[^17_4][^17_5]

Auto‑requote just updates the maker’s **size and price** at each level, but **does not grant queue‑priority**. The first‑arrived maker may still be large, but they no longer **own** the queue.

**Impact on your concern:**
Maker A no longer has any special `createTime`‑based protection; it just competes on size and skew like everyone else.

***

### 2. **Time‑Pro‑Rata at the level**

Give a **small fixed “priority slice”** to the **earliest‑arrived** maker at that level, then split the rest pro‑rata:

- Let `Q` be the taker amount at 101.0.
- Let `Q_first = min(Q, min(100, makerA_remainingSizeAt101))` go to Maker A.
- Let `Q_rest = Q - Q_first` be allocated pro‑rata to all makers (including Maker A for the leftover).[^17_6][^17_4]

Maker A still benefits from arriving first, but:

- The **slice** is capped (e.g. 100 contracts).
- After that, everyone competes by **size**, not by `createTime`.

This softens the monopoly while preserving *some* incentive to be first.

***

### 3. **Discrete “priority windows” instead of perpetual `createTime`**

If you want to keep time‑based incentives, you can **reset time‑priority** on a schedule or on specific events:

- **Time‑windowed priority:**
At `t0`, the engine snapshots all makers at 101.0 and sets `priorityWindow = t0` + `windowDuration`.
Within that window, price‑time applies.
After the window, the engine **re‑snapshots** and recomputes priority; the first‑arrived maker is **not** guaranteed to still be first.[^17_7][^17_8]
- **Event‑based restart:**
Every time the reference price moves beyond a deviation threshold, the engine **resets** the priority queue at each level, treating all current quotes as “equally arrived” for that window.

In both models, the first‑maker does **not** enjoy a **perpetual monopoly** because the priority order is periodically re‑calculated.

***

## 4. **Hybrid “first‑maker bonus + size cap”**

If you are emotionally attached to rewarding the first maker, you can:

- Give the **first‑arrived** maker a **bonus** (e.g. they get 10% more effective size in the pro‑rata calculation),
- But **cap** the absolute number of contracts they can take from a single taker (e.g. 50 contracts per fill).

Example:

```text
bonusEffectiveSize = min(sizeA, MAX_ABSOLUTE_TAKE)
effectiveSizeA    = sizeA + 0.1 * bonusEffectiveSize
```

Then allocate via pro‑rata using effective sizes. This:

- gives a small edge to the first maker,
- but prevents them from taking all the flow at 101.0 forever.[^17_5][^17_4]

***

## 5. **Your best practical path**

Given your constraints (auto‑requote + many makers + fast reference moves), I would strongly recommend:

- **Drop price‑time priority** as the primary allocation rule.
- **Use pro‑rata within level** (or time‑pro‑rata with a modest first‑maker slice).
- **Optionally** add:
    - a **small size‑based bonus** for the first‑arrived maker, or
    - **time‑windowed** or **event‑based** priority resets if you want to keep explicit time‑sensitive incentives.[^17_8][^17_4][^17_6]

This way, your auto‑requote contract can keep re‑projecting quotes whenever the reference moves, and no single maker is **perpetually** first at the best price. The first maker may still be **large and fast**, but they will not be **immune to competition** from later‑arrived makers.

If you want, I can sketch the **exact pseudocode** allocation logic for one of these rules (e.g. pure pro‑rata, or time‑pro‑rata + first‑maker slice) based on your MakerQuote structure.

<div align="center">⁂</div>

[^17_1]: https://stackoverflow.com/questions/35238966/modelling-price-time-priority-using-orderbook-data-in-r

[^17_2]: https://microstructure.exchange/papers/priority rules - Microstructure Exchange.pdf

[^17_3]: https://support.deribit.com/hc/en-us/articles/29514039279773-Order-Management-Best-Practices

[^17_4]: https://www.euronext.com/sites/default/files/2019-10/Euronext Trading Procedures - Annexe Three - Trading algorithms - EN - 2019.10.18.pdf

[^17_5]: https://researchers.mq.edu.au/en/publications/an-empirical-analysis-of-price-and-time-priority-and-pro-rata-tra/

[^17_6]: https://www.kareljanecek.cz/userfiles/matching-algorithms_16432884904395.pdf

[^17_7]: https://www.sciencedirect.com/science/article/pii/S0307904X16306655

[^17_8]: https://arxiv.org/html/2505.12465v1


---

# what if we do not auto requote immediately but do it at constant interval, so even if you are second on price level 1, after market price change you could become first on price level 2

Yes — that can work, but then you are no longer running strict continuous price-time priority. You are moving to a **discrete-time batch re-quoting model**, where quote priority is sticky inside an interval and only re-normalized at the requote boundary.[^18_1][^18_2]

## What changes economically

In your example, if a maker is second at level 1 and the reference price shifts, then under interval-based repricing that order can indeed end up first at the newly mapped level 2 until the next scheduled requote. That is not necessarily wrong, but it means queue position is now partly determined by the previous interval’s placement, not purely by the current best relative price.[^18_1]

So the matching rule becomes something like:

- quote templates are fixed for epoch $t$
- fills during epoch $t$ use the prices derived from the epoch’s frozen reference snapshot
- only at epoch $t+1$ are all quotes recomputed from the new reference

That is closer to a frequent batch auction or discrete book update schedule than to a continuously repriced pegged order book.[^18_3][^18_1]

## Why it may be good

For market makers, this is often a **feature**, not a bug. It reduces constant queue reshuffling and avoids punishing makers who were already resting competitively just before a small market move.[^18_2]

It also makes the system much cheaper and easier to reason about operationally:

- fewer recomputations
- fewer order-book mutations
- more stable queue positions
- less “micro-jitter” from every oracle tick

That stability can improve maker participation if your product is not competing on sub-millisecond microstructure.[^18_2][^18_3]

## The downside

The tradeoff is that you introduce **intentional staleness**. During the interval, your displayed or effective quotes can be off relative to the latest market, and queue priority can look unfair to someone who submitted a genuinely better quote after the reference moved but before the next refresh.[^18_3][^18_1]

In other words, there are now two notions of “better”:

- better under the current live external market
- better under the frozen pricing epoch

If users think they are trading in a continuous CLOB, they will consider this unfair. If the venue explicitly says “quotes refresh every 100ms / 250ms / 1s epoch,” then it is a valid market design choice.[^18_1][^18_3]

## The right way to define priority

If you do this, you should define priority by **epoch, derived level, and in-epoch time**. For example:

1. At epoch start, freeze `refPriceEpoch`.
2. Derive all maker quote levels from that frozen reference.
3. Within the epoch, maintain normal price-time priority only among quotes at the same derived level.
4. At the next epoch boundary, recompute all levels from the new reference and rebuild queues deterministically.

That way, “second on level 1 becomes first on level 2” is not an accident — it is an explicit consequence of the rules. The important thing is to make the rule deterministic and auditable.[^18_1]

## My design advice

I would avoid partial implicit remapping like “quotes drift between levels continuously but queue order stays from the old state.” That creates weird edge cases and hidden favoritism. Either:

- **continuous repricing + clear queue policy**, or
- **frozen epochs + full deterministic rebuild at each epoch**

The second one is probably better for your optimization goal.[^18_3][^18_1]

A practical version would be:

- epoch length: 100–500 ms for high activity, maybe longer for slower markets
- freeze one trusted reference per epoch
- all taker matches in that epoch use quotes derived from that snapshot
- optionally add a volatility interrupt so if price moves beyond a threshold, the epoch is cut short and quotes refresh early[^18_4][^18_3]

That last part matters a lot, because fixed intervals without a jump guard get toxic during sharp moves.[^18_4]

## My honest view

I think this can be a **good market design** if you present it as discrete-time matching rather than pretending it is continuous price-time priority. The biggest risk is not the mechanics — it is the mismatch between the actual rules and participant expectations.[^18_3][^18_1]

So yes, your example is fine **if** you formalize it as:

- frozen quote epochs,
- deterministic repricing only on boundaries,
- explicit queue priority semantics,
- volatility-based early refresh / trading pause guard.

Otherwise you will get ambiguous situations where “best price” and “best queue position” diverge in a way that feels arbitrary.

Would you like me to write a precise matching-policy spec for this epoch-based model, including how queue priority should be recomputed at each requote boundary?
<span style="display:none">[^18_10][^18_11][^18_12][^18_13][^18_14][^18_15][^18_16][^18_17][^18_18][^18_19][^18_5][^18_6][^18_7][^18_8][^18_9]</span>

<div align="center">⁂</div>

[^18_1]: https://docs.aori.io/docs/orderbook

[^18_2]: https://docs.drift.trade/developers/market-makers/orderbook-and-matching

[^18_3]: https://www.reddit.com/r/quant/comments/1h1eugq/pricetime_vs_pricesize_priority_orderbooks/

[^18_4]: https://help.dydx.trade/en/articles/166981-perpetual-order-types-on-dydx-chain

[^18_5]: https://econpapers.repec.org/article/oupqjecon/v_3a130_3ay_3a2015_3ai_3a4_3ap_3a1547-1621.htm

[^18_6]: https://www.nber.org/system/files/working_papers/w26341/w26341.pdf

[^18_7]: https://www.ecmi.eu/system/tdf/session3_eric_budish.pdf?file=1\&type=node\&id=98\&force=1

[^18_8]: http://conference.nber.org/confer/2013/MDf13/Budish_Cramton_Shim.pdf

[^18_9]: https://academic.oup.com/qje/article/130/4/1547/1916146

[^18_10]: https://www.aeaweb.org/conference/2023/program/paper/aeGED9GA

[^18_11]: https://www.eftconference.business-school.ed.ac.uk/sites/eft_conference/files/2022-06/Zhang-paper.pdf

[^18_12]: https://ideas.repec.org/a/oup/qjecon/v130y2015i4p1547-1621.html

[^18_13]: https://www.linkedin.com/posts/tribhuvan-bisen_market-making-isnt-about-guessing-direction-activity-7384257369700151297-Z21n

[^18_14]: https://jumpcrypto.com/resources/dual-flow-batch-auction

[^18_15]: http://www.cramton.umd.edu/papers2015-2019/budish-cramton-shim-hft-frequent-batch-auctions.pdf

[^18_16]: https://arxiv.org/pdf/1806.05849.pdf

[^18_17]: https://www.citadelsecurities.com/wp-content/uploads/sites/2/2022/03/Market-Lens_Continuous-Trading-vs-Frequent-Batch-Auction.pdf

[^18_18]: https://www.scribd.com/document/971197159/Optimizing-Automated-Market-Makers-in-Frequent-Batch-Auctions

[^18_19]: https://docs.lib.purdue.edu/cgi/viewcontent.cgi?article=1401\&context=open_access_dissertations


---

# since we have blocks in the blockchain anyway, there is an interval. So on each block if price changed we could reorder based on the time shift when first template from market-maker arrived

Yes — that is a coherent rule, and it is probably the cleanest version of your idea. In effect, you treat each block as a **repricing epoch**, and when prices are recomputed at the new block, queue priority among remapped quotes is preserved according to the original template-arrival time or template-sequence number.[^19_1]

## What this means

The market-maker does not own queue position for a literal static limit order forever. Instead, the maker owns queue priority for a **quote template stream**, and each block the system projects that template onto the new price grid.[^19_1]

So if MM A submitted its template before MM B, then after block $n+1$ repricing:

- both templates get remapped to new derived levels,
- and within each resulting price level, A stays ahead of B if A’s template priority is older.

That is a valid market design, but it is no longer standard order-level price-time priority. It is **template-time priority with blockwise repricing**.[^19_1]

## Why this is attractive

This approach solves one of your core pain points: market makers do not need to spam cancels and replaces just to maintain relative quoting around a moving reference price. It also gives stable queue ownership, which is valuable for makers because they are rewarded for maintaining an active quoting policy, not for winning every microsecond repricing race.[^19_2][^19_3]

From a systems perspective it is nice because:

- repricing happens at a natural chain cadence,
- queue rules are deterministic,
- on-chain state can be compact,
- and you avoid pathological churn in fast markets.


## The important caveat

The rule is only fair if priority is preserved **within the same economic quote intent**. If a maker can materially change its template — spread, skew, size curve, number of levels, risk limits — and still keep the old priority timestamp, that creates a strong queue-jumping exploit.[^19_1]

So you need a rule like:

- **non-price-preserving update** → loses priority
- **minor risk-preserving update** → maybe keeps priority
- **pure passive remap caused by reference-price movement** → keeps priority

That distinction is crucial. Otherwise a maker could submit an early template once, then keep editing it into a much better quote forever while retaining ancient priority.

## The right mental model

Think of it like this:

- the **template ID** carries seniority,
- the **block reference price** determines where its quotes land,
- the **derived price level** determines whether it can match,
- and **fill order inside a derived level** follows template seniority.

This is conceptually similar to “pegged orders with stable queue priority across reference moves,” but discretized at block boundaries. That is a reasonable primitive if it is explicit in the market rules.[^19_1]

## Where it can break

There are three main risks.

- **Too much path dependence**: an early maker can dominate future queues just because it was early once, even if its current economics are only marginally competitive.[^19_3]
- **Priority laundering through updates**: if template edits retain time priority too easily, makers can effectively refresh quotes without paying the normal queue-reset cost.[^19_1]
- **Block-edge games**: if block $n$ repricing uses a known or predictable reference, makers may optimize submissions just before the boundary to capture better remapped queue positions.[^19_3]

So the policy around update classes and boundary timing matters as much as the repricing rule itself.

## My recommendation

I think this is a **good design**, with one refinement: priority should be attached not just to “first template arrival,” but to a **template generation hash** representing the economic quoting function. Then:[^19_1]

- if only the external reference changes, priority is preserved;
- if the maker changes the economic function materially, issue a new generation and reset priority;
- if the maker changes only allowed cosmetic fields or loosens quantity downward without improving price, you can choose to preserve priority.

A practical rule could be:

1. On creation, template gets `priorityEpoch` and `templateSeq`.
2. At each block, derive quotes from the latest block reference.
3. Sort by derived price, then by `priorityEpoch/templateSeq`.
4. Any update to offsets, skew, spacing, or aggressiveness resets `priorityEpoch`.
5. Pure block-driven remap does not reset it.

That is clean, auditable, and hard to game.

## My honest take

I would prefer this over trying to preserve order-level timestamps for every synthetic quote. The template is the real object; the per-level orders are just block-by-block projections of it.[^19_2][^19_1]

So yes: **using the block as the repricing interval and preserving template seniority across remaps is a strong design choice**. Just make sure you define exactly which template mutations keep versus lose seniority, because that is where most of the hidden unfairness will appear.

Would you like me to turn this into a formal matching rule set with examples of “update keeps priority” vs “update resets priority”?

<div align="center">⁂</div>

[^19_1]: https://docs.aori.io/docs/orderbook

[^19_2]: https://docs.drift.trade/developers/market-makers/orderbook-and-matching

[^19_3]: https://www.reddit.com/r/quant/comments/1h1eugq/pricetime_vs_pricesize_priority_orderbooks/


---

# we need somehow to track sub block timestamp. Maybe we could use transaction nonce to rotate the order time priority? This would be a nonce of transaction on engine smart contract, not a nonce of eth account of order creator.

Smart direction — using the engine contract's own monotonically incrementing counter as a **logical timestamp** is cleaner than any wall-clock or block-timestamp approach. Let me unpack it properly.

## What "contract nonce" actually means here

The EVM doesn't expose a per-contract call counter natively — EOA nonces track sender accounts, and contract nonces only increment on `CREATE`. What you really want is a **storage-level sequence counter** on the engine contract that increments on every template registration call:

```solidity
uint64 public templateSeq; // global monotonic counter

function submitTemplate(QuotePolicy calldata p) external {
    uint64 seq = ++templateSeq;
    templates[msg.sender][p.marketId] = StoredTemplate({
        policy: p,
        seq: seq,
        blockSubmitted: uint32(block.number)
    });
}
```

Now every template has a globally unique, intra-block ordered sequence number that is **set by EVM transaction execution order** within that block. This is exactly what you need.

## Why it works well

The priority key then becomes:

```
priority = (derivedPriceLevel ASC, seq ASC)
```

A maker who submitted a template earlier — even within the same block — has a lower `seq` and therefore beats a later submitter at the same derived level. This gives you true sub-block ordering without any off-chain timestamp dependency, no trusted clock, and no off-chain oracle for sequencing.

Compared to alternatives:


| Approach | Sub-block ordering | Manipulation risk | Cost |
| :-- | :-- | :-- | :-- |
| `block.timestamp` | ❌ No (per-block) | High (validator sets it ±12s) | 0 |
| EOA nonce | ❌ No (per-sender only) | Medium | 0 |
| **Contract `seq` counter** | ✅ Yes (per-call) | Medium (sequencer tx ordering) | 1 SSTORE |
| `tx.index` in block | ✅ Yes | Medium | 0 (no write needed) |

The contract counter has one advantage over `tx.index`: it also works for **intra-transaction ordering** — if a maker submits multiple templates in a batched call, each still gets a unique `seq`, while `tx.index` would be the same for all of them.

## The real risk: sequencer / block builder ordering

Here is the honest problem. Within a block, whoever controls transaction ordering — the sequencer on an L2 or the block builder on L1 — determines which `submitTemplate` call gets the lower `seq`. That means:

- On a centralized L2 sequencer (Arbitrum, Optimism), the sequencer can favor certain makers by ordering their txs first
- On L1, block builders can sell priority inclusion (MEV/priority fee auctions)
- So `seq` is fair only if the sequencer is either fair or if your makers compete on gas/priority fee openly

If you are deploying on an L2 with a FCFS (first-come-first-served) mempool, the `seq` faithfully reflects submission order. On a priority-fee ordered mempool, it reflects fee competition, which is a different but still legitimate form of priority.

## Combining seq with block number

A cleaner two-level key:

```solidity
struct TemplatePriority {
    uint32 blockSubmitted; // coarse: which block
    uint64 seq;            // fine: which call within or across blocks
}
```

Then priority at the matching layer:

```
sort by (derivedLevel ASC, blockSubmitted ASC, seq ASC)
```

The `blockSubmitted` guards against edge cases where `seq` wraps or resets after an upgrade. It also makes it immediately human-readable: "this template was registered 50 blocks ago and has been resting at derived level 2 since block 1840."

## How repricing at each block uses this

At block `N` when reference price changes:

1. For all active templates, compute new derived price level from `block.number == N` reference
2. Build new sorted order book: group by derived level, sort within each level by `(blockSubmitted, seq)`
3. Templates that **moved up** to a better level get that level's queue position based on their original `seq` — no new submission needed
4. Templates that **moved to a worse** level drop into the back relative to templates that were already there from older blocks

This preserves your earlier insight: "second on level 1 can become first on level 2" — because if two makers both shift from level 1 to level 2, the one with the lower original `seq` leads at level 2.

## One subtle issue: seq inflation attack

If submitting a template is cheap, a maker could submit many low-quality dummy templates early to "reserve" low `seq` values, then update them to competitive quotes later while retaining ancient priority. You need the rule from the previous discussion: **a material template update resets `seq`** by requiring a new submission:

```solidity
function updateTemplate(QuotePolicy calldata p) external {
    // check if update is material (offsets, skew, levels changed)
    if (isMaterialChange(templates[msg.sender][p.marketId].policy, p)) {
        uint64 seq = ++templateSeq; // new seq = priority reset
        templates[msg.sender][p.marketId].seq = seq;
        templates[msg.sender][p.marketId].blockSubmitted = uint32(block.number);
    }
    templates[msg.sender][p.marketId].policy = p;
}
```

Non-material updates — loosening size downward, adjusting risk limits without improving aggressiveness — can optionally preserve `seq`. This forces makers to pay for priority through early honest quoting, not through gaming the counter.

## Bottom line

The contract `seq` counter is the right primitive. It is cheap (one `SSTORE` increment per template submission), unforgeable within the EVM execution order, deterministic, auditable, and gives you exactly the sub-block granularity you need. The only thing to be honest about is that intra-block ordering is ultimately set by whoever orders transactions — which is fair if your sequencer is FCFS, and a known and priced-in risk if it is fee-ordered.

---

# can you summarize this approach to reduce MM churn?

Yes. Here is a compact summary of the approach to reduce market‑maker churn:

***

### Core idea

You **do not represent the market maker as many static limit orders**. Instead, you represent them as a single **quote policy template** (offsets, size rules, risk limits, skew) that is **re‑projected** onto the current market price at each block.

When the price shifts, the engine recomputes where that template lands on the order book rather than waiting for the maker to cancel and repost orders. This preserves their queue priority across moves, but only as long as the template is not materially changed.

***

### How it reduces churn

- Makers **update their policy template once**, instead of spamming many individual order updates.
- The system **remaps quotes automatically** when the reference price changes within a block‑boundary epoch.
- Makers can maintain **competitive pricing around a moving market** without constant explicit cancels and replaces.
- The design is **cheaper** and **more stable**: fewer events, fewer state updates, less noise.

***

### Sub‑block ordering and fairness

To have **fair intra‑block priority**, you add a **monotonically increasing sequence counter** on the engine contract:

- Every `submitTemplate` or materially updated template call increments this counter `seq`.
- The priority key is then:
`(derived price level ascending, seq ascending)`.

This gives you:

- **block‑level granularity** from the chain,
- **sub‑block ordering** from the EVM‑execution sequence,
- and **deterministic, auditable queue positions** without any trusted time source.

***

### Template‑level vs. order‑level

Conceptually, the object that “owns” priority is the **template**, not the synthetic limit orders. At each block:

- The template is mapped to derived levels,
- Within each derived level, fills follow the original template submission time (via `seq`),
- Material changes to the quote economics reset `seq` (i.e., reset the priority clock).

This avoids queue‑jumping via “soft” edits while still rewarding makers who **commit early** to a competitive quoting function.

***

### One‑sentence summary

You reduce MM churn by letting market makers express **relative quoting logic once**, then having the engine automatically re‑map and rebalance their quotes at each block, while using a contract‑level sequence counter to provide deterministic, fair, sub‑block price‑time priority on the resulting derived book.

---

# what are the greeks?

In options and derivatives pricing, the **"Greeks"** are the key sensitivity measures that tell you how an option’s price changes with changes in its inputs. They come from the partial derivatives of the option pricing model (usually Black–Scholes or its variants).

Here are the main ones, with a very short intuition.

***

### 1. **Delta** $\Delta$

- **What it is**: sensitivity to the underlying price.
$\Delta \approx \frac{\partial V}{\partial S}$, where $V$ is the option value and $S$ is the underlying price.
- **Interpretation**:
    - Tells you roughly how much the option price changes per 1 unit move in the underlying (e.g., per 1 USD for BTC call).
    - Also interpreted as the **approximate probability** the option will be in‑the‑money (for calls especially).
- **Sign**:
    - Calls: positive delta (price moves with spot).
    - Puts: negative delta (price moves against spot).

***

### 2. **Gamma** $\Gamma$

- **What it is**: sensitivity of **delta** to the underlying price.
$\Gamma \approx \frac{\partial^2 V}{\partial S^2}$.
- **Interpretation**:
    - Measures how fast your delta changes as the price moves.
    - High gamma means the option is very sensitive to small moves in the underlying, especially near the strike.
- **Risk/return impact**:
    - Long options have **positive gamma** (you like volatility and large moves).
    - Short options have **negative gamma** (you get hurt by large moves and have to rebalance more).

***

### 3. **Vega** $\nu$

- **What it is**: sensitivity to **implied volatility**.
$\nu \approx \frac{\partial V}{\partial \sigma}$.
- **Interpretation**:
    - How much the option price changes per 1‑point change in implied volatility (e.g., 1% higher vol).
    - Increase in volatility raises option premium (good for long options, bad for short).
- **Sign**:
    - Long options: long vega (positive).
    - Short options: short vega (negative).

***

### 4. **Theta** $\Theta$

- **What it is**: sensitivity to **time** (time decay).
$\Theta \approx -\frac{\partial V}{\partial t}$ (often quoted as a **per‑day** change).
- **Interpretation**:
    - How much the option loses (or gains) in value as time passes, all else equal.
    - Options generally **lose value with time** (theta is negative for long options, positive for short): this is time decay.
- **Shape**:
    - At‑the‑money options near expiry have **larger** time decay (big |negative theta|).
    - Far‑OTM or deep‑ITM options decay more slowly.

***

### 5. **Rho** $\rho$

- **What it is**: sensitivity to **interest rates**.
$\rho \approx \frac{\partial V}{\partial r}$.
- **Interpretation**:
    - How much the option price changes if the risk‑free rate increases.
    - Generally small for short‑dated options, larger for long‑danced options.
- **Sign**:
    - Calls: usually **positive** rho (higher rates make calls slightly more expensive).
    - Puts: usually **negative** rho.

***

### 6. Higher‑order or “exotic” Greeks (optional)

In practice, traders often think in terms of:

- **Vanna** / **Volga**:
    - Vanna: change of **delta** with respect to volatility ($\frac{\partial \Delta}{\partial \sigma}$).
    - Volga (or **Vomma**): change of **vega** with respect to volatility ($\frac{\partial \nu}{\partial \sigma}$).
- **Speed**: $\frac{\partial \Gamma}{\partial S}$ – how fast gamma changes with spot.

These are more relevant for options books, exotic derivatives, or sophisticated risk‑management systems.

***

### Mnemonic (for the big four)

A common way to remember the core four:

- **Delta** → **Direction** of the underlying
- **Gamma** → **Acceleration** of delta
- **Vega** → **Volatility**
- **Theta** → **Time** (decays with time)

If you tell me whether you care more about **pricing** (Black–Scholes Greeks), **risk‑management** (PnL sensitivity), or **market‑making hedging**, I can give you a compact formulaic view of how to think about them in your system.
<span style="display:none">[^22_1][^22_10][^22_2][^22_3][^22_4][^22_5][^22_6][^22_7][^22_8][^22_9]</span>

<div align="center">⁂</div>

[^22_1]: https://en.wikipedia.org/wiki/Greeks_(finance)

[^22_2]: https://www.schwab.com/learn/story/get-to-know-option-greeks

[^22_3]: https://www.youtube.com/watch?v=SFebmSYSZA8

[^22_4]: https://www.reddit.com/r/wallstreetbets/comments/flgsk1/options_greeks_for_dummies/

[^22_5]: https://robinhood.com/us/en/learn/articles/3oJP2aXJ9HDFNf1E8y0qls/what-are-options-greeks/

[^22_6]: https://www.tastylive.com/concepts-strategies/option-greeks

[^22_7]: https://www.sofi.com/learn/content/greeks-in-options-trading/

[^22_8]: https://www.learnsignal.com/blog/greeks-options-trading-delta-gamma-theta-vega-rho/

[^22_9]: https://unitedfintech.com/options-greeks/

[^22_10]: https://www.interactivebrokers.com/campus/trading-lessons/introduction-to-options-the-greeks/


---

# ok, for my project (options on perps), how would settlement happen?

For **options on perpetuals** on-chain, settlement is typically a mix of **cash-settled options** (no delivery) + **on-chain or reliable off‑chain oracle** + **clearing‑style collateralization** in a vault / CDP‑style contract. Below is a concrete, “this‑is‑how‑you‑do‑it” view.

***

### 1. Core idea: cash‑settlement, not physical delivery

For options on perpetual futures, you usually settle in **cash / stablecoin / native token**, not by forcing delivery of perp position + spot underlying. That keeps the system simpler and lets you reuse the same perp **mark / index** that your perp already uses.[^23_1][^23_2]

At expiry, the **option pays out a function of the perp price**:

- Call: payout ≈ `max(0, mark_price - strike)`
- Put: payout ≈ `max(0, strike - mark_price)`

Each payout is scaled by:

- option **notional** (e.g., 1 contract = 0.1 ETH)
- per‑option **multiplier**
- **rebase** from perp to quote asset (e.g., if perp is denominated in USD, settle in USDC)[^23_2][^23_1]

You do **not** need to move the underlying perp position on-chain; the option is just a **cash‑settled derivative on the perp price**.

***

### 2. When does settlement happen?

Two main patterns:

- **European style, weekly / monthly expiry**
    - Options are **non‑exercisable before expiry**.
    - Settlement happens **once**: at the end of the expiry block, using a predetermined oracle price snapshot (opening/mark/close) for that block or the last tick of that epoch.[^23_1][^23_2]
- **American‑style or early‑exercisable**
    - Makers list **weekly** options, but takers can **exercise early**.
    - Each exercise triggers an **instant mini‑settlement** against the current perp mark, plus **collateral transfer**; the contract still plans to fully unwind all remaining open options at expiry.

Given your on‑chain engine, the cleaner path for v1 is **European** style; it’s easier to reason about and audit.

***

### 3. How oracle data flows into settlement

You need a **trusted source of perp price** at settlement time. Common patterns:

- Use the **same perp oracle / index as your futures engine** as the **settlement reference**.[^23_3][^23_2]
- Fix the **settlement tick**:
    - e.g., “closing price of perp mark on block = expiry block” or “TWAP‑based fix on expiry epoch”.[^23_2]
- Make the engine publish:
    - `exercisedSettlementPrice(markPrice, block, epoch)` once
    - so later queries are deterministic and anyone can verify payout.

If your perp is already on-chain, you can often just expose:

```solidity
function getSettlementPrice(uint expiryBlock) external view returns (int128 markPrice);
```

and have settlements read that.

***

### 4. Settlement math: who gets what

For a **call option** held by a taker `T` against a maker `M`:

- Notional: `N` (e.g., 10 ETH)
- Strike: `K` (e.g., 3000 USD)
- Perp settlement mark: `P` (e.g., 3200 USD)
- Multiplier: `m` (e.g., 1)

If `P > K`:

- intrinsic value = `(P - K) * m` per unit (e.g., 200 USD)
- liquidation value = `intrinsic_value * N` (e.g., 2000 USD)
- That amount is paid **from maker(s) / clearing pool** to the taker in **settlement asset** (USDC, wstETH, etc.)[^23_1][^23_2]

Puts are the same with `(K - P)`.

If `P <= K` for a call (or `P >= K` for a put), the option is **out of the money** and **worth zero**; no cash is transferred.

This is essentially **cash‑settled European options**, just using the perp mark as the underlying.

***

### 5. How on‑chain mechanics look

Typical smart‑contract sketch:

```solidity
struct OptionPosition {
    address taker;
    address maker;
    uint strike;    // 1e18
    uint expiry;    // block or timestamp
    int128 notional;   // 10000000 = 10 ETH
    bool isCall;
    address settleToken;  // e.g., USDC
}

// global settlement fix
mapping(uint expiry) => uint settledPrice;

function settleExpiry(uint expiry) external onlyKeeper {
    uint mark = getPerpSettlementMark(expiry);
    settledPrice[expiry] = mark;
}

// taker claims payout
function exerciseOrClaim(uint optionId) external {
    OptionPosition memory p = positions[optionId];

    if (p.expiry < block.number) revert;

    uint price = settledPrice[p.expiry];  // must be already fixed
    uint intrinsic = calculateIntrinsic(price, p.strike, p.isCall);
    uint payout = intrinsic.scaleByNotional(p.notional);

    require(payout > 0, "no payout");
    TransferHelper.transfer(p.settleToken, p.taker, payout);
    positions[optionId].notional = 0;
}
```

Key points:

- **settlement happens once per expiry** (no repeated re‑marking).
- The **settlement asset** can be different from the perp quote asset (e.g., perp in ETH, settle in USDC) as long as you define the **exchange rate / quote asset** once.
- **Takers never get the perp position**; they just get the option value in cash.[^23_1]

***

### 6. How maker risk and collateral work

Because you are dealing with **options on perps**, makers are basically **volatility / skew risk takers**, not just linear directional risk. There are two main architectures:

#### A) **LP‑style pool (perp options vault)**

- Makers **deposit collateral** into a **perp‑based options vault**.
- The vault:
    - mints **option tokens** or **credit lines** against that pool.
    - tracks **aggregate delta / vega / gamma / margin**.
    - settles wins / losses internally using the vault’s collateral.[^23_2][^23_1]

Each open option acts as a **claim against the pool**, not a bilateral promise. At settlement, the vault computes total **net PnL** for the expiry:

- If total outcome is **positive for takers**, the vault pays from its collateral.
- If negative (makers win), no payout happens, but collateral can be more safely released.

This is like **DeFi options AMM + perp oracle**.

#### B) **On‑chain bilateral CDP‑style views**

- Each maker has a **“credit line”** that it can use to sell options; the engine tracks **risk‑weighted margin** against the current perp mark and implied vol surface.[^23_1]
- After expiry, the engine:
    - calculates **final PnL** per maker,
    - updates **locked collateral**,
    - and can liquidate under‑margined positions if the PnL is negative.

This is closer to **on‑chain options MM with automatic margin calls**.

Either way, you’ll need:

- **margin model** (VaR‑style, stress‑case‑based),
- **liquidation trigger**,
- and **settlement sweep per expiry**.

***

### 7. Hybrid: on‑chain optins exercise, off‑chain perp operative layer

Since your matching engine is off‑chain, you typically:

- Keep **options positions and settlement logic on‑chain** (exercise, claim, payout, collateral, liquidations).
- Use the **off‑chain engine** to:
    - quote and match **option order flow**,
    - compute **maker‑side Greeks and margin**,
    - enforce **real‑time risk limits**.[^23_3]

So flow is:

1. **Trade** in the off‑chain perp‑options book.
2. **On‑chain settlement**:
    - at expiry: snapshot perp oracle,
    - recapitulate each open option PnL,
    - update balances and disburse cash.
3. **On‑chain liquidation** if a maker’s margin fails post‑settlement.

That gives you **low‑latency off‑chain matching** + **trust‑minimized on‑chain settlement**.[^23_3][^23_1]

***

### 8. Practical recommendation for your project

Given you’re already building an **off‑chain perp‑matched engine** with market makers, I would structure settlement like this:

- **European‑style weekly options** on perp marks, **cash‑settled** in a stable or quote‑side asset.
- **One global perp oracle** per expiry (block‑or‑epoch‑based).
- **Vault‑style option pool** where makers deposit collateral and the engine sells options against that pool; each sold option is a **claim against the pool**.
- **On‑chain settlement function** per expiry:
    - freeze oracle,
    - compute payout per option,
    - transfer cash from vault to takers,
    - update maker collateral and expose PnL.
- **On‑chain liquidation** if after settlement a maker’s collateral is insufficient for its open risk (if you choose to allow residual risk, e.g., for early‑exercisable options).

If you tell me your **preferred model** (full perp‑options AMM + vault, or bilateral maker‑side CDP style), I can draft the exact on‑chain contract skeleton and matching‑engine pseudocode around it for your specific options‑on‑perps market.

<div align="center">⁂</div>

[^23_1]: https://learn.bluefin.io/bluefin/bluefin-perps-exchange/trading/orderbook-design

[^23_2]: https://help.dydx.trade/en/articles/8587511-perpetual-order-types-on-dydx-chain

[^23_3]: https://docs.aori.io/docs/orderbook


---

# On‑chain bilateral CDP‑style views

On-chain bilateral **CDP-style** views make a lot of sense for your setup; they are basically on-chain “order books” tailored to **pairwise agreements** or **uni‑/bi‑lateral credit lines**, not global CLOB matching. Think of them as **per‑participant view of cross‑identity exposures**, instead of a public ladder.[^24_1][^24_2]

### What you actually get

A “bilateral CDP‑style view” essentially means, for each maker–taker pair (or vault–user):

- an **on‑chain credit/limit schedule** (like a CDP collateral ratio, but for quoting or fill capacity),
- a **running exposure view** (size filled, inventories, fees, funding),
- and a **local “book” view** computed from their own policy + global reference (oracle/index/market) at each block.

This is very CDP‑like:

- collateral <-> quote‑limit / inventory capacity
- liquidation condition <-> risk rule / skew / cap
- view refresh <-> at each block against oracle

Instead of a global order book, you expose a **bilateral view** that answers: “Given this counterparty, my current quoting template, and the on‑chain reference, what are my visible levels and sizes right now?”[^24_1]

### How this plugs into your engine

You already have a block‑based repricing epoch with template‑level priority using a contract‑level `seq`. At each block, your engine can surface two things on‑chain:

1. **Per‑maker risk view**
    - `effectiveLimit`, `currentExposure`, `maxAllowablePeggedOrderSize`, `skewRatio`
    - These are state‑derived views, not orders; they just tell the maker: “this is your max quote at this level given current risk.”
2. **Bilateral “book” view**
    - For each maker–taker pair, something like:
        - `makerEffectiveBidLevels`, `makerEffectiveAskLevels`,
        - `takerEffectiveBidLevels`, `takerEffectiveAskLevels`,
        - `crossInterestRate` / `feeSpread` (if you want a CDP‑style funding term).

The key is that **orders themselves are implicit**: they are derived from `(policy + reference + per‑pair view)` at each block, not stored as static limit orders. You only materialize on‑chain fills.

### Why it is “CDP‑style”, not just an order book

A CDP is not just a loan; it is a **view + risk rule + liquidation condition** baked into the contract. In your case, the on‑chain view plays the same role:

- **View**
`getBilateralView(maker, taker)` returns:
    - `bestBidLevel`, `bestAskLevel`, `availableSizes`, `skew`, `maxExposure`.
- **Risk rule**
Embedded in the view logic, e.g., “if inventory skew > 10% cap bid levels.”
- **Liquidation‑like events**
If exposure or risk breaches a bound:
    - maker is “de‑levered” (cannot quote at better levels),
    - or the bilateral view clamps its effective quotes,
    - or the engine refuses to match further until the maker rebalances.

So instead of an AMM‑style constant‑function book or a CLOB‑style public order book, you get **on‑chain exposure‑constrained bilateral views**. This is very natural for markets where you care about **counterparty risk** (e.g., per‑maker credit, per‑vault capacity) rather than just anonymous price‑time priority.[^24_2][^24_1]

### How to expose it cleanly on‑chain

A minimal Solidity‑side sketch (stylized):

```solidity
struct BilateralView {
    // levels relative to reference
    int16 bestBidLevel;
    int16 bestAskLevel;
    uint8 maxBidLevels;
    uint8 maxAskLevels;

    // sizes
    uint128 bidSizes;  // packed or computed from policy
    uint128 askSizes;

    // risk / funding
    int64 inventorySkew;   // -100% to +100%
    uint96 maxExposure;
    uint32 lastUpdatedBlock;
}

function getBilateralView(address maker, address taker)
    public view
    returns (BilateralView memory view)
{
    // 1. resolve current reference (oracle / index / mid)
    // 2. fetch maker’s active quote template
    // 3. apply per‑maker risk rules (skew, inventory, cap)
    // 4. compute derived bid/ask ladder vs reference
    // 5. return view as a read‑only structure
}
```

This function is **pure view**: it re‑executes at each block, so the view is always up‑to‑date with current reference price and latest maker policy. The user’s UI can call this off‑chain to show “this is the book you would see vs this maker right now,” without any on‑chain book storage.

### What you trade off

- **No global visible book**
You lose the “full public order book” UX, but you gain **per‑counterparty optics** and smoother risk‑constrained quoting. This is usually fine for professional MMs that care more about risk and bilateral pricing than about competing on tiny price‑time ticks.[^24_1]
- **Complexity in risk‑view logic**
The `getBilateralView` logic becomes your main on‑chain “matching rule surface”; you need to be very careful about how skew, inventory, and collateral limits are encoded and checked.
- **Limits on “hidden liquidity”**
You cannot neatly hide deep levels from the opponent; any exposure that drives your risk‑rule is reflected in the view. That can be good (transparency) or bad (info‑leak), depending on your design.


### When this is especially strong

This bilateral CDP‑style design shines when:

- you already use **pegged quote templates** (not discrete static orders),
- you care about **per‑maker or per‑vault risk limits**,
- and you want to **avoid an on‑chain CLOB structure** but still give MMs smooth repricing and deterministic views.

In those cases, your “on‑chain bilateral CDP‑style views” are essentially the **risk‑constrained market‑making interface** between the engine and each maker–taker pair, while the off‑chain engine handles the actual matching and settlement.[^24_2][^24_1]

If you want, next step could be to sketch how to wire this view with your `seq`‑based template priority so that each maker’s local “bilateral ladder” still respects the derived‑level queue order you’ve defined.
<span style="display:none">[^24_10][^24_11][^24_12][^24_13][^24_14][^24_15][^24_16][^24_17][^24_18][^24_19][^24_20][^24_21][^24_22][^24_23][^24_24][^24_25][^24_26][^24_27][^24_28][^24_29][^24_3][^24_30][^24_31][^24_32][^24_33][^24_34][^24_35][^24_36][^24_37][^24_38][^24_39][^24_4][^24_40][^24_41][^24_42][^24_43][^24_44][^24_45][^24_46][^24_47][^24_48][^24_49][^24_5][^24_50][^24_51][^24_6][^24_7][^24_8][^24_9]</span>

<div align="center">⁂</div>

[^24_1]: https://www.chaincatcher.com/en/article/2075964

[^24_2]: https://www.youtube.com/watch?v=v3C8qJg3SVM

[^24_3]: https://pmc.ncbi.nlm.nih.gov/articles/PMC3263588/

[^24_4]: https://www.scielo.br/j/rb/a/88PrggnT3Bm6Gw8pjnQFnKc/?lang=en

[^24_5]: https://www.physio-pedia.com/Cleidocranial_Dysplasia_(CCD)

[^24_6]: https://www.basf.com/dam/jcr:d0658bf3-7c7e-422e-87d8-ce9d9f6d701d/basf/www/global/documents/en/investor-relations/sustainable-investments/sustainability-ratings-and-rankings/BASF-SE_CDP_Corporate_Questionnaire_2025.pdf

[^24_7]: https://www.bitcoininsider.org/article/239332/chain-dynamics-collateralized-debt-position-cdp-defi

[^24_8]: https://www.conduit.xyz/blog/onchain-order-books-guide/

[^24_9]: https://www.youtube.com/watch?v=o08yxT7lQSk

[^24_10]: https://taquito.io/docs/on_chain_views/

[^24_11]: https://github.com/0xMiden/examples/discussions/138

[^24_12]: https://berkeley-defi.github.io/assets/material/Fabian-Schar-decentralized-finance-on-blockchain-and-smart-contract-based-financial-markets.pdf

[^24_13]: https://www.bridgestone.com/responsibilities/environment/pdf/response_cdp_2025_web.pdf

[^24_14]: https://www.linkedin.com/posts/cdp-worldwide_cdpsupplychainmembership-datadriven-disclosure-activity-7430141666466058240-xpXb

[^24_15]: https://www.galaxy.com/insights/research/the-state-of-crypto-lending

[^24_16]: https://www.lundbeck.com/content/dam/lundbeck-com/masters/global-site/pdf/sustainability/2026/01-jan/CDP_Response_2025.pdf

[^24_17]: https://dittoeth.com/blog/orderbook

[^24_18]: https://taquito.io/docs/23.0.0/on_chain_views/

[^24_19]: https://cryptolinks.com/news/exploring-the-concept-of-synthetic-assets-in-crypto

[^24_20]: https://www.bis.org/ifc/publ/ifcb49_51.pdf

[^24_21]: https://www.canton.network/blog/on-chain-collateral-for-bilateral-crypto-derivatives-trading

[^24_22]: https://formo.so/blog/unified-web3-cdp

[^24_23]: https://pmc.ncbi.nlm.nih.gov/articles/PMC8310645/

[^24_24]: https://andytudhope.github.io/community/scd-faqs/cdp/

[^24_25]: https://www.jt.com/sustainability/environment/management/pdf/CDP_All_2025.pdf

[^24_26]: https://web3.bitget.com/en/dapp/satoshi-protocol-23934

[^24_27]: https://www.basf.com/dam/jcr:88c19a1c-c74c-4ac1-a5f2-27759b692497/basf/www/global/documents/en/investor-relations/sustainable-investments/sustainability-ratings-and-rankings/BASF-SE_CDP_Corporate_Questionnaire_2024.pdf?vid=cYd_lQgQxmSkGH9ijmZLGXYFvhXfOgJ0

[^24_28]: https://journals.viamedica.pl/folia_morphologica/article/view/68846

[^24_29]: https://sustainability.indoramaventures.com/storage/content/document/environmental/cdp-report-2025.pdf

[^24_30]: https://cdn.orsted.com/-/media/www/docs/corp/com/sustainability/reports---en/orsted-2025-cdp-report.pdf?rev=00673328e17b4d879b396f96922c008f\&hash=1593124235F2E2F6C25C2DD146584AE5

[^24_31]: https://www.networkacademy.io/ccna/network-services/cisco-discovery-protocol-cdp

[^24_32]: https://www.galaxy.com/insights/research/chainlink-oracle-ccip-price-feeds

[^24_33]: https://en.wikipedia.org/wiki/Cisco_Discovery_Protocol

[^24_34]: https://chain.link/article/what-is-a-decentralized-oracle-network-don

[^24_35]: https://www.whatsupgold.com/blog/what-is-cisco-discovery-protocol-cdp

[^24_36]: https://www.diciccio.net/claudio/preprints/Muehlberger-etal-BPMBCF2020-FoundationalOraclePatterns.pdf

[^24_37]: https://networklessons.com/system-management/introduction-to-cdp-cisco-discovery-protocol

[^24_38]: https://xenoss.io/blog/composable-customer-data-platform

[^24_39]: https://cointhinktank.com/upload/Decentralized Finance -- On Blockchain and Smart Contract-based Financial Markets.pdf

[^24_40]: https://arxiv.org/html/2601.08540v1

[^24_41]: https://www.youtube.com/watch?v=RnG5NUZUUuw

[^24_42]: https://www.cdp.it/internet/public/cms/documents/CDP_Report_Impact_Monitoring_1H24_ENG.pdf

[^24_43]: https://www.coinbase.com/developer-platform/products/onchain-data

[^24_44]: https://pmc.ncbi.nlm.nih.gov/articles/PMC4329834/

[^24_45]: https://coinmarketcap.com/academy/glossary/collateralized-debt-position-cdp

[^24_46]: https://www.nadcab.com/blog/cdp-in-defi-protocols

[^24_47]: https://reflexivity-research.webflow.io/all-reports/a-look-into-on-chain-lending-and-under-collateralized-loans

[^24_48]: https://cdn.cdp.net/cdp-production/comfy/cms/files/files/000/009/163/original/CDP___EII_-_Engaging_investors_through_strategic_communication_-_a_guide_for_landscape_and_jurisdictional_practioners_to_win_the_partners_they_need.pdf

[^24_49]: https://docs.cdp.coinbase.com/api-reference/introduction

[^24_50]: https://www.pmi.com/resources/docs/default-source/pmi-sustainability/philip-morris-international-cdp-disclosure-2024.pdf?sfvrsn=3bf54ac8_2

[^24_51]: https://www.ncbi.nlm.nih.gov/books/NBK1270/


---

# how full onchain clob order book would look like

A full onchain CLOB would look conceptually simple and operationally brutal: the chain itself stores the resting order book, enforces price-time priority, and executes matching inside the smart contract on every order placement, cancel, or marketable fill. Every state transition that a centralized exchange engine would do in RAM becomes an onchain storage mutation.[^25_1]

## Core pieces

At minimum you need four things onchain:

1. User balances / margin state.
2. Resting orders with owner, side, price, size, remaining size, timestamp/sequence.
3. Price levels with queue ordering.
4. Matching logic that walks the book and settles fills atomically.

A stripped-down shape looks like this:

```solidity
struct Order {
    uint64 id;
    address trader;
    bool isBuy;
    uint64 priceTick;
    uint128 size;
    uint128 remaining;
    uint64 seq;
    uint64 prev;
    uint64 next;
    uint64 priceLevel;
    bool active;
}

struct PriceLevel {
    uint64 head;
    uint64 tail;
    uint128 totalRemaining;
    bool exists;
}

contract OnchainClob {
    uint64 public nextOrderId;
    uint64 public nextSeq;

    mapping(uint64 => Order) public orders;
    mapping(uint64 => PriceLevel) public bids; // keyed by priceTick
    mapping(uint64 => PriceLevel) public asks; // keyed by priceTick

    uint64 public bestBid;
    uint64 public bestAsk;
}
```

That is the rough storage model: every order is a node in a linked list, and every price level is a FIFO queue.[^25_1]

## How matching works

If a user submits a buy limit order, the contract checks whether it crosses the best ask. If it does, the contract iterates through ask price levels from best to worse, then through queued orders from oldest to newest, decrementing `remaining` and transferring balances until the incoming order is fully filled or no longer marketable.[^25_1]

If anything remains, the contract inserts the leftover as a resting order into the bid queue for its price level and updates `bestBid` if needed. That gives you true onchain price-time priority, but it means one transaction may touch many storage slots and many counterparties.[^25_1]

## What the flow looks like

A simple lifecycle is:

- `depositCollateral()`
- `placeLimitOrder(side, price, size)`
- contract matches immediately against opposite side if crossing
- leftover is appended to the tail of the price queue
- `cancelOrder(orderId)` removes the node from the linked list
- `placeMarketOrder(size)` just walks levels until filled or slippage limit hit
- fills emit events for indexers/UI

In code, the matching core looks roughly like:

```solidity
function placeBuy(uint64 limitPrice, uint128 size) external {
    uint128 remaining = size;

    while (bestAsk != 0 && bestAsk <= limitPrice && remaining > 0) {
        uint64 makerId = asks[bestAsk].head;

        while (makerId != 0 && remaining > 0) {
            Order storage maker = orders[makerId];
            uint128 fill = remaining < maker.remaining ? remaining : maker.remaining;

            maker.remaining -= fill;
            remaining -= fill;

            _settle(msg.sender, maker.trader, bestAsk, fill);

            if (maker.remaining == 0) {
                maker.active = false;
                asks[bestAsk].head = maker.next;
                if (maker.next != 0) orders[maker.next].prev = 0;
            }

            makerId = asks[bestAsk].head;
        }

        if (asks[bestAsk].head == 0) {
            _removeAskLevel(bestAsk);
            bestAsk = _nextBestAsk();
        }
    }

    if (remaining > 0) {
        _insertRestingBuy(limitPrice, remaining);
    }
}
```

That is basically what a full onchain book feels like: nested loops over levels and orders, with settlement inline.

## Data structures you would really need

A naive mapping by price is not enough, because you also need efficient discovery of the next best price. So in practice a full onchain CLOB needs something like:


| Need | Typical structure | Problem |
| :-- | :-- | :-- |
| Find order by id | mapping | Easy |
| FIFO inside a price level | doubly linked list | Many storage writes |
| Find best bid/ask | heap/tree/bitmap | Complex or gas-heavy |
| Enumerate next price level | sorted tree or bitmap scan | Hard on EVM |
| Aggregate level size | cached totals | Extra writes |

So the actual contract often becomes a hybrid of:

- order map,
- price-level linked lists,
- bitmap or tree over occupied ticks,
- cached best bid/ask pointers.

That complexity is why most serious designs avoid a “pure” all-onchain book unless throughput is low or L2 costs are tiny.[^25_1]

## What users would see

From the UI side, it would still look like a familiar book:


| Bid size | Bid price | Ask price | Ask size |
| :-- | :-- | :-- | :-- |
| 12 | 99 | 100 | 8 |
| 15 | 98 | 101 | 10 |
| 20 | 97 | 102 | 11 |

But onchain, each of those rows is not just a number. It is a set of storage slots:

- each level has a queue head/tail,
- each order has links,
- each fill mutates balances, queue links, remaining amounts, and best-price pointers.

That is why a “small” book in UI terms can still be very expensive in contract terms.

## Main limitations

The hard part is not conceptual correctness; it is gas and latency.

- Every cancel/replace is an onchain tx.
- Every match may touch many makers.
- Every partial fill costs more than a full fill against one counterparty.
- Makers must wait for block inclusion, so quotes are stale by construction.
- High-frequency market making becomes nearly impossible on L1 and still painful on many L2s.

This is exactly why full onchain books tend to work better for slower markets, batch auctions, or specialized L2 environments rather than for very fast perpetual-style MM flow.[^25_2][^25_1]

## A realistic architecture

If you insisted on a full onchain CLOB, I would expect it to have:

- discrete price ticks,
- one contract per market or market family,
- margin escrow in the same protocol,
- linked-list orders per price level,
- bitmap/tree for non-empty ticks,
- global monotonic sequence for time priority,
- explicit `postOnly`, `IOC`, `FOK`, and `reduceOnly` flags,
- events consumed by indexers for UI reconstruction.

A more complete order struct would be closer to:

```solidity
struct Order {
    uint64 id;
    uint64 seq;
    address trader;
    Side side;
    uint64 priceTick;
    uint128 originalSize;
    uint128 remaining;
    uint64 prevAtLevel;
    uint64 nextAtLevel;
    uint32 createdBlock;
    OrderType orderType; // limit / IOC / FOK / postOnly
    bool reduceOnly;
    bool active;
}
```


## My practical take

A full onchain CLOB is basically “Nasdaq matching engine logic rewritten as a gas-metered state machine.” It is elegant from a trust-minimization standpoint, but it is expensive, slow to update, and unfriendly to active market makers.[^25_1]

That is why most workable designs move one of these offchain:

- matching,
- quote maintenance,
- or at least order storage.

If you want, I can next sketch:

1. a **full onchain CLOB contract architecture**, or
2. a **hybrid design** showing exactly which pieces stay onchain vs offchain for perps.

<div align="center">⁂</div>

[^25_1]: https://docs.aori.io/docs/orderbook

[^25_2]: https://www.reddit.com/r/quant/comments/1h1eugq/pricetime_vs_pricesize_priority_orderbooks/


---

# do i need to calculate greeks onchain?

Only in very specific designs. In almost all practical onchain derivatives systems you **do not want Greek calculations happening onchain**, because they are expensive, data‑heavy, and better kept offchain or summarized via simpler risk measures.

## When you usually *don’t* need onchain Greeks

- **Vanilla perps or linear futures**: your risk is mostly linear in price and funding/time, not options‑style. You only need onchain:
    - `mark price`, `index price`, `funding rate`, and
    - position size / collateral / liquidation level.
- **MM risk limits and hedging**: the maker’s Greeks (delta, vega, gamma, etc.) are usually computed offchain by the MM engine or keeper bots, then used to decide **which onchain operations to trigger** (e.g., post or edit quotes, hedge on other venues), but not as a primary parameter of the onchain logic.
- **User‑facing Greeks (IV, delta, theta)**: these are UI/SDK data, not settlement logic. You display them offchain from an options‑pricing model, not from the contract.

In those cases Greeks are **analytics / UX / risk‑tooling**, not protocol‑level settlement logic, so they are usually kept offchain.

## When you *might* need onchain Greeks

These are niche, higher‑complexity protocols:

- **Onchain options AMMs or order books**: if you are matching vanilla or digital options, the onchain logic may need:
    - approximate delta hedging formulas for reserves,
    - gamma‑controlled slippage (e.g., “price changes more if Δ²P is large”), or
    - vega‑based risk caps on position / collateral.

But even then, the Greeks are often approximated by **simple formulae or lookup tables** (e.g., `delta ≈ 0.5 + 0.5·(F − K)·slope`, `vega ≈ constant·sqrt(T)`) instead of full Black‑Scholes or stochastic‑vol routines.

- **Onchain automatic hedging or vaults**:
    - an “auto‑delta‑hedged options vault” onchain may need to know portfolio delta per asset to decide how much to mint/burn hedge assets.
    - that delta can be a **pre‑aggregated** per‑user or per‑pool metric, updated offchain and pushed onchain via keepers or oracles, not recomputed live from first‑principles on every trade.
- **Risk‑based collateral systems with options**:
    - if you allow users to hold options and define collateral requirements in terms of option‑style Greeks, you may store or require an onchain gamma‑based buffer or vega‑based margin.

But again, the actual calculus can be pre‑computed offchain and only the **risk number** (e.g., “max potential loss under 2‑sigma move”) is onchain.

## Why full Greek calculations onchain are painful

- **Computation**:
    - Black‑Scholes style Greeks involve `exp()`, `sqrt()`, `log()`, `erf()`‑like functions.
    - EVM is slow and gas‑heavy for these (even with libraries).
    - You pay that every time you touch them in a core loop (matching, margin, liquidation).
- **Storage and state bloat**:
    - If you want Greeks *per‑option* onchain, you add several `uint256`s (delta, gamma, vega, theta, rho) per position.
    - That bloats storage and raises the gas cost of any update.
- **Data and parameters**:
    - To compute Greeks accurately you need:
        - volatility surface,
        - dividends / carry,
        - time‑to‑maturity,
        - sometimes correlation or stochastic‑vol matrices.

Shipping that live onchain is impractical; you either:
    - approximate them as constants or simple time‑decays, or
    - push pre‑computed risk vectors onchain via oracles / keepers.


## A pragmatic rule of thumb

- **Onchain**: keep only the minimal settlement and liquidation state:
    - collateral, sizes, prices, funding, leverage, liquidation thresholds.
- **Offchain**: compute Greeks, hedging recommendations, and “what‑if” scenarios.
- **Onchain exposure**: if you *must* expose options‑style risk to the protocol, push it as:
    - **aggregate risk numbers** (e.g., “total delta” or “max loss bucket”), not full Greeks per leg,
    - or **discrete risk buckets** (e.g., “high‑gamma” vs “low‑gamma”) encoded as flags.

In other words: **compute Greeks where it’s cheap (offchain); enforce simple, robust risk rules where it must be trustless (onchain)**.

If you tell me what kind of derivatives you’re targeting (vanilla perps, options, or basket/vol products), I can sketch exactly which Greeks, if any, you’d sensibly expose or compute onchain.
<span style="display:none">[^26_1][^26_10][^26_11][^26_12][^26_13][^26_14][^26_15][^26_16][^26_17][^26_18][^26_19][^26_2][^26_20][^26_21][^26_22][^26_23][^26_24][^26_25][^26_26][^26_27][^26_28][^26_29][^26_3][^26_30][^26_31][^26_32][^26_33][^26_34][^26_35][^26_36][^26_37][^26_38][^26_39][^26_4][^26_40][^26_41][^26_42][^26_43][^26_44][^26_45][^26_46][^26_47][^26_48][^26_49][^26_5][^26_50][^26_51][^26_52][^26_6][^26_7][^26_8][^26_9]</span>

<div align="center">⁂</div>

[^26_1]: https://www.reddit.com/r/options/comments/11snu56/professional_traders_do_you_calculate_the_greeks/

[^26_2]: https://www.binance.com/en/academy/articles/options-trading-what-are-the-greeks

[^26_3]: https://www.moomoo.com/ca/learn/detail-option-greeks-118039-250893014

[^26_4]: https://crypto.com/en/university/managing-risk-crypto-options-with-greeks

[^26_5]: https://groww.in/updates/greeks-on-option-chain

[^26_6]: https://github.com/gnagel/greeks

[^26_7]: https://www.cryptvestment.com/crypto-option-greeks-masterclass-delta-gamma-theta-vega-and-rho-for-advanced-risk-management/

[^26_8]: https://www.wealthsimple.com/en-ca/learn/advanced-option-greeks

[^26_9]: https://www.risk.net/journal-of-computational-finance/2160393/fast-greeks-by-algorithmic-differentiation

[^26_10]: https://www.cube.exchange/pl/what-is/options-greeks

[^26_11]: https://zerodha.com/varsity/chapter/greek-calculator/

[^26_12]: https://www.youtube.com/watch?v=Pg2aetP48V8

[^26_13]: https://learn.greeks.live/area/option-chain-data-usage/?__r=2.676f547212432f18096fe74d1ca3d5ed

[^26_14]: https://insights.derive.xyz/the-option-greeks/

[^26_15]: https://blog.amberdata.io/options-greeks-explained-managing-risk-in-crypto-derivatives

[^26_16]: https://www.reddit.com/r/options/comments/1f4obwj/calculating_greeks/

[^26_17]: https://www.optionseducation.org/advancedconcepts/understanding-options-greeks

[^26_18]: https://en.wikipedia.org/wiki/Greeks_(finance)

[^26_19]: https://www.quantconnect.com/forum/discussion/3245/using-option-greeks-to-select-option-contracts-to-trade/

[^26_20]: https://chain.link/article/onchain-vs-offchain-transactions

[^26_21]: https://www.linkedin.com/pulse/understanding-on-chain-vs-off-chain-role-layer-2-blockchain-khan-rpwpf

[^26_22]: https://stripe.com/resources/more/onchain-vs-offchain

[^26_23]: https://www.withtap.com/blog/what-is-the-difference-between-on-chain-and-off-chain-transactions

[^26_24]: https://www.marketdata.app/sheets/options/calculate-option-greeks/

[^26_25]: https://www.compilot.ai/academy/glossary/on-chain-vs-off-chain-gating-key-differences-and-use-cases

[^26_26]: https://blockapex.io/onchain-vs-offchain-transactions/

[^26_27]: https://www.reddit.com/r/algotrading/comments/t7ol8k/options_greeks_formulas_computed_on_options_chain/

[^26_28]: https://www.sciencedirect.com/science/article/pii/S0890838925000915

[^26_29]: https://www.tfex.co.th/th/education/knowledge/article/378-378-options-greek

[^26_30]: https://www.investopedia.com/trading/getting-to-know-the-greeks/

[^26_31]: https://www.okx.com/learn/option-greeks-explained-crypto

[^26_32]: https://www.mstock.com/articles/option-greeks

[^26_33]: https://spaceandtime.io/blog/verifiable-off-chain-compute-for-smart-contracts

[^26_34]: https://corporatefinanceinstitute.com/resources/derivatives/option-greeks/

[^26_35]: https://learn.greeks.live/area/on-chain-option-pricing/

[^26_36]: https://alpaca.markets/learn/option-greeks

[^26_37]: https://learn.greeks.live/area/on-chain-requirements/

[^26_38]: https://gregorygundersen.com/blog/2023/10/08/greeks/

[^26_39]: https://crypto.com/ru/university/managing-risk-crypto-options-with-greeks

[^26_40]: https://learn.greeks.live/area/on-chain-options-risks/

[^26_41]: https://www.osl.com/hk-en/academy/article/option-greeks-important-symbols-every-trader-must-know

[^26_42]: https://tradingqna.com/t/why-greeks-values-are-calculated-differently-on-different-platforms/81655

[^26_43]: https://actineo-conseil.fr/why-on-chain-perpetuals-are-the-next-big-frontier-for-defi-traders/

[^26_44]: https://www.reddit.com/r/options/comments/kaf8b6/stupid_question_about_greeks/

[^26_45]: https://www.blockscholes.com/research/block-scholes-x-panoptic-perpetual-option

[^26_46]: https://chainscorelabs.com/en/glossary/trading/derivatives-protocols/options-greeks

[^26_47]: https://www.talos.com/insights/risk-simulations-of-perpetual-contracts-on-digital-assets

[^26_48]: https://www.reddit.com/r/options/comments/1f03dwc/do_i_really_need_to_understand_the_greeks/

[^26_49]: https://chronicle.castlecapital.vc/p/demystifying-options-0-1-guide-defi-options

[^26_50]: https://pi42.com/blog/option-greeks-crypto-explained/

[^26_51]: https://questdb.com/glossary/on-chain-vs-off-chain-settlement/

[^26_52]: https://chainscorelabs.com/en/glossary/defi-protocols/defi-derivatives-protocols/options-greeks


---

# so we definitely need greeks onchain, because we need to know how much the collateral needed?

Yes — if you want **fair, enforceable** margining against option‑style risks (smile, skew, gamma, etc.), you generally need some form of onchain risk model that can compute **Greeks-based collateral per position**, not just notional or naive delta. Offchain risk models are great for UI, quoting, and MM logic, but they are not binding at settlement time.

## When onchain Greeks are necessary

You need them onchain in roughly two situations:

1. **Margin‑constrained options / perps**
where liquidation and collateral are recalculated at any fill or any time trigger, and you must prove that a position is not under‑collateralized relative to some volatility surface, not just a flat IV or static multiplier.[^27_1][^27_2]
2. **Automated liquidation engines**
where LPs or the system can liquidate a position whenever the risk exceeds collateral, and that check must be verifiable and deterministic onchain (Greeks → `PV`, `VaR`, or `IM`).[^27_3][^27_1]

If you only did something simple like “delta × spot × notional”, you could approximate without full onchain Greeks, but once you want to enforce **smile/skew/term structure** or **portfolio‑level netting**, you really want a compact onchain pricing and risk engine that exposes Greeks to the settlement/margin module.

## What “onchain Greeks” usually means in practice

Almost nobody runs full Black‑Scholes or model‑calibration loops onchain. The usual patterns are:

1. **State machine**
    - Oracle brings in a volatility surface or implied vol per tenor.
    - Onchain data structure holds per‑strike/tenor `IV` or smile parameters.
    - Margin module computes PV and Greeks via a **pre‑agreed formula** (e.g., BS for each leg, then add delta, gamma, vega).
2. **Cached Greeks**
    - Offchain engine solves the full model and posts **delta, gamma, vega vectors** as signed or trusted state that can be updated on a schedule.
    - Onchain contract only re‑computes local contributions when a position changes (e.g., `Δnet = Σ Δ_i·q_i`).
3. **Grid + lookup**
    - Store a small spot grid and per‑strike `delta`, `gamma`, `vega` arrays.
    - Onchain computes local risk and collateral via **linear interpolation + known formulas** (cheap but still convex‑model‑aware).

None of these are “full Bloomberg‑style risk engine”; they are small, verifiable, and composable enough to fit within block‑gas constraints.

## Why simple deltas are not enough

If you only tracked `delta × spot` for margin, you are ignoring:

- **Gamma**: rapid P\&L swings when spot jumps, which can blow through collateral in a single move.
- **Vega**: long‑vol exposure where realized vol is higher than used to compute margin, so initial P\&L may look safe but then gets wiped out.

That is why “Greeks‑aware” margining is a core idea in modern derivatives protocols: the collateral must be tied to **potential P\&L via option‑style sensitivities**, not just directional exposure.[^27_2]

## Practical design knobs

Given your market‑maker‑focused design, I would expect something like:

- **Onchain**
    - Per‑market volatility parameters or a small grid.
    - Per‑account net delta, gamma, vega (or compressed per‑strike tenor risk).
    - Collateral obligation = `f(delta, gamma, vega, spot, vol)`.
    - Greeks updated either:
        - on every options‑like fill, or
        - via schedulable update so that mis‑pricing is bounded by design.
- **Offchain**
    - Full volatility surface fitting and calibration.
    - Portfolio‑level risk and stress scenarios.
    - Quote‑pricing engine and optimal hedging deltas.

That way the onchain “Greeks” are just a cheap, agreed‑upon risk picture the engine and traders can both compute the same way, while the heavy math lives offchain.

## Bottom line

If what you mean by “collateral needed” is **real‑option‑style liquidation‑grade margining**, then yes — you almost certainly need at least an onchain representation of delta, gamma, vega (or an equivalent risk surface), because naive notional/flat‑delta rules will be either overcollateralized or brittle to large moves.[^27_1][^27_3]

The key is not to recompute full option models onchain for every tiny change, but to **anchor the contract’s risk view to a compact, onchain state that can be easily updated from an offchain risk engine**.
<span style="display:none">[^27_10][^27_11][^27_12][^27_13][^27_14][^27_15][^27_16][^27_17][^27_18][^27_19][^27_20][^27_21][^27_22][^27_23][^27_24][^27_25][^27_26][^27_27][^27_28][^27_29][^27_30][^27_31][^27_32][^27_33][^27_34][^27_35][^27_36][^27_37][^27_38][^27_39][^27_4][^27_40][^27_41][^27_42][^27_43][^27_44][^27_45][^27_46][^27_47][^27_48][^27_49][^27_5][^27_50][^27_51][^27_52][^27_53][^27_54][^27_55][^27_56][^27_57][^27_58][^27_59][^27_6][^27_60][^27_7][^27_8][^27_9]</span>

<div align="center">⁂</div>

[^27_1]: https://www.youtube.com/watch?v=Xpvkuz4ZtEo

[^27_2]: http://panoptic.xyz/docs/trading/perpetual-options

[^27_3]: https://www.blockchainappsdeveloper.com/on-chain-perpetuals-in-defi-era

[^27_4]: https://learn.greeks.live/path/what-are-the-key-differences-between-on-chain-and-off-chain-custody-for-derivatives-collateral/

[^27_5]: https://chain.link/article/onchain-collateral-management

[^27_6]: https://www.canton.network/blog/on-chain-collateral-for-bilateral-crypto-derivatives-trading

[^27_7]: https://www.linkedin.com/posts/greeks-live-intelligence_how-does-the-use-of-a-token-standard-simplify-activity-7408363131783098368-sAlT

[^27_8]: https://keyrock.com/knowledge-hub/credit-strategies-in-onchain-asset-management-a-guide/

[^27_9]: https://learn.greeks.live/area/required-collateral-crypto/

[^27_10]: https://blog.amberdata.io/options-greeks-explained-managing-risk-in-crypto-derivatives

[^27_11]: https://www.dtcc.com/digital-assets/collateral-appchain

[^27_12]: https://www.reddit.com/r/options/comments/1f03dwc/do_i_really_need_to_understand_the_greeks/

[^27_13]: https://insights.derive.xyz/the-option-greeks/

[^27_14]: https://oakresearch.io/en/analyses/fundamentals/insight-all-about-on-chain-leverage

[^27_15]: https://learn.greeks.live/area/securing-collateral-on-chain/resource/1/

[^27_16]: https://learn.greeks.live/area/critical-risk-measure/resource/2/

[^27_17]: https://learn.greeks.live/area/on-chain-assets/

[^27_18]: https://www.youtube.com/watch?v=BcIwnLvNObo

[^27_19]: https://chain.link/article/defi-derivatives

[^27_20]: https://x.com/Delphi_Digital/status/2032080227430490551

[^27_21]: https://bitnomial.com/blog/crypto-as-margin-collateral

[^27_22]: https://lcx.com/en/understanding-perpetual-dexs-the-future-of-on-chain-derivatives

[^27_23]: https://university.mitosis.org/how-on-chain-perpetual-futures-actually-work-why-theyre-eating-spot-dexs/

[^27_24]: https://learn.greeks.live/area/crypto-options-collateralization/

[^27_25]: https://www.gate.com/learn/articles/everything-is-a-perp/2067

[^27_26]: https://blog.chainlight.io/patch-thursday-exploring-latent-risks-of-on-chain-options-exchanges-part-2-100e205117d6

[^27_27]: https://blog.perp.fi/introducing-multi-collateral-on-perpetual-protocol-fe1f4fa6fb90?gi=1d82db5f683b

[^27_28]: https://github.com/0xperp/defi-derivatives

[^27_29]: https://threesigma.xyz/blog/options/defi-options-collateralization-guide

[^27_30]: https://mixbytes.io/blog/deep-dive-into-defi-derivatives

[^27_31]: https://learn.greeks.live/area/on-chain-requirements/

[^27_32]: https://support.kraken.com/articles/360022835911-inverse-crypto-collateral-perpetual-contract-specifications-derivatives

[^27_33]: https://support.kraken.com/articles/portfolio-management-eea

[^27_34]: https://learn.greeks.live/area/calculating-cryptocurrency-risk/resource/1/

[^27_35]: https://blog.chainlight.io/patch-thursday-exploring-latent-risks-of-on-chain-options-exchanges-part-2-100e205117d6?gi=4a7e675e6d25

[^27_36]: https://learn.greeks.live/area/on-chain-risk-engines/

[^27_37]: https://www.axi.com/int/blog/education/cryptocurrencies/perpetual-futures-contracts

[^27_38]: https://www.21shares.com/en-eu/research/why-did-ethenas-stablecoin-remain-stable-onchain-but-depegged-on-binance

[^27_39]: https://learn.greeks.live/area/perpetual-swaps-collateral/

[^27_40]: https://www.linkedin.com/posts/miklouf_tokenisation-tranched-activity-7417862835944189952-xJ9G

[^27_41]: https://bsic.it/exploring-crypto-primitives-perpetual-futures-and-inverse-contracts/

[^27_42]: https://en.wikipedia.org/wiki/Greeks_(finance)

[^27_43]: https://www.fireblocks.com/report/unlocking-the-next-wave-of-tokenized-assets

[^27_44]: https://coinmarketcap.com/academy/article/crypto-derivatives:-an-ecosystem-primer

[^27_45]: https://www.tfex.co.th/th/education/knowledge/article/378-378-options-greek

[^27_46]: https://blog.chainlight.io/exploring-defi-options-and-their-latent-risks-part-1-9e82bdabedd7

[^27_47]: https://privatebank.jpmorgan.com/apac/en/insights/markets-and-investing/demystifying-stablecoins

[^27_48]: https://support.kraken.com/articles/options-portfolio-margining-demo

[^27_49]: https://www.blockscholes.com/research/premia-x-block-scholes-introducing-kyan

[^27_50]: https://crypto.com/en/university/managing-risk-crypto-options-with-greeks

[^27_51]: https://learn.greeks.live/path/what-is-the-function-of-an-on-chain-margin-account-for-derivatives-trading/

[^27_52]: https://www.etoro.com/options/greeks-explained/

[^27_53]: https://arxiv.org/html/2512.20190v1

[^27_54]: https://www.binance.com/en/blog/futures/91001745549966134

[^27_55]: https://www.youtube.com/watch?v=ErrqJIBBEi0

[^27_56]: https://www.finextra.com/pressarticle/103890/canton-network-rounds-up-users-for-on-chain-collateral-management-service-for-bilateral-derivvatives

[^27_57]: https://chain.link/article/cross-chain-collateral-management

[^27_58]: https://www.pier.or.th/files/dp/pier_dp_162.pdf

[^27_59]: https://www.kaiko.com/reports/how-perp-contract-specs-impact-volume

[^27_60]: https://learn.greeks.live/area/on-chain-operations/


---

# give me a simple explanation of how much collateral needed for position in options with numerical example

For a simple options position, the **minimum collateral** is roughly the amount of money you would lose if the option went completely against you, plus a buffer for volatility and “margin of error.” Practically, this is usually something like:

```
Collateral ≈ Max possible loss + margin buffer
```

Below is a clean numerical example with plain vanilla options.

***

### Setup

- Underlying: ETH = \$3,000
- Contract type: European call options (1 lot = 1 ETH equivalent)
- Strike: \$3,300 (out of the money call)
- Premium: \$150 per option (you pay it when you buy)

You are a **buyer** of 1 call.

#### 1. For a long call option (you bought it)

Your **maximum loss** is what you paid:

- Premium = \$150
- Worst case: option expires worthless.

A very simple collateral requirement is just:

- **Collateral ≈ premium paid = \$150**

This is “clean” from the exchange’s view: you cannot lose more than what you put in, so they only need your initial premium as collateral.

#### 2. For a short (sold) call option

You **sold** 1 call for \$150.

Now your **risk is asymmetric**:

- If ETH goes to \$0: you keep \$150 (no extra loss).
- If ETH goes to \$5,000: the call can be exercised, so you must deliver 1 ETH for \$3,300, but you bought it for \$5,000 → loss ≈ \$1,700.

Ignoring time value and discrete details, the **theoretical max loss** is:

- **Max loss ≈ spot price – strike + premium received**
(or just ≈ “unbounded” in practice, since spot can go very high)

Exchanges normally do **not** set collateral to infinity. Instead they use:

- **Delta‑style margining for short options**
Collateral ≈ `Delta × spot × size` + buffer

For a short 3,300 call, delta is, say, 0.4 (40% chance to be ITM):

- **Delta margin estimate**:
    - `0.4 × \$3,000 × 1 = \$1,200`

Modern exchanges then add a **volatility / smile buffer**:

- Volatility buffer ≈ 10–20% of that
- So total collateral ≈
    - `\$1,200 + 15% × \$1,200 ≈ \$1,380`

So practical rule of thumb:

- **Buyer collateral** ≈ Premium paid
(e.g., \$150 for your 3,300 call).
- **Seller collateral** ≈ About 40–60% of spot × size, adjusted by delta and volatility
(e.g., ≈ \$1,380 for a 3,300 short call).

***

### Summary

- **Long option (buyer):**
Collateral ≈ what you paid for the option, because that’s your max loss.
Example: \$150 for a 3,300 ETH call.
- **Short option (seller):**
Collateral ≈ `Delta × spot × size` + volatility buffer.
Example: for a 40% delta call on ETH at \$3,000, you may need ≈ \$1,200–\$1,400 collateral per contract.

If you want, I can next show how **Greeks (delta, gamma, vega)** mechanically translate into a concrete onchain formula for that collateral number.
<span style="display:none">[^28_1][^28_10][^28_2][^28_3][^28_4][^28_5][^28_6][^28_7][^28_8][^28_9]</span>

<div align="center">⁂</div>

[^28_1]: https://fastercapital.com/topics/calculating-and-managing-collateral-requirements.html

[^28_2]: https://www.youtube.com/watch?v=gKYhJsayZfs

[^28_3]: https://www.asx.com.au/content/dam/asx/investors/investment-tools-and-resources/online-courses/advancing-in-options/advancing-options-module_3_Writing_options_and_margins.pdf

[^28_4]: https://www.nodalexchange.com/wp-content/uploads/Margining_Styles_for_Options-Overview.pdf

[^28_5]: http://www.fastercapital.com/content/Collateral-Requirement--Securing-Your-Position--Understanding-Collateral-Requirements-for-Naked-Puts.html

[^28_6]: https://www.chicagofed.org/-/media/others/markets/collateral_estimation.pdf

[^28_7]: https://www.reddit.com/r/algotrading/comments/lj37ih/what_is_a_good_model_for_calculating_collateral/

[^28_8]: https://www.asx.com.au/documents/resources/advancing-options-module_3_Writing_options_and_margins.pdf?advancing_options_course_03_text

[^28_9]: https://sensainvestments.com/options-margin-requirements/

[^28_10]: https://www.home.saxo/en-hk/products/margin-information


---

# now use the same example and show the role of greeks, and how are they calculated in simple examples

Nice, let’s take a concrete simple example and walk through **what Greeks are**, why they matter for collateral, and how they are computed in a basic Black‑Scholes‑style setting.

***

## 1. Concrete example: 1 short call

You run a perps‑style options engine and you have a user with:

- **Position**: short 1 call option
- **Underlying**: spot price $S = 100$
- **Strike**: $K = 100$
- **Time to expiry**: $T = 0.25$ (3 months)
- **Volatility**: $\sigma = 0.3$ (30%)
- **Rate**: $r = 0$

Using Black‑Scholes, the call price is roughly:

$$
C(S) \approx 8.6
$$

If the user is **short** this call, the **mark‑to‑market PV** is roughly $-8.6$: the user is short 1 call worth 8.6 at the current parameters.

### Collateral intuition without Greeks

If you only used **notional** or **delta‑only**, you might say:

- “Notional = 100” → require some 10–20 units of collateral.
- Or “delta ≈ 0.5” → collat ≈ $0.5 \times 100 = 50$.

But neither of these capture the **true option‑style risk**. If the spot jumps to 130, the call value can easily be 30+ and the short loses 20+ units in a single move, blowing through a 10‑ or 50‑unit margin.

That is why you need **Greeks**.

***

## 2. What are the key Greeks?

For this short call, the main Greeks are:

- **Delta** ($\Delta$):
How much the option’s value changes per unit move in spot $S$.
For a call, $\Delta \in (0,1)$.
- **Gamma** ($\Gamma$):
How much **delta** itself changes per unit move in spot.
For a call near the money, $\Gamma > 0$.
- **Vega** ($\nu$):
How much the option changes per unit change in volatility $\sigma$.

In Black‑Scholes, the formulas for a call are:

$$
\begin{align*}
\Delta_C &= \N(d_1) \\
\Gamma_C &= \frac{N'(d_1)}{S \sigma \sqrt{T}} \\
\nu_C &= S N'(d_1) \sqrt{T}
\end{align*}
$$

where:

$$
\begin{align*}
d_1 &= \frac{\ln(S/K) + (r + \sigma^2/2)T}{\sigma \sqrt{T}} \\
N'(x) &= \frac{1}{\sqrt{2\pi}} e^{-x^2/2}
\end{align*}
$$

For your example $S = K = 100$, $r = 0$, $\sigma = 0.3$, $T = 0.25$:

- $d_1 \approx 0.04$
- $\Delta \approx 0.52$
- $\Gamma$ is positive and non‑trivial (option is sensitive to S)
- **Vega** is also meaningful (vol jump directly hits the option).

This means:

- **Delta** tells you the “linear” sensitivity:
if $S \to 101$, call price ~ increases by about 0.52.
- **Gamma** tells you that **delta gets larger** as S moves up, so the loss accelerates.
- **Vega** tells you that if vol jumps from 0.3 → 0.4, the call will jump in value, hurting the short position.

***

## 3. How Greeks determine collateral

Imagine two stylized margin rules:

### Rule A (naive): collateral = notional · factor

- Notional = 100, factor = 10% → collat = 10.

But spot moves up 20% → call now worth 30+ vs original 8.6, and short position is in deep loss, but only had 10 in collat. That’s under‑collateralized.

### Rule B (delta‑only): collat ≈ |delta| × spot

- delta ≈ 0.52, spot 100 → collat ≈ 52.

Better, but still misses:

- When S → 120, delta → 0.9 → exposure is effectively 0.9×120 = 108, but your “collateral” was only 52, so you still have tail risk.
- Volatility jumps and option value jumps; delta‑only does not see vega‑style risk.


### Rule C (Greeks‑based):

A cleaner style is:

- **Collateral** depends on worst‑case move in:
    - spot (via delta and gamma), and
    - volatility (via vega),
within a design horizon (say 1 hour or 1 block).

In a very simple scalar version it can look like:

$$
\text{Collateral needed} \approx
|\Delta| \cdot \text{maxShock} + \frac{1}{2} \Gamma \cdot (\text{maxShock})^2
+ \text{vega} \cdot \text{volShock}
$$

For your short call:

- delta ≈ 0.52 → linear shock component,
- gamma > 0 → **convex** loss tail when S moves up,
- vega > 0 → if vol spikes, the call price jumps.

If you ignore gamma and vega, your margin model will **systematically underestimate tail risk** for short options and certain perp‑style products that behave like options.

***

## 4. How Greeks are “calculated” onchain in practice

You would almost never solve the full $d_1$ integral onchain for every tick. Instead:

1. **Parameters are stored**:
    - per‑strike / tenor: $(K, T, \sigma)$
    - spot $S$ comes from an oracle
2. **Pre‑agreed approximation** is used onchain:
either:
    - a small grid of precomputed $\Delta, \Gamma, \nu$ at key spots, or
    - a cheap closed‑form approximation of $N(d_1)$ and $N'(d_1)$.
3. **Onchain collateral hook**:
    - When a position is created or updated, the engine updates the stored spot/vol or quotes new Greeks;
    - The onchain contract fetches or recomputes:
        - per‑position Greeks,
        - portfolio‑net Greeks,
        - and applies the risk formula above.

In code, you might see:

```solidity
function getCollateralWithGreeks(
    int256 delta,      // -1.5 if short 1.5 calls
    int256 gamma,      // convexity
    int256 vega,       // vol sensitivity
    uint256 spot,
    uint256 maxSpotDeltaShock,  // 5% in ticks
    uint256 maxVolDeltaShock    // 5% vol increase
) external pure returns (uint256) {
    int256 linearPart = delta * int256(maxSpotDeltaShock * spot) / 100;
    int256 convexPart  = gamma * int256(maxSpotDeltaShock ** 2) / 2;
    int256 volPart     = vega * int256(maxVolDeltaShock);

    return uint256(-linearPart - convexPart - volPart);
}
```

That is a stylized version of what “onchain Greeks‑based collateral” looks like.

***

## 5. Role of Greeks in your design

In your hybrid CLOB‑style matching engine with MM‑friendly quoting:

- **Offchain engine**:
    - Solves full models / volatility surface,
    - Computes and refreshes per‑strike Greeks for each maker’s templates,
    - Suggests or constrains allowed quote ranges and leverages.
- **Onchain contract**:
    - Stores net position Greeks per trader (or at least per‑option‑like leg),
    - Applies a **simple, deterministic risk formula** using delta, gamma, vega,
    - Triggers liquidation or margin checks based on that formula.

This way the **heavy Greeks** live where they are cheap (offchain), and the **binding collateral / liquidation logic** lives onchain but acts on a compact risk vector (Greeks) that both sides can compute the same way.

***

## 6. Conclusion with your example

For the **1 short call at 100, 0.3 vol, 3 months**:

- **Delta** controls baseline directional exposure.
- **Gamma** tells you that loss accelerates as spot moves up; ignore it and you under‑collateralize.
- **Vega** tells you that vol jumps directly hurt the short; ignore it and you ignore volatility‑tail risk.

So yes — if you want robust collateral that actually bounds losses for options‑style exposures, **you need Greeks onchain** (or at least enough of them to compute a risk‑aware margin vector), not just spot × notional or crude delta.

If you want, next I can sketch a concrete **onchain struct + pseudocode** that takes your maker’s quote templates and maps them into a per‑account DP‑ready risk vector (delta, gamma, vega) that the engine updates and the contract checks.
<span style="display:none">[^29_1][^29_10][^29_11][^29_12][^29_13][^29_14][^29_15][^29_2][^29_3][^29_4][^29_5][^29_6][^29_7][^29_8][^29_9]</span>

<div align="center">⁂</div>

[^29_1]: https://www.wealthsimple.com/en-ca/learn/option-greeks

[^29_2]: https://www.youtube.com/watch?v=8107gb50UOY

[^29_3]: https://www.britannica.com/money/option-greeks-delta-theta-gamma-vega

[^29_4]: https://www.optionsplaybook.com/options-introduction/option-greeks

[^29_5]: https://journalplus.co/tools/options-greeks-calculator/

[^29_6]: https://www.sahi.com/blogs/6-understanding-option-greeks

[^29_7]: https://www.tradingblock.com/calculators/option-greeks-calculator

[^29_8]: https://www.venturasecurities.com/blog/options-trading-understanding-delta-gamma-theta-and-vega/

[^29_9]: https://www.cmcmarkets.com/en-gb/options-trading/understanding-options-greeks

[^29_10]: https://www.learnsignal.com/blog/greeks-options-trading-delta-gamma-theta-vega-rho/

[^29_11]: https://optionalpha.com/learn/options-greeks

[^29_12]: https://www.investopedia.com/trading/getting-to-know-the-greeks/

[^29_13]: https://www.schwab.com/learn/story/get-to-know-option-greeks

[^29_14]: https://www.merrilledge.com/investment-products/options/learn-understand-vega-options

[^29_15]: https://www.tfex.co.th/th/education/knowledge/article/378-378-options-greek


---

# so greeks are just derivatives of option price?

Yes — in the simplest mathematical sense, **Greeks are just derivatives of an option price function** with respect to various inputs.

For a vanilla option model, the price is a function

$$
C = C(S, K, T, r, \sigma)
$$

of spot $S$, strike $K$, time to expiry $T$, interest rate $r$, and implied volatility $\sigma$. The Greeks are partial derivatives of $C$ with respect to each of these.

Most common ones:

- **Delta** $\Delta = \frac{\partial C}{\partial S}$: sensitivity of price to spot
- **Gamma** $\Gamma = \frac{\partial^2 C}{\partial S^2} = \frac{\partial \Delta}{\partial S}$: sensitivity of delta to spot (acceleration)
- **Vega** $\nu = \frac{\partial C}{\partial \sigma}$: sensitivity to implied volatility
- **Theta** $\Theta = \frac{\partial C}{\partial T}$: sensitivity to time decay
- **Rho** $\rho = \frac{\partial C}{\partial r}$: sensitivity to interest rate

So yes, Greeks are **formally** just derivatives of the option price.
But in practice, “tracking Greeks” onchain usually means:

- using a known model (e.g., Black–Scholes) or an agreed functional form,
- computing or storing the values of those derivatives at the current state,
- then using those values inside onchain risk/margin rules instead of raw prices alone.

For your system, you don’t need to re‑invent derivations; you just need to commit to a **model + definition** (e.g., “vega is the partial derivative of our chosen option price w.r.t. vol”) and reproduce it consistently onchain for margin and liquidation.
<span style="display:none">[^30_1][^30_10][^30_11][^30_12][^30_13][^30_14][^30_15][^30_2][^30_3][^30_4][^30_5][^30_6][^30_7][^30_8][^30_9]</span>

<div align="center">⁂</div>

[^30_1]: https://en.wikipedia.org/wiki/Greeks_(finance)

[^30_2]: https://www.schwab.com/learn/story/get-to-know-option-greeks

[^30_3]: https://unitedfintech.com/options-greeks/

[^30_4]: https://www.youtube.com/watch?v=SFebmSYSZA8

[^30_5]: https://www.binance.com/en/academy/articles/options-trading-what-are-the-greeks

[^30_6]: https://www.macroption.com/binomial-option-pricing-calculator-greeks/

[^30_7]: https://www.optionseducation.org/advancedconcepts/understanding-options-greeks

[^30_8]: https://www.tradingblock.com/calculators/option-greeks-calculator

[^30_9]: https://tastytrade.com/learn/trading-products/options/options-greeks/

[^30_10]: https://alpaca.markets/learn/option-greeks

[^30_11]: https://www.daytrading.com/greeks-options-pricing

[^30_12]: https://www.etoro.com/options/greeks-explained/

[^30_13]: https://www.interactivebrokers.com/campus/trading-lessons/introduction-to-options-the-greeks/

[^30_14]: https://databento.com/blog/option-greeks

[^30_15]: https://www.reddit.com/r/wallstreetbets/comments/flgsk1/options_greeks_for_dummies/


---

# delta is the first derivative, gamma is the second, vega is a different beast

You’re right — and that difference matters for both risk intuition and onchain design.

- **Delta** is the first derivative of price with respect to underlying (spot/future):
$\Delta = \partial P / \partial S$.
It governs *directional* exposure: how much the position’s value changes for a small move in the underlying, and it’s the main lever for “hedging” with the underlying itself.
- **Gamma** is the second derivative:
$\Gamma = \partial^2 P / \partial S^2$.
It governs *convexity*: how fast your delta changes with spot. High gamma means delta swings quickly; small spot moves can suddenly flip your hedge, so you need to **rebalance more often** and provision more collateral to cover the nonlinearity.
- **Vega** is not a second derivative in the same direction; it is the first derivative with respect to **implied volatility**:
$\nu = \partial P / \partial \sigma$.
Vega tells you how sensitive the option value is to a change in the *volatility assumption*, so it measures **uncertainty risk / model risk** rather than pure spot risk.

In practice:

- **delta** is about directional exposure,
- **gamma** is about how fast that exposure changes,
- **vega** is about sensitivity to volatility mis‑pricing, jumps, or a “wrong” skew/smile.

When you design onchain margin that respects option‑style risk, you typically want to incorporate:

- **delta** so you know directional exposure to the underlying,
- **gamma** so you don’t underestimate P\&L in jumps,
- **vega** so you penalize highly vol‑sensitive positions whose fair value can swing if realized vol differs from implied vol.

So conceptually, gamma and vega are “different beasts” shaped by different shocks (spot vs vol), and both should be part of any serious onchain risk view you want to enforce.
<span style="display:none">[^31_1][^31_10][^31_11][^31_12][^31_13][^31_14][^31_15][^31_2][^31_3][^31_4][^31_5][^31_6][^31_7][^31_8][^31_9]</span>

<div align="center">⁂</div>

[^31_1]: https://www.merrilledge.com/investment-products/options/learn-understand-vega-options

[^31_2]: https://www.reddit.com/r/options/comments/p6gbvx/a_comprehensive_greeks_guide_part_1_vega/

[^31_3]: https://tastytrade.com/learn/trading-products/options/vega/

[^31_4]: https://www.tastylive.com/concepts-strategies/vega

[^31_5]: https://www.tradingblock.com/blog/option-vega

[^31_6]: https://www.sahi.com/blogs/6-understanding-option-greeks

[^31_7]: https://zerodha.com/varsity/chapter/vega/

[^31_8]: https://www.binance.com/en/square/post/21605767166522

[^31_9]: https://incomeshares.com/en-eu/insights/options-vega-explained

[^31_10]: https://learn.greeks.live/path/how-does-vega-differ-from-gamma/

[^31_11]: https://www.youtube.com/watch?v=MEVVXTHxS0k

[^31_12]: https://optionalpha.com/learn/options-greeks

[^31_13]: https://www.optionseducation.org/advancedconcepts/vega

[^31_14]: https://www.youtube.com/watch?v=OoB4wnMUj-k

[^31_15]: https://www.heygotrade.com/en/blog/what-is-vega-in-options/


---

# why is there no thrird derivative of a price?

There *is* a third derivative of price—mathematically it just means the rate of change of the second derivative. But in markets we usually only talk about the first two because higher‑order derivatives quickly become noisy, hard to estimate, and impractical for trading decisions.

### What the derivatives correspond to

For an asset price $S_t$:

- **1st derivative** $\frac{dS}{dt}$ ≈ **velocity** of price (trend / instantaneous return).
In options: this is loosely related to **Delta** (change of option price with spot).
- **2nd derivative** $\frac{d^2S}{dt^2}$ ≈ **acceleration** of price (how quickly the trend is changing).
In options: this is loosely related to **Gamma** (how Delta changes with spot).
- **3rd derivative** $\frac{d^3S}{dt^3}$ ≈ **jerk** or “snap” of price, i.e., how fast acceleration is changing.
This exists mathematically, but it is:
    - extremely noisy in market data,
    - hard to estimate robustly (noisy first derivative → even noisier second and third),
    - not intuitive for traders to interpret or act on.

In practice, almost all models stop at the second derivative because:

- **Gamma (2nd‑order)** already captures convexity effects well enough for most hedging and margining.
- **3rd‑order (or higher)** mainly adds noise and overfitting, not economic signal.

So the answer is: the third derivative of price *does* mathematically exist, but markets don’t talk about it because it’s too noisy and not useful for real‑world trading or risk management.
<span style="display:none">[^32_1][^32_10][^32_11][^32_12][^32_13][^32_14][^32_15][^32_2][^32_3][^32_4][^32_5][^32_6][^32_7][^32_8][^32_9]</span>

<div align="center">⁂</div>

[^32_1]: https://www.investopedia.com/terms/o/omega.asp

[^32_2]: https://www.macroption.com/third-order-greeks/

[^32_3]: https://www.truedata.in/blog/options-greeks-omega

[^32_4]: https://en.wikipedia.org/wiki/Greeks_(finance)

[^32_5]: https://www.bis.org/publ/ecsc07e.pdf

[^32_6]: https://optionalpha.com/lessons/options-pricing-the-greeks

[^32_7]: https://corporatefinanceinstitute.com/resources/career-map/sell-side/capital-markets/vomma/

[^32_8]: https://www.reddit.com/r/options/comments/1bp8vej/the_greeks_are_not_the_villains_but_we_often_say/

[^32_9]: https://www.daytrading.com/greeks-options-pricing

[^32_10]: https://www.wealthsimple.com/en-ca/learn/advanced-option-greeks

[^32_11]: https://github.com/saimanish-p/options-pricing-and-greeks

[^32_12]: https://www.investopedia.com/terms/g/greeks.asp

[^32_13]: https://www.linkedin.com/posts/tribhuvan-bisen_third-order-options-greeks-that-nobody-will-activity-7241824003374374912-4qbZ

[^32_14]: https://www.schwab.com/learn/story/get-to-know-option-greeks

[^32_15]: https://bsic.it/guide-land-higher-order-greeks/


---

# what about the other greeks, what are they mathematically?

Great question. The other Greeks are just **partial derivatives** of the option price with respect to the underlying model parameters, beyond the basic Delta and Vega you already know. Here is a quick reference you can fold into your risk model.

***

### 1. Gamma \$ \Gamma \$

Gamma is the **second derivative of price with respect to the underlying spot price**:

$$
\Gamma = \frac{\partial^2 V}{\partial S^2}
$$

- Tells you **how Delta changes** as spot moves.
- Large Gamma means Delta is highly nonlinear in $S$; near ATM, Gamma is largest and the option behaves like a convex payoff.
- In risk: high Gamma positions suffer large P\&L swings if the market jumps or if your hedge slippage is nonzero.

***

### 2. Theta \$ \Theta \$

Theta is the **derivative of price with respect to time to maturity**:

$$
\Theta = \frac{\partial V}{\partial t} 
\quad \text{(often quoted per day)}
$$

- **Time decay**: how much the option value drops as time passes, all else equal.
- For standard calls/puts, Theta is usually negative: you lose value as time elapses.
- In margining: Theta is less used for collateral but very important for portfolio P\&L and funding cost.

***

### 3. Vega \$ Vega \$

You already know this one, but for completeness:

$$
\text{Vega} = \frac{\partial V}{\partial \sigma}
$$

where $\sigma$ is implied volatility.

- Measures **sensitivity to vol surface**.
- In options‑style margining, Vega is critical because collateral must protect against **vol spikes** as well as spot moves.
- Portfolio net Vega is often a separate constraint (“long‑vol vs short‑vol cap”) alongside Delta and Gamma.

***

### 4. Rho \$ \rho \$

Rho is the **derivative with respect to the interest rate**:

$$
\rho = \frac{\partial V}{\partial r}
$$

- For vanillas, call Rho is positive (call is worth more as rate rises), put Rho usually negative.
- In practice, onchain margining often ignores Rho (or assumes it constant) because rate moves are slow and bounded, but in long‑dated options or funding‑heavy perps it can matter.

***

### 5. Higher‑order Greeks (optional)

- **Vanna** \$ Vanna = \frac{\partial^2 V}{\partial S\,\partial \sigma} \$
    - Measures how **Delta changes with vol** (or how Vega changes with spot).
    - Important if your risk model explicitly models a **stochastic‑vol smile** and you want to control second‑order interaction risk.
- **Volga** \$ Volga = \frac{\partial^2 V}{\partial \sigma^2} \$
    - **Convexity in volatility**: how Vega changes when vol jumps.
    - Very relevant in large, long‑vol portfolios (e.g., written variance swaps or index options).

***

### How they fit into your onchain risk

For practical onchain margining, a minimal but meaningful set is:

$$
(\Delta, \Gamma, \text{Vega})_i
$$

Then for each account you can compute:

- Net Delta
- Net Gamma (or per‑strike tenor buckets)
- Net Vega

and plug them into some convex risk formula:

$$
\text{Margin} \approx f(\Delta, \Gamma, \text{Vega}, S, \sigma, \Delta S, \Delta \sigma)
$$

Often this is a **linear or quadratic bound** derived from Taylor‑expanding the option value to second order in $S$ and first (sometimes second) in $\sigma$.

If you want, in the next step I can write down explicit Taylor approximations you could use onchain as a collateral rule: e.g., how to translate a vector of $\Delta_i, \Gamma_i, \text{Vega}_i$ into a single margin number per account.
<span style="display:none">[^33_1][^33_10][^33_11][^33_12][^33_13][^33_14][^33_15][^33_2][^33_3][^33_4][^33_5][^33_6][^33_7][^33_8][^33_9]</span>

<div align="center">⁂</div>

[^33_1]: https://www.schwab.com/learn/story/get-to-know-option-greeks

[^33_2]: https://en.wikipedia.org/wiki/Greeks_(finance)

[^33_3]: https://www.optionseducation.org/advancedconcepts/understanding-options-greeks

[^33_4]: https://optiver.com/explainers/option-greeks/

[^33_5]: https://groww.in/p/what-is-option-greeks

[^33_6]: https://gregorygundersen.com/blog/2023/10/08/greeks/

[^33_7]: https://alpaca.markets/learn/option-greeks

[^33_8]: https://www.binance.com/en/academy/articles/options-trading-what-are-the-greeks

[^33_9]: https://optionalpha.com/lessons/options-pricing-the-greeks

[^33_10]: https://www.avatrade.com/education/market-terms/what-are-the-greeks-in-the-options-trading

[^33_11]: https://www.youtube.com/watch?v=SFebmSYSZA8

[^33_12]: https://www.schwab.com/learn/story/options-greeks-gamma-explained

[^33_13]: https://tastytrade.com/learn/trading-products/options/options-greeks/

[^33_14]: https://www.youtube.com/watch?v=8107gb50UOY

[^33_15]: https://analystprep.com/study-notes/cfa-level-2/interpret-each-of-the-option-greeks/


---

# what is smile?

In options trading, **“smile” (or volatility smile / skew)** is a pattern in **implied volatility** across different strike prices for the same expiry.

### Intuition

- For a simple, non‑optiony model (like Black‑Scholes), implied volatility is constant across strikes.
- In real markets, out‑of‑the‑money options (both deep puts and deep calls) often trade with **higher implied vol** than at‑the‑money options.
- When you plot implied vol vs strike, you get a **smile‑ or skew‑shaped curve** instead of a flat line.

Visual shape:

- **Smile**:
    - ATM vol low,
    - far OTM puts and calls have higher vol.
    - Looks like a “U” or smile if you rotate it.
- **Skew**:
    - ATM vol higher than very far OTM,
    - but the **left side (puts)** is much higher than the right (calls).
    - Looks like a tilted smile, common in equity indices (investors want protection against crashes).


### Why it exists

- **Fat tails / jumps**:
Real markets see big downside jumps more often than symmetric up moves, so traders demand higher IV for OTM puts.
- **Demand for protection**:
People buy OTM puts as crash insurance, pushing their prices (and implied vol) up.
- **Dispersion of beliefs**:
For very far strikes, there is more disagreement about what volatility should be, so the market compensates.


### Why it matters to you

If your onchain margin engine only uses **one flat implied volatility**, it will:

- **underestimate** risk for OTM options (because smile/skew means they are *effectively* more volatile than ATM),
- and may **overmargin** or **undermargin** depending on the leg.

So when you say “we need Greeks onchain because of collateral needed,” the **smile** is exactly why a naive “single IV” model is not enough: the **Greeks themselves** (delta, gamma, vega) change with strike and are amplified by the smile/skew structure.
<span style="display:none">[^34_1][^34_10][^34_2][^34_3][^34_4][^34_5][^34_6][^34_7][^34_8][^34_9]</span>

<div align="center">⁂</div>

[^34_1]: https://www.youtube.com/watch?v=ARSQiNi2sHw

[^34_2]: https://analystprep.com/study-notes/frm/part-2/market-risk-measurement-and-management/volatility-smiles/

[^34_3]: https://www.youtube.com/watch?v=ruFWFUkpbQk

[^34_4]: https://www.youtube.com/watch?v=d3sRfwyS1g4

[^34_5]: https://www.youtube.com/watch?v=QlS9dgrrxFE

[^34_6]: https://marketchameleon.com/Instructional-Stock-and-Options-Trading-Videos/479/Charting-the-Implied-Volatility-Smile-Across-Expirations

[^34_7]: https://www.youtube.com/watch?v=7t7jmm40yAM

[^34_8]: https://www.youtube.com/watch?v=KhX-Hh7IZWw

[^34_9]: https://www.youtube.com/watch?v=QvF9zlvLH8s

[^34_10]: https://www.youtube.com/watch?v=d1d9x8QmEvQ


---

# is there a leverage in options?

Yes — but **not in the same way as futures or spot margin**. In options, leverage is **implicit and non‑linear**, driven by moneyness, time, and volatility, rather than by an explicit margin multiplier like “3×” or “10×”.

## How options give leverage

For the option buyer, leverage comes from:

- **Limited downside, unlimited upside relative to premium paid**
If you buy a call, you risk only the premium, but your payoff can be many times that premium if the underlying moves strongly in your favor. From a percentage‑return perspective, that is high leverage, even though the clearing system did not lend you extra capital.
- **Non‑linear P\&L**
The option’s payoff is convex: small changes in spot may give almost no P\&L near the strike, but a big move can create a large gain relative to the initial premium. That convexity is effectively leverage that appears only when the market moves in your direction.

For the **option seller**, the leverage is more dangerous:

- You collect a small premium but take on potentially large loss if the underlying moves against you.
- From a capital‑to‑risk perspective, the short is levered because your loss can be much larger than the premium you received, even though no margin vault explicitly multiplied your nominal exposure.


## How this differs from “margin leverage”

In futures or spot margin trading:

- Leverage is explicit: you borrow vs your collateral (e.g., 2×, 5×, 10× notional vs collateral).
- P\&L is roughly linear: for each 1% move you gain/lose ~`leverage × 1%` of collateral.

In options:

- There is no default, standardized “x leverage” label; leverage is **implied** by moneyness, time to expiry, and implied vol.
- The same contract can look almost unlevered if it is deep in/out of the money and short‑dated, but very levered if it is out‑of‑the‑money and long‑dated.


## Why people still say “options are leveraged”

In practice, people say “options are leveraged” to mean:

- **Capital efficiency**: you can gain exposure to a large notional move for a small initial outlay (the premium).
- **Disproportionate P\&L vs capital**: a small move in the right direction can generate a large percentage return on the premium, while a small move against can wipe it out.

So **yes, there is leverage in options**, but it is **embedded in the optionality itself**, not enforced by a margin‑engine‑style multiplier.
<span style="display:none">[^35_1][^35_10][^35_2][^35_3][^35_4][^35_5][^35_6][^35_7][^35_8][^35_9]</span>

<div align="center">⁂</div>

[^35_1]: https://optionsdesk.com/resource-centre/intermediate-options/options-leverage/

[^35_2]: https://www.tastylive.com/concepts-strategies/options-leverage

[^35_3]: https://www.stockgro.club/blogs/futures-and-options/options-trading-leverage/

[^35_4]: https://www.nextlevelglobalacademy.com/blog-posts/what-is-leverage-options-trading

[^35_5]: https://public.com/learn/leverage-explained

[^35_6]: https://www.optionstrading.org/introduction/terms-phrases/leverage/

[^35_7]: https://help.tradestation.com/10_00/eng/tradestationhelp/options_trading/use_leverage_options_trading.htm

[^35_8]: https://www.sofi.com/learn/content/options-leverage/

[^35_9]: https://www.youtube.com/watch?v=cO2p07RELm0

[^35_10]: https://fastercapital.com/content/Options-trading--How-to-trade-options-and-use-leverage.html


---

# how can you increase leverage in options?

You cannot increase leverage in options in the same direct way as in futures (e.g., by simply lowering margin), because options are **non‑linear, convex instruments** and their risk structure is fundamentally different. That said, you can *effectively* get higher leverage in a few ways, and each one shifts risk differently.

***

### 1. Use deep‑OTM options (cheapest delta, highest leverage)

- Buy **deep‑out‑of‑the‑money** (far OTM) calls or puts.
- Their price is tiny compared to underlying notional, so a small move in spot can 10x+ the option price.
- Example: buying a 30% OTM call on spot worth 100 costs maybe 0.5; if spot jumps to 140, the option can easily be worth 5–10 → 10–20× return on option premium, even though the spot move was only 40%.

**Trade‑off**:

- Very low probability of payoff; most OTM options expire worthless.
- This is **convex long‑gamma speculation**, not “safe” leverage.

***

### 2. Use longer‑dated options (more time, more convexity)

- For the same strike and moneyness, a **longer‑dated option** has higher vega and more time for the underlying to move into the money.
- That means for the same premium you can effectively “buy more optionality” and more convexity vs. only directional exposure.

**Trade‑off**:

- Time decay is slower but still present; you still pay theta.
- Just prolonging maturity does not remove the risk of being wrong on direction.

***

### 3. Sell options to finance long options (riskier strategies)

If you want apparent “higher leverage” while staying in options, people often combine:

- **Sell OTM options** to receive premium and fund long‑gamma positions.
- Examples: butterflies, condors, or simple **risk reversals** (sell OTM put, buy OTM call, or vice versa), where net premium is small or zero.
- That gives you:
    - Very large PV impact from a big move,
    - but also **tail risk** on the side you sold.

This is not pure leverage; it is **skewed risk transfer**. You can lose catastrophically if the market moves against your short leg.

***

### 4. Use options with high vega (volatility‑based leverage)

- Options on **high‑vol products** (or at times of low implied vol) can give you **volatility leverage**:
    - You pay relatively low premium for a lot of vol exposure.
    - If realized vol shocks up, your long‑vega position blows up in your favor.

You can amplify this by:

- Buying **back‑end or long‑dated options** (high vega),
- Or selling short‑dated options to fund them.

**Trade‑off**:

- If vol collapses (vol crush), you can lose quickly even if the underlying hasn’t moved much.

***

### 5. Portfolio‑level options vs. delta‑hedge “futures‑like” position

Some traders “manufacture” leverage by:

- Buying options (calls or puts).
- **Delta‑hedging** them with underlying or futures.
- Result: you effectively turn the option into a **volatility‑only bet**, and the delta‑hedge removes much of the directional risk.

You can amplify this by:

- Running a **vol‑only book** where your delta is hedged, and your only exposure is gamma/vega.
- But the leverage comes from **vol convo**, not from magnified spot exposure.

This is closer to “options‑based leverage in volatility space,” not in price space.

***

### 6. Why you cannot “just increase leverage” like in futures

In futures, leverage is explicitly controlled by:

- initial margin / notional,
- maintenance margin,
- and the exchange or protocol can change those parameters.

Options are different because:

- Their **P\&L is non‑linear**:
    - 10% move can destroy or 10× an option, depending on moneyness and tenor.
- Issuer (or pool) always bears **tail risk**, so:
    - If you naively “increase leverage” (e.g., accept undercollateralized positions), you either:
        - take counterparty risk, or
        - blow up the pool.

So protocols cannot safely allow mechanically higher leverage on options the way they can with futures.

***

### 7. How exchanges/protocols enforce option leverage

In practice, option‑style products with leverage look like:

- **Portfolio‑margin systems**:
    - Net positions across strikes/tenors are evaluated together (margining via Greeks or stress scenarios).
- **Exercise‑only or physical‑settlement** for certain products, so:
    - You only get the “leverage boost” at expiry or exercise, not as a fully margined perpetual‑like option.
- **Short‑duration structures** that are more like **leveraged calls/puts** (e.g., weekly options):
    - High gamma, but only short‑lived so the system can liquidate quickly.

***

### Summary in one line

You increase **effective leverage** in options by:

- buying **deep‑OTM options** or **high‑vega options**,
- or combining options into **asymmetric strategies** that pay off only on large moves,

but you cannot safely “increase leverage” in the futures‑style sense because the **non‑linearity and tail risk of options** means more leverage always means more chance of blow‑up, not just more directional exposure.
<span style="display:none">[^36_1][^36_2][^36_3][^36_4][^36_5][^36_6][^36_7][^36_8][^36_9]</span>

<div align="center">⁂</div>

[^36_1]: https://www.sofi.com/learn/content/options-leverage/

[^36_2]: https://www.reddit.com/r/options/comments/ynkyp4/gaining_leverage_to_sell_options/

[^36_3]: https://www.tastylive.com/concepts-strategies/options-leverage

[^36_4]: https://www.merrilledge.com/investment-products/options/options-trading-leverage-risk

[^36_5]: https://www.youtube.com/watch?v=NACULP4KTM8

[^36_6]: https://www.youtube.com/watch?v=6vJTA8lQ4aw

[^36_7]: https://nubra.io/blogs/general-options/leverage-in-options-trading

[^36_8]: https://help.tradestation.com/10_00/eng/tradestationhelp/options_trading/use_leverage_options_trading.htm

[^36_9]: https://public.com/learn/leverage-explained


---

# what is out-of-money options?

An **out-of-the-money (OTM) option** is an option whose current strike price is unfavorable relative to the underlying’s price, so it would not be profitable to exercise it now if it were American‑style, or would expire worthless if held until expiry.

## Call option, OTM

- For a **call**, the strike must be **higher** than the current spot price.
- Example:
    - Underlying spot = 100.
    - Call with strike 110 → **OTM** (you wouldn’t pay 110 for something trading at 100 now).
- Intrinsic value = 0; the option’s value is purely **time value**.


## Put option, OTM

- For a **put**, the strike must be **lower** than the current spot price.
- Example:
    - Underlying spot = 100.
    - Put with strike 90 → **OTM** (you wouldn’t sell at 90 if the market is at 100).
- Again, intrinsic value = 0; only time value.


## In‑the‑money vs at‑the‑money

- **In‑the‑money (ITM)**: strike is better than spot (call with strike < spot, put with strike > spot).
- **At‑the‑money (ATM)**: strike is very close to spot.

OTM options are cheaper than ITM ones because they chance of ending up in‑the‑money, but they also decay faster and can go to zero if the underlying doesn’t move far enough before expiry.
<span style="display:none">[^37_1][^37_10][^37_2][^37_3][^37_4][^37_5][^37_6][^37_7][^37_8][^37_9]</span>

<div align="center">⁂</div>

[^37_1]: https://www.ig.com/en/glossary-trading-terms/out-of-the-money-definition

[^37_2]: https://www.home.saxo/en-sg/content/glossary/out-of-the-money

[^37_3]: https://www.sofi.com/learn/content/in-the-money-vs-out-of-the-money/

[^37_4]: https://www.britannica.com/money/out-of-the-money

[^37_5]: https://www.home.saxo/en-mena/content/glossary/out-of-the-money

[^37_6]: https://www.icicidirect.com/ilearn/futures-and-options/articles/what-is-out-of-the-money-or-otm-in-options

[^37_7]: https://www.ig.com/sg/glossary-trading-terms/out-of-the-money-definition

[^37_8]: https://www.tastylive.com/concepts-strategies/out-of-the-money

[^37_9]: https://www.youtube.com/watch?v=3xParMS-608

[^37_10]: https://www.tfex.co.th/th/education/knowledge/article/158-options-tfex-in-the-money-out-of-the-money-trading


---

# so i i bought option, can I sell it before expiration?

Yes — in most normal options markets (derivatives exchanges, crypto options, etc.) you **can** sell a bought option before expiration; you are not forced to hold it until expiry.

## How it works in practice

- When you **buy** an option (call or put), you pay a **premium** for the right to exercise it.
- Until expiration you can:
    - **Exercise it early** (for American‑style options), or
    - **Close the position by selling it back** to the market to another trader or market maker.

That sale is just an inverse transaction: “sell to close” your long option. Your P\&L from that trade is roughly:

$$
\text{P\&L} = \text{price you sold for} - \text{price you paid to buy it}
$$

If the option has become more valuable (e.g., the underlying moved favorably, volatility rose, or time decay is minor), you can sell it for a profit; if it has become less valuable, you may sell at a loss or even zero.

## What depends on style and venue

- **American‑style options**: can be exercised or sold at any time before expiry.
- **European‑style options**: usually cannot be exercised early, but you can still **sell the contract** before expiry; only the *right to exercise* is restricted, not your ability to trade the position.

On-chain or DEX-style options protocols generally follow the same logic: if the protocol supports an **order book or AMM** for that option, you can exit by selling; if it does not, you may be locked until expiry or until the protocol allows some form of peer‑to‑peer unwind or DAO‑driven mechanism.

So in short:
**Yes, you can typically sell an option you bought before it expires**, as long as there is a market or mechanism for that option’s contract.
<span style="display:none">[^38_1][^38_10][^38_2][^38_3][^38_4][^38_5][^38_6][^38_7][^38_8][^38_9]</span>

<div align="center">⁂</div>

[^38_1]: https://www.daytrading.com/when-to-sell-options-before-expiration

[^38_2]: https://www.reddit.com/r/options/comments/8uchmq/is_it_better_to_sell_your_options_before/

[^38_3]: https://www.reddit.com/r/options/comments/shk7p8/selling_call_options_before_expiry/

[^38_4]: https://optionsamurai.com/blog/selling-options-on-expiration-day/

[^38_5]: https://optionsamurai.com/blog/selling-options-on-expiration-day/\&rut=f30eb675fcd140ec3b8c687f8c810d79a08d77a3e6cc171a97d8ccefb48ff19b/

[^38_6]: https://music.amazon.com/podcasts/b9798a19-b0cf-4873-8f8b-85960646990a/episodes/e6142d66-6785-4a90-b68a-d5b786d95042/options-trading-podcast-can-i-sell-an-option-contract-before-expiration-or-do-i-have-to-hold-it-until-then

[^38_7]: https://www.piranhaprofits.com/blog/sell-calls-before-expiration

[^38_8]: https://www.youtube.com/watch?v=UH4db24138I

[^38_9]: https://www.schwab.com/learn/story/options-expiration-definitions-checklist-more

[^38_10]: https://corporatefinanceinstitute.com/resources/derivatives/call-option/


---

# so you can either sell it or exercise?

Yes — in standard options mechanics you usually have **two main ways to realize profit or loss** on a position:

1. **Sell it (close the position)**
    - You sell the option (or your option leg) on the market, locking in your P\&L at the current mark price.
    - This is typically cheaper and more flexible because you don’t trigger the full settlement mechanics; you just unwind your position before expiry.
    - In a CLOB or AMM setting, “selling it” means another trader buys your long from you, or you hedge by selling an offsetting short.
2. **Exercise it (if in‑the‑money)**
    - At or before expiry, the holder can **exercise** the right:
        - Call: buy the underlying at the strike.
        - Put: sell the underlying at the strike.
    - Exercise usually only makes sense when the option is in‑the‑money and the time value is small or zero.
    - In an onchain options protocol, exercise normally triggers a **collateral claim and settlement** against the writer’s margin pool.

## How this usually looks in a protocol

- If you **sold** the option (wrote it), your P\&L is:
    - you keep the premium if the option expires out‑of‑the‑money, or
    - you pay the intrinsic‑value loss if the holder exercises and you’re undercollateralized you get liquidated.
- If you **bought** the option, your P\&L is:
    - you can either **sell it back** earlier and realize gains/losses, or
    - **exercise or cash‑settle** at expiry if it’s ITM.

In liquidation‑driven contracts, you typically don’t wait for “pure” exercise; the system will close out positions when collateral falls below margin, even before expiry, using onchain Greeks or a risk model to decide how much to liquidate.

So in short: **you can choose to realize value by selling your option or by exercising it**, depending on the contract rules, your cashflow needs, and whether exercise is permitted or forced by liquidation logic.
<span style="display:none">[^39_1][^39_2][^39_3][^39_4][^39_5][^39_6][^39_7][^39_8][^39_9]</span>

<div align="center">⁂</div>

[^39_1]: https://www.reddit.com/r/options/comments/qi371c/can_you_exercise_options_before_the_expiration/

[^39_2]: https://www.investopedia.com/terms/e/earlyexercise.asp

[^39_3]: https://www.merrilledge.com/investment-products/options/how-when-exercise-options

[^39_4]: https://www.schwab.com/learn/story/options-expiration-definitions-checklist-more

[^39_5]: https://www.optionseducation.org/referencelibrary/faq/options-exercise

[^39_6]: https://robinhood.com/support/articles/expiration-exercise-and-assignment/

[^39_7]: https://help.public.com/en/articles/8460531-understanding-option-expiration-exercise-and-assignment

[^39_8]: https://us.etrade.com/knowledge/library/options/understanding-expiration

[^39_9]: https://en.wikipedia.org/wiki/Exercise_(options)


---

# So if options are cash settled at expiration, then how are spot options different from futures options or perps options

Great question — and the answer is that once you strip away the delivery mechanism and go to cash settlement, the differences narrow down to **what the underlying reference price is** at expiry, and what risks you carry during the life of the contract.

## What they all have in common at expiry

All three settle to: `max(0, S_T - K)` for a call or `max(0, K - S_T)` for a put, where `S_T` is the **settlement price** at expiry. If they all reference the same index price at expiry, the final payoff is identical. The differences live in what feeds `S_T`, what you hold in between, and what collateral you need during the life of the position.

## Spot options

The underlying is the **spot price of the asset** (e.g., BTC/USD). Settlement at expiry computes payout from a spot index price — typically a TWAP over major CEX spot feeds. Between trade and expiry you carry **no funding or basis**. Your P\&L is pure option P\&L: delta, gamma, vega relative to spot, with no rolling cost. This is the cleanest model, closest to textbook Black-Scholes.

## Futures options

The underlying is a **futures contract**, not spot directly. Two key consequences:

1. **Settlement is against the futures price at expiry**, not spot. In theory at expiry futures converge to spot, but the path matters for margining and Greeks during the life of the option.
2. **You carry basis risk** — the futures price includes cost-of-carry, funding rates, and sometimes supply/demand distortions in the futures market itself. Your delta is against the futures price, so you hedge by trading futures, not spot.

In crypto specifically, perpetual funding makes the "futures curve" complex and can cause futures to trade well above or below spot for extended periods. An option on a futures has **delta against futures price**, which can diverge from spot delta meaningfully during the contract's life.

## Perps options

The most exotic of the three. The underlying is a **perpetual contract** (a funding-rate-settled instrument with no expiry itself). Key differences:

1. **No natural convergence to spot at a fixed date** — the "price" of the perp is anchored to spot via the funding mechanism but can drift intraday.
2. **Delta hedging requires holding a perp** with ongoing funding cash flows, not just buying/selling spot or a dated future. So your hedge bleeds (or earns) funding continuously.
3. **Funding risk bleeds into vega pricing** — high funding periods make the perp-spot basis volatile, which adds a funding-vol dimension that spot options don't have.
4. **No clean term structure** — dated futures options have a crisp forward curve. Perps have only one contract, so you cannot decompose a portfolio cleanly by tenor.

## Side-by-side summary

| Dimension | Spot option | Futures option | Perps option |
| :-- | :-- | :-- | :-- |
| Settlement reference | Spot index | Futures price at expiry | Perp mark price at expiry |
| Basis risk during life | None | Futures/spot spread | Perp/spot spread via funding |
| Delta hedge instrument | Spot | Dated futures | Perpetual contract |
| Funding cost during hedge | None | Roll cost at expiry | Continuous funding P\&L |
| Term structure | Per expiry, clean | Per expiry, clean | Single contract |
| Collateral model | Spot vol only | Forward vol + basis | Spot vol + funding vol |

## Why it matters for your design

For collateral and Greeks onchain, the differences are important:

- **Spot options**: Black-Scholes or a smile model against a spot oracle is sufficient. Greeks are clean.
- **Futures options**: You need a forward curve onchain (futures prices per tenor) and delta is against the forward, not spot. The margin model must mark to futures.
- **Perps options**: The trickiest — you need both a spot oracle and a perp mark price, plus a model for expected funding over the option's life. Delta hedging a perps option bleeds funding continuously, so your vega and theta models need to account for funding volatility as a separate risk dimension.

In practice, most onchain options protocols today use spot oracles for simplicity, even when the economic exposure looks more like a perps option. That mismatch is a real risk — the margin model assumes one reference price, but the effective replication cost is different.
<span style="display:none">[^40_1][^40_10][^40_11][^40_12][^40_13][^40_14][^40_15][^40_2][^40_3][^40_4][^40_5][^40_6][^40_7][^40_8][^40_9]</span>

<div align="center">⁂</div>

[^40_1]: https://learn.greeks.live/area/spot-versus-futures-options/

[^40_2]: https://www.facebook.com/NordFX/posts/-spot-vs-futures-trading-what-every-trader-should-knowspot-trading-means-you-buy/1277612781071375/

[^40_3]: https://zerodha.com/varsity/chapter/physical-settlement-of-futures-and-options/

[^40_4]: https://www.youtube.com/watch?v=yhZxQROq8oA

[^40_5]: https://www.tiktok.com/@nicholas_crown/video/7620901120470224142

[^40_6]: https://blog.ueex.com/spot-and-perpetual-futures-trading/

[^40_7]: https://www.youtube.com/watch?v=QTxiqFfJllU

[^40_8]: https://www.troniextechnologies.com/blog/spot-trading-vs-perpetual-futures-trading

[^40_9]: https://www.youtube.com/watch?v=Llp4xW2GI4s

[^40_10]: https://www.chainup.com/blog/spot-perpetual-future-crypto-exchange/

[^40_11]: https://www.youtube.com/watch?v=0C3UKT_2-T8

[^40_12]: https://www.coinflare.com/blog/spot-trading-vs-perpetual-swaps-understanding-the-basics/

[^40_13]: https://www.youtube.com/watch?v=5D7tmc9Trnw

[^40_14]: https://metamask.io/news/perpetual-futures-vs-spot-bitcoin

[^40_15]: https://www.youtube.com/watch?v=KbqpswKlgV4


---

# here are options on solana

https://github.com/mithraiclabs/psyoptions/blob/master/programs/psy_american/src/lib.rs

what can u say about implementation?

That repo implements an **American‑style options protocol on Solana**, built around a vault‑based design where each option contract is backed by collateralized vaults.

### High‑level architecture

The core idea is:

- A **vault** holds the underlying asset (e.g., SOL) or quote asset (e.g., USDC) for a given option series (strike, expiry, direction).
- Users **deposit** into the vault to mint **option tokens** (mint with a specific decimal/precision) and **write** calls/puts into those vaults.
- Users **exercise** against the vault; the contract transfers the underlying from the vault to the exercisee in return for the strike payment.
- Expiry is handled explicitly: after the expiry slot, the protocol can “settle” or let the vaults be drained according to the rules.

This is very similar to other Solana options designs: **per‑strike‑and‑expiry vaults + onchain mints that represent 1 option, plus onchain accounting of who wrote versus who holds**.

### Key components in the implementation

From the `psy_american` program and instruction set, you can see:

- **Instruction family**
    - `create_vault` / `init_vault`‑like instructions to set up a new option series.
    - `deposit` / `write` instructions to add collateral to the vault so it can issue more options.
    - `exercise` instructions so holders can trigger early exercise (since it’s American‑style).
    - `settle` / `close` instructions to handle expiry: either returning excess collateral or pulling out remaining underlying.
- **State accounts**
    - Vault account with:
        - underlying mint and quote mint,
        - strike price,
        - expiry slot/Unix timestamp,
        - collateral balance,
        - number of written contracts (or outstanding mints),
        - pointers to token accounts and oracles / oracles‑lite data.
    - Option token mints representing the call/put, with associated metadata about strike and expiry.
- **Risk model on Solana constraints**
    - There is no heavy onchain option‑pricer; the risk is implicitly **fully collateralized** by the vault design (full‑coverage of payoff).
    - Because of this, you don’t see a full onchain Black‑Scholes or stochastic‑vol model; the risk is held in the **value and size of the underlying locked in the vault**, not a dynamic Greek‑based formula.
    - Oracle use is minimal: mainly to double‑check expiry time and maybe sanity‑check spot vs strike at settlement, not to continuously reprice the option onchain.


### What this means for market makers and UX

- **For makers**:
    - Writing is relatively simple: you deposit underlying into a vault and receive withdrawable option tokens or credit against your position.
    - The contract does not force you to maintain a Greek‑based margin; the **vault’s collateralization** is the main safety behind the payoff.
    - This is great for **slow‑to‑medium activity** and not for ultra‑high‑frequency Greek‑aware hedging onchain.
- **For takers / LPs**:
    - The vault guarantees that payoff is backed by onchain assets.
    - Liquidity is potentially fragmented across strikes and expiries, because each series is its own vault.
    - AMM or RFQ‑style liquidity usually sits **on top of** or **alongside** this vault layer (in separate programs or UIs), rather than inside the core `psy_american` program.


### How it differs from full onchain “Greeks” designs

Relative to what we were talking about earlier, this design is:

- **Not** a perp‑style options engine with onchain PV/Greeks per account.
- **Not** a system where you run Black‑Scholes on every fill to rebalance margin.
- **Instead**:
    - A **structural collateralization model** (each vault is overcollateralized),
    - With settlement and exercise logic onchain,
    - And the actual **option‑pricing / Greek‑aware quoting** happening offchain in the front‑end and MM bots.

So if your goal is “Greeks onchain for collateral”, `psy_american` is **not** that; it’s closer to “**onchain vault‑backed American options with simple onchain settlement logic**.” The complexity is in the Solana account layout and instruction flow, not in a continuous onchain risk‑engine.

If you want, I can next sketch how you might *add* a compact onchain risk layer on top of a vault‑style base (for example, storing net delta/gamma per account keyed by vault series).
<span style="display:none">[^41_1][^41_10][^41_11][^41_12][^41_13][^41_14][^41_15][^41_16][^41_17][^41_18][^41_19][^41_2][^41_20][^41_21][^41_22][^41_23][^41_24][^41_25][^41_26][^41_27][^41_28][^41_29][^41_3][^41_30][^41_31][^41_32][^41_33][^41_34][^41_35][^41_36][^41_37][^41_38][^41_39][^41_4][^41_40][^41_41][^41_42][^41_5][^41_6][^41_7][^41_8][^41_9]</span>

<div align="center">⁂</div>

[^41_1]: https://crates.io/crates/psyoptions

[^41_2]: https://github.com/mithraiclabs/psyoptions

[^41_3]: https://stackoverflow.com/questions/57756927/rust-modules-confusion-when-there-is-main-rs-and-lib-rs

[^41_4]: https://lib.rs/crates/rust-options

[^41_5]: https://internals.rust-lang.org/t/deprecating-having-both-src-lib-rs-and-src-main-rs-in-the-same-package/23033

[^41_6]: https://coin98.net/what-is-psyoptions-psy

[^41_7]: https://ucilnica.fri.uni-lj.si/pluginfile.php/137236/mod_resource/content/1/Design%20Patterns%20for%20Smart%20Contracts%20in%20the%20Ethereum%20Ecosystem.pdf

[^41_8]: https://www.youtube.com/watch?v=Tld4-I_gLKk

[^41_9]: https://www.mediasnet.net/what-is-psyoptions-and-its-psy-token/

[^41_10]: https://github.com/vjgaur/ink-smart-contracts-substrate/blob/main/runtime/src/lib.rs

[^41_11]: https://www.reddit.com/r/learnrust/comments/10wgz9t/what_goes_into_librs/

[^41_12]: https://solanacompass.com/projects/psyfi

[^41_13]: https://github.com/parallelchain-io/example-smart-contracts/blob/main/chapter_1/src/lib.rs

[^41_14]: https://docs.rs/cc/latest/src/cc/lib.rs.html

[^41_15]: https://ascendex.com/it/support/articles/64007-psyoptions-psy

[^41_16]: https://www.investing.com/news/cryptocurrency-news/solanabased-psyoptions-makes-headway-to-decentralized-options-2754316

[^41_17]: https://x.com/PsyOptions/status/1436041089518030849

[^41_18]: https://www.veradiverdict.com/p/options-on-solana

[^41_19]: https://www.reddit.com/r/solana/comments/sf3oxc/is_psyoptions_a_rug_pull/

[^41_20]: https://www.publish0x.com/the-oasians/psyoptions-analysis-the-battle-of-options-on-solana-xgjdpkn

[^41_21]: https://www.youtube.com/watch?v=keJ7F6tx7hI

[^41_22]: https://lib.rs/crates/solana-program-option

[^41_23]: https://explorer.solana.com/address/PsyFiqqjiv41G7o5SMRzDJCu4psptThNR2GtfeGHfSq

[^41_24]: https://brson.github.io/2021/06/08/rust-on-solana/

[^41_25]: https://icoanalytics.org/projects/psyoptions/

[^41_26]: https://moralis.com/web3-wiki/psyoptions/

[^41_27]: https://lib.rs/crates/solana-instruction

[^41_28]: https://www.youtube.com/watch?v=tTSlBj3ypx4

[^41_29]: https://www.youtube.com/watch?v=fp1m1WytdO0

[^41_30]: https://pkg.go.dev/github.com/teal-finance/rainbow/poc/deprecated/provider/psyoptions/anchor

[^41_31]: https://www.cypherhunter.com/en/p/psyoptions/

[^41_32]: https://www.chaincatcher.com/en/article/2072523

[^41_33]: https://github.com/mithraiclabs

[^41_34]: https://dexscreener.com/solana/dp1jazmr58vawkdat77tlbrcet2ns8sr7q71bup977km

[^41_35]: https://github.com/mithraiclabs/psyoptions/releases

[^41_36]: https://dexscreener.com/solana/gzk2ylibssuahapy9ejrbfvamvdsslbxqcz2rmchdcb8

[^41_37]: https://github.com/dbanda/solana-nft-options

[^41_38]: https://smartliquidity.info/2022/03/17/psyfinance-and-socean-partnership/

[^41_39]: https://www.linkedin.com/pulse/psyoptions-decentralized-options-paul-veradittakit

[^41_40]: https://solanacompass.com/learn/Solfate/stronger-defi-and-better-tokenomics-with-tommy-j-founder-of-psyoptions-solfate-podcast-34

[^41_41]: https://docs.rs/psyoptions/latest/src/psyoptions/fees.rs.html

[^41_42]: https://docs.rs/crate/psyoptions/0.0.5/source/


---

# what are RFQs?

RFQ stands for **Request for Quote**.

In trading and finance, an **RFQ** is a mechanism where one party (usually a buyer or seller) asks a set of counterparties for a price on a specific asset or trade, and then chooses the best quote instead of posting an order directly to a continuous order book.

## Key idea

- **User asks**: “Hey, I want to buy/sell X amount of Y at Z terms — what price will you give me?”
- **Market makers respond**: “I’ll do it at P1”, “I’ll do it at P2”.
- **User picks**: The best one and executes against that maker.

So instead of “I post a limit at P and wait for someone to hit me,” you get “I ask for quotes around my target and immediately see who’s best right now.”

## How RFQs usually work

A typical flow looks like:

1. Trader sends an RFQ with:
    - asset, side, notional/size,
    - settlement time (e.g., now vs spot vs forward),
    - constraints (min size, max latency, etc.).
2. Eligible market makers:
    - price the request using their own models,
    - return a **firm bid/offer** (sometimes for a narrow time window).
3. The RFQ handler:
    - collates responses,
    - may pick the best one or rank them,
    - allows the trader to execute against the winning quote.

In many models, offers are **firm but short‑lived** (10–500 ms), so the user must decide quickly or the quote expires.

## Where RFQs are common

- **OTC markets** (FX, rates, credit, some equities):
You see the same thing in traditional sales desks — “give me a 5‑year IRS quote for 100M” and the desk comes back with prices.
- **Crypto derivatives and AMMs / intent‑based venues**:
Some protocols collect intent from takers and then solicit RFQs from a pool of liquidity providers, then execute if the best quote is attractive enough.[^42_11][^42_12]
- **CEXes with dark pools**:
Large orders are often handled via RFQs to avoid moving the public book.


## RFQ vs CLOB

| Aspect | CLOB | RFQ |
| :-- | :-- | :-- |
| **Who sets the price?** | Anyone can post a resting order | Makers respond to a specific request |
| **Visibility** | Public, continuous book | Quotes usually only visible to requester (or matching engine) |
| **Speed** | Can be very fast but competitive | Often firm, tight, but latency‑sensitive |
| **Used for** | Normal retail / scalable flow | Large, sensitive or non‑standard trades |

Conceptually, an RFQ is like “I send an intent to trade, and you send me a prize‑bound quote you stand behind,” while a CLOB is “I dump an order into a visible book and wait for the market to react.”

## In your design

If you think about your matching‑engine setup, an RFQ‑style layer would sit nicely on top:

- Taker sends an intent: “I want to buy 10 ETH equivalents at market, with max slippage X%.”
- The engine:
    - transforms that into per‑level quantities,
    - sends internal RFQs (or CLOB‑style depth checks),
    - reorders best matches and then settles.

So “RFQs” are essentially an **intent‑based, quote‑gathering mechanism** for large or sensitive trades that avoids the limitations of pure CLOB or pure AMM UX.
<span style="display:none">[^42_1][^42_10][^42_2][^42_3][^42_4][^42_5][^42_6][^42_7][^42_8][^42_9]</span>

<div align="center">⁂</div>

[^42_1]: https://tipalti.com/resources/learn/rfq-meaning/

[^42_2]: https://www.responsive.io/blog/what-is-an-rfq

[^42_3]: https://www.deep.stream/guides/rfq-meaning-in-procurement

[^42_4]: https://www.gep.com/blog/strategy/rfi-rfq-rfp-differences-procurement

[^42_5]: https://www.docket.io/glossary/request-for-quotation-rfq

[^42_6]: https://www.cloudeagle.ai/blogs/what-are-rfi-rfp-and-rfq

[^42_7]: https://www.fairmarkit.com/glossary/request-for-quote-rfq

[^42_8]: https://en.wikipedia.org/wiki/Request_for_quotation

[^42_9]: https://www.sifthub.io/blog/rfq-procurement-steps

[^42_10]: https://www.procore.com/library/what-is-an-rfq

[^42_11]: https://www.youtube.com/watch?v=NAlXsnbcxIY

[^42_12]: https://thebitcoinmanual.com/articles/on-chain-perpetual-futures/


---
