import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { parseUnits, getAddress } from "viem";
import { deployPerpsWithCollateralFixture, deployPerpsWithPositionsFixture } from "./fixtures";

describe("PerpsSimple - getUserPosition", function () {
  it("should return zero position when user has no position", async function () {
    const { contracts, accounts } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const position = await perps.read.getUserPosition([buyer.account.address]);
    expect(position.netQuantity).to.equal(0n);
    expect(position.aggregatedEntryPrice).to.equal(0n);
  });

  it("should return correct position for long", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithPositionsFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const position = await perps.read.getUserPosition([buyer.account.address]);
    expect(position.netQuantity > 0n).to.be.true; // Long position
    expect(position.aggregatedEntryPrice).to.equal(config.marketPrice);
  });

  it("should return correct position for short", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithPositionsFixture);
    const { perps } = contracts;
    const { seller } = accounts;

    const position = await perps.read.getUserPosition([seller.account.address]);
    expect(position.netQuantity < 0n).to.be.true; // Short position
    expect(position.aggregatedEntryPrice).to.equal(config.marketPrice);
  });

  it("should update aggregated entry price on adding to position", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithPositionsFixture);
    const { perps } = contracts;
    const { seller, buyer } = accounts;
    const tick = config.minimumPriceIncrement;

    const positionBefore = await perps.read.getUserPosition([buyer.account.address]);

    // Create another matching trade at a different price
    const newPrice = config.marketPrice + tick;

    await perps.write.createOrder([newPrice, -BigInt(config.qty)], {
      account: seller.account,
    });
    await perps.write.createOrder([newPrice, BigInt(config.qty)], {
      account: buyer.account,
    });

    const positionAfter = await perps.read.getUserPosition([buyer.account.address]);

    // Position size should have increased
    expect(positionAfter.netQuantity > positionBefore.netQuantity).to.be.true;

    // Entry price should be weighted average
    expect(positionAfter.aggregatedEntryPrice > positionBefore.aggregatedEntryPrice).to.be.true;
    expect(positionAfter.aggregatedEntryPrice < newPrice).to.be.true;
  });

  it("should return zero position after full close", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithPositionsFixture);
    const { perps } = contracts;
    const { seller, buyer } = accounts;

    // Create opposite trade to close position
    await perps.write.createOrder([config.marketPrice, BigInt(config.qty)], {
      account: seller.account,
    });
    await perps.write.createOrder([config.marketPrice, -BigInt(config.qty)], {
      account: buyer.account,
    });

    const buyerPosition = await perps.read.getUserPosition([buyer.account.address]);
    expect(buyerPosition.netQuantity).to.equal(0n);
  });
});
