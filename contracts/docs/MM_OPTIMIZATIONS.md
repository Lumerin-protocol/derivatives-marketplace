Here is a compact summary of the approach to reduce market‑maker churn:
Core idea
You do not represent the market maker as many static limit orders. Instead, you represent them as a single quote policy template (offsets, size rules, risk limits, skew) that is re‑projected onto the current market price at each block.
When the price shifts, the engine recomputes where that template lands on the order book rather than waiting for the maker to cancel and repost orders. This preserves their queue priority across moves, but only as long as the template is not materially changed.
How it reduces churn
• Makers update their policy template once, instead of spamming many individual order updates.
• The system remaps quotes automatically when the reference price changes within a block‑boundary epoch.
• Makers can maintain competitive pricing around a moving market without constant explicit cancels and replaces.
• The design is cheaper and more stable: fewer events, fewer state updates, less noise.
Sub‑block ordering and fairness
To have fair intra‑block priority, you add a monotonically increasing sequence counter on the engine contract:
• Every  submitTemplate  or materially updated template call increments this counter  seq .
• The priority key is then: (derived price level ascending, seq ascending) .
This gives you:
• block‑level granularity from the chain,
• sub‑block ordering from the EVM‑execution sequence,
• and deterministic, auditable queue positions without any trusted time source.
Template‑level vs. order‑level
Conceptually, the object that “owns” priority is the template, not the synthetic limit orders. At each block:
• The template is mapped to derived levels,
• Within each derived level, fills follow the original template submission time (via  seq ),
• Material changes to the quote economics reset  seq  (i.e., reset the priority clock).
This avoids queue‑jumping via “soft” edits while still rewarding makers who commit early to a competitive quoting function.
One‑sentence summary
You reduce MM churn by letting market makers express relative quoting logic once, then having the engine automatically re‑map and rebalance their quotes at each block, while using a contract‑level sequence counter to provide deterministic, fair, sub‑block price‑time priority on the resulting derived book.
