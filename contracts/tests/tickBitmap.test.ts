import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";

const { viem, networkHelpers } = await network.connect();

async function deployHarness(conn: NetworkConnection) {
  const harness = await conn.viem.deployContract(
    "contracts/test/TickBitmapHarness.sol:TickBitmapHarness",
    [],
  );
  return { harness };
}

describe("TickBitmapLib", () => {
  describe("flipTick / isInitialized", () => {
    it("tick starts uninitialized", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      assert.equal(await harness.read.isInitialized([100]), false);
    });

    it("flip once → initialized", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([100]);
      assert.equal(await harness.read.isInitialized([100]), true);
    });

    it("flip twice → uninitialized (toggle)", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([100]);
      await harness.write.flipTick([100]);
      assert.equal(await harness.read.isInitialized([100]), false);
    });

    it("adjacent ticks are independent", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([100]);
      assert.equal(await harness.read.isInitialized([100]), true);
      assert.equal(await harness.read.isInitialized([99]), false);
      assert.equal(await harness.read.isInitialized([101]), false);
    });
  });

  describe("nextInitializedTickLte (same word, descending)", () => {
    it("finds tick at exact position", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([50]);
      const [next, found] = await harness.read.nextInitializedTickLte([50]);
      assert.equal(found, true);
      assert.equal(next, 50n);
    });

    it("finds closest lower tick in same word", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([40]);
      await harness.write.flipTick([60]);
      const [next, found] = await harness.read.nextInitializedTickLte([55]);
      assert.equal(found, true);
      assert.equal(next, 40n);
    });

    it("returns not found when no lower tick in word", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([100]);
      const [, found] = await harness.read.nextInitializedTickLte([50]);
      assert.equal(found, false);
    });
  });

  describe("nextInitializedTickGte (same word, ascending)", () => {
    it("finds tick at exact position", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([50]);
      const [next, found] = await harness.read.nextInitializedTickGte([50]);
      assert.equal(found, true);
      assert.equal(next, 50n);
    });

    it("finds closest higher tick in same word", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([40]);
      await harness.write.flipTick([60]);
      const [next, found] = await harness.read.nextInitializedTickGte([45]);
      assert.equal(found, true);
      assert.equal(next, 60n);
    });
  });

  describe("nextBid (cross-word descending scan)", () => {
    it("finds tick in previous word", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([200]);
      await harness.write.flipTick([300]);
      const [next, found] = await harness.read.nextBid([290, 0]);
      assert.equal(found, true);
      assert.equal(next, 200n);
    });

    it("respects minTick boundary", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([10]);
      const [, found] = await harness.read.nextBid([300, 100]);
      assert.equal(found, false);
    });

    it("finds the best bid among multiple", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([100]);
      await harness.write.flipTick([150]);
      await harness.write.flipTick([200]);
      const [next, found] = await harness.read.nextBid([250, 0]);
      assert.equal(found, true);
      assert.equal(next, 200n);
    });
  });

  describe("nextAsk (cross-word ascending scan)", () => {
    it("finds tick in next word", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([300]);
      const [next, found] = await harness.read.nextAsk([260, 500]);
      assert.equal(found, true);
      assert.equal(next, 300n);
    });

    it("respects maxTick boundary", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([500]);
      const [, found] = await harness.read.nextAsk([100, 400]);
      assert.equal(found, false);
    });

    it("finds the best ask among multiple", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([100]);
      await harness.write.flipTick([150]);
      await harness.write.flipTick([200]);
      const [next, found] = await harness.read.nextAsk([50, 500]);
      assert.equal(found, true);
      assert.equal(next, 100n);
    });
  });

  describe("cross-word boundary (tick 255-256)", () => {
    it("ticks on both sides of word boundary work", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([255]);
      await harness.write.flipTick([256]);

      assert.equal(await harness.read.isInitialized([255]), true);
      assert.equal(await harness.read.isInitialized([256]), true);

      const [askNext, askFound] = await harness.read.nextAsk([200, 500]);
      assert.equal(askFound, true);
      assert.equal(askNext, 255n);

      const [bidNext, bidFound] = await harness.read.nextBid([300, 0]);
      assert.equal(bidFound, true);
      assert.equal(bidNext, 256n);
    });
  });
});
