import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";

const { viem, networkHelpers } = await network.connect();

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
      await harness.write.enqueue([1]);
      assert.equal(await harness.read.isEmpty(), false);
      assert.equal(await harness.read.sizeOf(), 1n);
      assert.equal(await harness.read.peek(), 1n);
      assert.equal(await harness.read.exists([1]), true);
    });

    it("enqueue multiple, peek returns head (FIFO)", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.enqueue([10]);
      await harness.write.enqueue([20]);
      await harness.write.enqueue([30]);

      assert.equal(await harness.read.sizeOf(), 3n);
      assert.equal(await harness.read.peek(), 10n);
    });
  });

  describe("dequeue (FIFO order)", () => {
    it("dequeues in insertion order", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.enqueue([1]);
      await harness.write.enqueue([2]);
      await harness.write.enqueue([3]);

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
      await harness.write.enqueue([1]);
      await harness.write.enqueue([2]);
      await harness.write.enqueue([3]);

      await harness.write.remove([2]);

      assert.equal(await harness.read.sizeOf(), 2n);
      assert.equal(await harness.read.exists([2]), false);
      assert.equal(await harness.read.peek(), 1n);

      await harness.write.dequeue();
      assert.equal(await harness.read.peek(), 3n);
    });

    it("remove head", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.enqueue([1]);
      await harness.write.enqueue([2]);

      await harness.write.remove([1]);

      assert.equal(await harness.read.peek(), 2n);
      assert.equal(await harness.read.sizeOf(), 1n);
    });

    it("remove tail", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.enqueue([1]);
      await harness.write.enqueue([2]);
      await harness.write.enqueue([3]);

      await harness.write.remove([3]);

      assert.equal(await harness.read.sizeOf(), 2n);
      assert.equal(await harness.read.exists([3]), false);

      await harness.write.dequeue();
      assert.equal(await harness.read.peek(), 2n);
    });

    it("remove sole element → empty", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.enqueue([42]);
      await harness.write.remove([42]);

      assert.equal(await harness.read.isEmpty(), true);
      assert.equal(await harness.read.sizeOf(), 0n);
    });
  });

  describe("getNext (iteration)", () => {
    it("walks the full queue via getNext", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.enqueue([10]);
      await harness.write.enqueue([20]);
      await harness.write.enqueue([30]);

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
      assert.equal(await harness.read.exists([0]), false);
    });

    it("returns false after dequeue", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await harness.write.enqueue([5]);
      await harness.write.dequeue();
      assert.equal(await harness.read.exists([5]), false);
    });
  });
});
