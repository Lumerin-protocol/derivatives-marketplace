import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";

const { networkHelpers } = await network.getOrCreate();

async function deployHarness(conn: NetworkConnection) {
  const harness = await conn.viem.deployContract("TickBitmapHarness", []);
  return { harness };
}

describe("TickBitmapLib", () => {
  describe("flipTick / isInitialized", () => {
    it("tick starts uninitialized", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      assert.equal(await harness.read.isInitialized([100n]), false);
    });

    it("flip once → initialized", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([100n]);
      assert.equal(await harness.read.isInitialized([100n]), true);
    });

    it("flip twice → uninitialized (toggle)", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([100n]);
      await harness.write.flipTick([100n]);
      assert.equal(await harness.read.isInitialized([100n]), false);
    });

    it("adjacent ticks are independent", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([100n]);
      assert.equal(await harness.read.isInitialized([100n]), true);
      assert.equal(await harness.read.isInitialized([99n]), false);
      assert.equal(await harness.read.isInitialized([101n]), false);
    });
  });

  describe("nextInitializedTickLte (same word, descending)", () => {
    it("finds tick at exact position", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([50n]);
      const [next, found] = await harness.read.nextInitializedTickLte([50n]);
      assert.equal(found, true);
      assert.equal(next, 50n);
    });

    it("finds closest lower tick in same word", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([40n]);
      await harness.write.flipTick([60n]);
      const [next, found] = await harness.read.nextInitializedTickLte([55n]);
      assert.equal(found, true);
      assert.equal(next, 40n);
    });

    it("returns not found when no lower tick in word", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([100n]);
      const [, found] = await harness.read.nextInitializedTickLte([50n]);
      assert.equal(found, false);
    });
  });

  describe("nextInitializedTickGte (same word, ascending)", () => {
    it("finds tick at exact position", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([50n]);
      const [next, found] = await harness.read.nextInitializedTickGte([50n]);
      assert.equal(found, true);
      assert.equal(next, 50n);
    });

    it("finds closest higher tick in same word", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([40n]);
      await harness.write.flipTick([60n]);
      const [next, found] = await harness.read.nextInitializedTickGte([45n]);
      assert.equal(found, true);
      assert.equal(next, 60n);
    });
  });

  describe("nextBid (cross-word descending scan)", () => {
    it("finds tick in previous word", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([200n]);
      await harness.write.flipTick([300n]);
      const [next, found] = await harness.read.nextBid([290n, 0n]);
      assert.equal(found, true);
      assert.equal(next, 200n);
    });

    it("respects minTick boundary", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([10n]);
      const [, found] = await harness.read.nextBid([300n, 100n]);
      assert.equal(found, false);
    });

    it("finds the best bid among multiple", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([100n]);
      await harness.write.flipTick([150n]);
      await harness.write.flipTick([200n]);
      const [next, found] = await harness.read.nextBid([250n, 0n]);
      assert.equal(found, true);
      assert.equal(next, 200n);
    });
  });

  describe("nextAsk (cross-word ascending scan)", () => {
    it("finds tick in next word", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([300n]);
      const [next, found] = await harness.read.nextAsk([260n, 500n]);
      assert.equal(found, true);
      assert.equal(next, 300n);
    });

    it("respects maxTick boundary", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([500n]);
      const [, found] = await harness.read.nextAsk([100n, 400n]);
      assert.equal(found, false);
    });

    it("finds the best ask among multiple", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([100n]);
      await harness.write.flipTick([150n]);
      await harness.write.flipTick([200n]);
      const [next, found] = await harness.read.nextAsk([50n, 500n]);
      assert.equal(found, true);
      assert.equal(next, 100n);
    });
  });

  describe("cross-word boundary (tick 255-256)", () => {
    it("ticks on both sides of word boundary work", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.flipTick([255n]);
      await harness.write.flipTick([256n]);

      assert.equal(await harness.read.isInitialized([255n]), true);
      assert.equal(await harness.read.isInitialized([256n]), true);

      const [askNext, askFound] = await harness.read.nextAsk([200n, 500n]);
      assert.equal(askFound, true);
      assert.equal(askNext, 255n);

      const [bidNext, bidFound] = await harness.read.nextBid([300n, 0n]);
      assert.equal(bidFound, true);
      assert.equal(bidNext, 256n);
    });
  });
});
