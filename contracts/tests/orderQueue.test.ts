import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";

const { networkHelpers } = await network.getOrCreate();

async function deployHarness(conn: NetworkConnection) {
  const harness = await conn.viem.deployContract("OrderQueueHarness", []);
  return { harness };
}

describe("OrderQueueLib", () => {
  describe("basic operations", () => {
    it("starts empty", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      assert.equal(await harness.read.isEmpty(), true);
      assert.equal(await harness.read.sizeOf(), 0n);
      assert.equal(await harness.read.peek(), 0n);
    });

    it("enqueue one item", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.enqueue([1n]);
      assert.equal(await harness.read.isEmpty(), false);
      assert.equal(await harness.read.sizeOf(), 1n);
      assert.equal(await harness.read.peek(), 1n);
      assert.equal(await harness.read.exists([1n]), true);
    });

    it("enqueue multiple, peek returns head (FIFO)", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.enqueue([10n]);
      await harness.write.enqueue([20n]);
      await harness.write.enqueue([30n]);

      assert.equal(await harness.read.sizeOf(), 3n);
      assert.equal(await harness.read.peek(), 10n);
    });
  });

  describe("dequeue (FIFO order)", () => {
    it("dequeues in insertion order", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.enqueue([1n]);
      await harness.write.enqueue([2n]);
      await harness.write.enqueue([3n]);

      await harness.write.dequeue();
      assert.equal(await harness.read.peek(), 2n);

      await harness.write.dequeue();
      assert.equal(await harness.read.peek(), 3n);

      await harness.write.dequeue();
      assert.equal(await harness.read.isEmpty(), true);
    });

    it("reverts on dequeue from empty queue", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await assert.rejects(harness.write.dequeue());
    });
  });

  describe("remove (arbitrary cancellation)", () => {
    it("remove from middle", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.enqueue([1n]);
      await harness.write.enqueue([2n]);
      await harness.write.enqueue([3n]);

      await harness.write.remove([2n]);

      assert.equal(await harness.read.sizeOf(), 2n);
      assert.equal(await harness.read.exists([2n]), false);
      assert.equal(await harness.read.peek(), 1n);

      await harness.write.dequeue();
      assert.equal(await harness.read.peek(), 3n);
    });

    it("remove head", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.enqueue([1n]);
      await harness.write.enqueue([2n]);

      await harness.write.remove([1n]);

      assert.equal(await harness.read.peek(), 2n);
      assert.equal(await harness.read.sizeOf(), 1n);
    });

    it("remove tail", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.enqueue([1n]);
      await harness.write.enqueue([2n]);
      await harness.write.enqueue([3n]);

      await harness.write.remove([3n]);

      assert.equal(await harness.read.sizeOf(), 2n);
      assert.equal(await harness.read.exists([3n]), false);

      await harness.write.dequeue();
      assert.equal(await harness.read.peek(), 2n);
    });

    it("remove sole element → empty", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.enqueue([42n]);
      await harness.write.remove([42n]);

      assert.equal(await harness.read.isEmpty(), true);
      assert.equal(await harness.read.sizeOf(), 0n);
    });
  });

  describe("getNext (iteration)", () => {
    it("walks the full queue via getNext", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.enqueue([10n]);
      await harness.write.enqueue([20n]);
      await harness.write.enqueue([30n]);

      let current = await harness.read.peek();
      const items: bigint[] = [];
      while (current !== 0n) {
        items.push(current);
        current = await harness.read.getNext([current]);
      }
      assert.deepEqual(items, [10n, 20n, 30n]);
    });
  });

  describe("exists", () => {
    it("returns false for orderId 0 (sentinel)", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      assert.equal(await harness.read.exists([0n]), false);
    });

    it("returns false after dequeue", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.enqueue([5n]);
      await harness.write.dequeue();
      assert.equal(await harness.read.exists([5n]), false);
    });
  });
});
