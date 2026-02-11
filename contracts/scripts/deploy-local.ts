import { run } from "hardhat";
import { parseUnits, formatUnits } from "viem";
import { deployPerpsFixture } from "../tests/fixtures";

async function main() {
  console.log("Starting local deployment...\n");
  await run("compile");
  const runPromise = run("node");

  // Deploy base contracts (USDC, oracle, Perps)
  const data = await deployPerpsFixture();
  const { contracts, accounts, config } = data;
  const { perps, usdcMock, priceOracle } = contracts;
  const { owner, seller, buyer, buyer2 } = accounts;

  // Add collateral for each participant
  const collateralPerUser = parseUnits("1000", config.tokenDecimals);
  await perps.write.addCollateral([collateralPerUser], { account: seller.account });
  await perps.write.addCollateral([collateralPerUser], { account: buyer.account });
  await perps.write.addCollateral([collateralPerUser], { account: buyer2.account });

  // Get market price and add limit orders (order book)
  const marketPrice = await perps.read.getMarketPrice();
  const tick = config.minimumPriceIncrement;
  const qty = parseUnits("1", config.quantityDecimals);

  // Sell orders (asks) - above market
  await perps.write.createOrder([marketPrice + tick, -3n * qty], { account: seller.account });
  await perps.write.createOrder([marketPrice + 2n * tick, -2n * qty], { account: seller.account });
  await perps.write.createOrder([marketPrice + 3n * tick, -qty], { account: seller.account });

  // Buy orders (bids) - below market
  await perps.write.createOrder([marketPrice - tick, 3n * qty], { account: buyer.account });
  await perps.write.createOrder([marketPrice - 2n * tick, 2n * qty], { account: buyer.account });
  await perps.write.createOrder([marketPrice - 3n * tick, qty], { account: buyer.account });

  // Matching orders at market to create positions
  await perps.write.createOrder([marketPrice, -4n * qty], { account: seller.account });
  await perps.write.createOrder([marketPrice, 4n * qty], { account: buyer.account });

  // --- Fetch all data ---
  const accountLabels: [string, typeof seller][] = [
    ["Seller", seller],
    ["Buyer", buyer],
    ["Buyer2", buyer2],
  ];
  const maxLevels = 10n;

  const [[bids, asks], positions, balances, ownerBal, reserve, fees, userOrderIds] =
    await Promise.all([
      perps.read.getOrderBookPrices([maxLevels]),
      Promise.all(
        accountLabels.map(([, account]) => perps.read.getUserPosition([account.account.address])),
      ),
      Promise.all(
        accountLabels.map(([, account]) => usdcMock.read.balanceOf([account.account.address])),
      ),
      usdcMock.read.balanceOf([owner.account.address]),
      perps.read.reservePoolBalance(),
      perps.read.collectedFeesBalance(),
      Promise.all(
        accountLabels.map(([, account]) => perps.read.getUserOrders([account.account.address])),
      ),
    ]);

  const userOrders = await Promise.all(
    userOrderIds.map((orderIds) =>
      Promise.all(orderIds.map((orderId) => perps.read.getOrder([orderId]))),
    ),
  );

  // --- Print all information ---
  console.log("Deployment completed successfully!\n");
  console.log("=== ACCOUNTS ===");
  console.log("Owner:    ", owner.account.address);
  console.log("Seller:   ", seller.account.address);
  console.log("Buyer:    ", buyer.account.address);
  console.log("Buyer2:   ", buyer2.account.address);
  console.log();

  console.log("=== CONTRACT ADDRESSES ===");
  console.log("USDC Mock:     ", usdcMock.address);
  console.log("Price Oracle:  ", priceOracle.address);
  console.log("Perps:         ", perps.address);
  console.log();

  console.log("=== CONFIG ===");
  console.log("Margin %:              ", config.marginPercent.toString(), "%");
  console.log("Maintenance margin %:  ", config.maintenanceMarginPercent.toString(), "%");
  console.log(
    "Liquidation fee:       ",
    formatUnits(config.liquidationFee, config.tokenDecimals),
    "USDC",
  );
  console.log(
    "Min price increment:   ",
    formatUnits(config.minimumPriceIncrement, config.tokenDecimals),
    "USDC",
  );
  console.log(
    "Taker fee:             ",
    config.takerFeeBps.toString(),
    "bps",
  );
  console.log(
    "Maker fee:             ",
    config.makerFeeBps.toString(),
    "bps",
  );
  console.log(
    "Min match fee floor:   ",
    formatUnits(config.liquidationFee, config.tokenDecimals),
    "USDC (= liquidation fee)",
  );
  console.log(
    "Reserve pool deposit:  ",
    formatUnits(config.collateralAmount, config.tokenDecimals),
    "USDC",
  );
  console.log(
    "Oracle hashprice:      ",
    formatUnits(config.oracle.price, config.oracle.decimals),
    "USDC",
  );
  console.log();

  console.log("=== MARKET ===");
  console.log("Market price:  ", formatUnits(marketPrice, config.tokenDecimals), "USDC");
  console.log("Best ask:      ", formatUnits(marketPrice + tick, config.tokenDecimals), "USDC");
  console.log("Best bid:      ", formatUnits(marketPrice - tick, config.tokenDecimals), "USDC");
  console.log();

  console.log("=== ORDER BOOK (prices) ===");
  console.log("Bids (price, level):");
  for (const [i, p] of bids.entries()) {
    console.log(`  ${i + 1}. ${formatUnits(p, config.tokenDecimals)} USDC`);
  }
  console.log("Asks (price, level):");
  for (const [i, p] of asks.entries()) {
    console.log(`  ${i + 1}. ${formatUnits(p, config.tokenDecimals)} USDC`);
  }
  console.log();

  console.log("=== USER ORDERS ===");
  for (const [idx, [label, account]] of accountLabels.entries()) {
    const orderIds = userOrderIds[idx];
    const orders = userOrders[idx];
    console.log(`${label} (${account.account.address}): ${orderIds.length} order(s)`);
    for (const [j, orderId] of orderIds.entries()) {
      const order = orders[j];
      const side = order.quantity >= 0n ? "BUY" : "SELL";
      console.log(
        `  - ${orderId.slice(0, 10)}... | ${side} | price: ${formatUnits(
          order.price,
          config.tokenDecimals,
        )} | qty: ${formatUnits(order.quantity >= 0n ? order.quantity : -order.quantity, 6)}`,
      );
    }
  }
  console.log();

  console.log("=== USER POSITIONS ===");
  for (const [idx, [label, account]] of accountLabels.entries()) {
    const position = positions[idx];
    const hasPosition = position.netQuantity !== 0n;
    console.log(
      `${label} (${account.account.address}): ${
        hasPosition
          ? `${position.netQuantity >= 0n ? "LONG" : "SHORT"} ${formatUnits(
              position.netQuantity >= 0n ? position.netQuantity : -position.netQuantity,
              6,
            )} @ avg ${formatUnits(position.aggregatedEntryPrice, config.tokenDecimals)} USDC`
          : "no position"
      }`,
    );
  }
  console.log();

  console.log("=== USDC BALANCES ===");
  for (const [idx, [label]] of accountLabels.entries()) {
    console.log(`${label}: ${formatUnits(balances[idx], config.tokenDecimals)} USDC`);
  }
  console.log(`Owner: ${formatUnits(ownerBal, config.tokenDecimals)} USDC`);
  console.log();

  console.log("=== RESERVE & FEES ===");
  console.log("Reserve pool: ", formatUnits(reserve, config.tokenDecimals), "USDC");
  console.log("Collected fees:", formatUnits(fees, config.tokenDecimals), "USDC");
  console.log();

  await runPromise;
}

main();
