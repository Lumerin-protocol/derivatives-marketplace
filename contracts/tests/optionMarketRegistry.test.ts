import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { deployRegistryFixture, defaultSeries } from "./optionsFixtures.ts";

const { viem, networkHelpers } = await network.connect();

describe("OptionMarketRegistry", () => {
  describe("initialization", () => {
    it("nextSeriesId starts at 1", async () => {
      const { registry } = await networkHelpers.loadFixture(deployRegistryFixture);
      assert.equal(await registry.read.nextSeriesId(), 1n);
    });

    it("owner is set", async () => {
      const { registry, accounts } = await networkHelpers.loadFixture(deployRegistryFixture);
      const owner = await registry.read.owner();
      assert.equal(owner.toLowerCase(), accounts.owner.account.address.toLowerCase());
    });
  });

  describe("createSeries", () => {
    it("creates a series with correct fields", async () => {
      const { registry, accounts } = await networkHelpers.loadFixture(deployRegistryFixture);
      const { owner } = accounts;

      await registry.write.createSeries(
        [
          defaultSeries.strikeE8,
          defaultSeries.expiryTs,
          defaultSeries.isCall,
          defaultSeries.tickSizeE8,
          defaultSeries.lotSize,
          defaultSeries.initialIV,
        ],
        { account: owner.account },
      );

      const s = await registry.read.getSeries([1n]);
      assert.equal(s.strikeE8, defaultSeries.strikeE8);
      assert.equal(s.expiryTs, defaultSeries.expiryTs);
      assert.equal(s.isCall, defaultSeries.isCall);
      assert.equal(s.tickSizeE8, Number(defaultSeries.tickSizeE8));
      assert.equal(s.lotSize, defaultSeries.lotSize);
      assert.equal(s.initialIV, defaultSeries.initialIV);
      assert.equal(s.status, 1); // Active
    });

    it("increments nextSeriesId", async () => {
      const { registry, accounts } = await networkHelpers.loadFixture(deployRegistryFixture);
      const { owner } = accounts;

      await registry.write.createSeries(
        [defaultSeries.strikeE8, defaultSeries.expiryTs, true, defaultSeries.tickSizeE8, defaultSeries.lotSize, defaultSeries.initialIV],
        { account: owner.account },
      );
      await registry.write.createSeries(
        [defaultSeries.strikeE8, defaultSeries.expiryTs, false, defaultSeries.tickSizeE8, defaultSeries.lotSize, defaultSeries.initialIV],
        { account: owner.account },
      );

      assert.equal(await registry.read.nextSeriesId(), 3n);
    });

    it("reverts for non-owner", async () => {
      const { registry, accounts } = await networkHelpers.loadFixture(deployRegistryFixture);
      await assert.rejects(
        registry.write.createSeries(
          [defaultSeries.strikeE8, defaultSeries.expiryTs, true, defaultSeries.tickSizeE8, defaultSeries.lotSize, defaultSeries.initialIV],
          { account: accounts.admin.account },
        ),
      );
    });

    it("reverts for zero strike", async () => {
      const { registry, accounts } = await networkHelpers.loadFixture(deployRegistryFixture);
      await assert.rejects(
        registry.write.createSeries(
          [0n, defaultSeries.expiryTs, true, defaultSeries.tickSizeE8, defaultSeries.lotSize, defaultSeries.initialIV],
          { account: accounts.owner.account },
        ),
      );
    });

    it("reverts for past expiry", async () => {
      const { registry, accounts } = await networkHelpers.loadFixture(deployRegistryFixture);
      await assert.rejects(
        registry.write.createSeries(
          [defaultSeries.strikeE8, 1n, true, defaultSeries.tickSizeE8, defaultSeries.lotSize, defaultSeries.initialIV],
          { account: accounts.owner.account },
        ),
      );
    });

    it("reverts for IV > 500%", async () => {
      const { registry, accounts } = await networkHelpers.loadFixture(deployRegistryFixture);
      await assert.rejects(
        registry.write.createSeries(
          [defaultSeries.strikeE8, defaultSeries.expiryTs, true, defaultSeries.tickSizeE8, defaultSeries.lotSize, 6_000_000_000_000_000_000n],
          { account: accounts.owner.account },
        ),
      );
    });
  });

  describe("lifecycle transitions", () => {
    it("freeze → unfreeze round-trip", async () => {
      const { registry, accounts } = await networkHelpers.loadFixture(deployRegistryFixture);
      const { owner } = accounts;

      await registry.write.createSeries(
        [defaultSeries.strikeE8, defaultSeries.expiryTs, true, defaultSeries.tickSizeE8, defaultSeries.lotSize, defaultSeries.initialIV],
        { account: owner.account },
      );

      assert.equal(await registry.read.isActive([1n]), true);

      await registry.write.freezeSeries([1n], { account: owner.account });
      assert.equal(await registry.read.isActive([1n]), false);
      assert.equal((await registry.read.getStatus([1n])), 2); // Frozen

      await registry.write.unfreezeSeries([1n], { account: owner.account });
      assert.equal(await registry.read.isActive([1n]), true);
    });

    it("cannot freeze an already-frozen series", async () => {
      const { registry, accounts } = await networkHelpers.loadFixture(deployRegistryFixture);
      const { owner } = accounts;

      await registry.write.createSeries(
        [defaultSeries.strikeE8, defaultSeries.expiryTs, true, defaultSeries.tickSizeE8, defaultSeries.lotSize, defaultSeries.initialIV],
        { account: owner.account },
      );
      await registry.write.freezeSeries([1n], { account: owner.account });

      await assert.rejects(
        registry.write.freezeSeries([1n], { account: owner.account }),
      );
    });

    it("cannot unfreeze an active series", async () => {
      const { registry, accounts } = await networkHelpers.loadFixture(deployRegistryFixture);
      const { owner } = accounts;

      await registry.write.createSeries(
        [defaultSeries.strikeE8, defaultSeries.expiryTs, true, defaultSeries.tickSizeE8, defaultSeries.lotSize, defaultSeries.initialIV],
        { account: owner.account },
      );

      await assert.rejects(
        registry.write.unfreezeSeries([1n], { account: owner.account }),
      );
    });

    it("cannot freeze nonexistent series", async () => {
      const { registry, accounts } = await networkHelpers.loadFixture(deployRegistryFixture);
      await assert.rejects(
        registry.write.freezeSeries([99n], { account: accounts.owner.account }),
      );
    });
  });

  describe("settlement", () => {
    it("authorized settler can settle after expiry", async () => {
      const { registry, accounts } = await networkHelpers.loadFixture(deployRegistryFixture);
      const { owner, settler } = accounts;

      const now = await networkHelpers.time.latest();
      const nearExpiry = BigInt(now) + 60n;
      await registry.write.createSeries(
        [defaultSeries.strikeE8, nearExpiry, true, defaultSeries.tickSizeE8, defaultSeries.lotSize, defaultSeries.initialIV],
        { account: owner.account },
      );

      await networkHelpers.time.increaseTo(nearExpiry + 1n);

      const settlementPrice = 52000_00000000n;
      await registry.write.settleSeries([1n, settlementPrice], { account: settler.account });

      assert.equal(await registry.read.isSettled([1n]), true);
      const s = await registry.read.getSeries([1n]);
      assert.equal(s.settlementPrice, settlementPrice);
    });

    it("unauthorized caller cannot settle", async () => {
      const { registry, accounts } = await networkHelpers.loadFixture(deployRegistryFixture);
      const { owner, admin } = accounts;

      const now = await networkHelpers.time.latest();
      const nearExpiry = BigInt(now) + 60n;
      await registry.write.createSeries(
        [defaultSeries.strikeE8, nearExpiry, true, defaultSeries.tickSizeE8, defaultSeries.lotSize, defaultSeries.initialIV],
        { account: owner.account },
      );
      await networkHelpers.time.increaseTo(nearExpiry + 1n);

      await assert.rejects(
        registry.write.settleSeries([1n, 52000_00000000n], { account: admin.account }),
      );
    });

    it("cannot settle before expiry", async () => {
      const { registry, accounts } = await networkHelpers.loadFixture(deployRegistryFixture);
      const { owner, settler } = accounts;

      await registry.write.createSeries(
        [defaultSeries.strikeE8, defaultSeries.expiryTs, true, defaultSeries.tickSizeE8, defaultSeries.lotSize, defaultSeries.initialIV],
        { account: owner.account },
      );

      await assert.rejects(
        registry.write.settleSeries([1n, 52000_00000000n], { account: settler.account }),
      );
    });

    it("cannot settle twice", async () => {
      const { registry, accounts } = await networkHelpers.loadFixture(deployRegistryFixture);
      const { owner, settler } = accounts;

      const now = await networkHelpers.time.latest();
      const nearExpiry = BigInt(now) + 60n;
      await registry.write.createSeries(
        [defaultSeries.strikeE8, nearExpiry, true, defaultSeries.tickSizeE8, defaultSeries.lotSize, defaultSeries.initialIV],
        { account: owner.account },
      );
      await networkHelpers.time.increaseTo(nearExpiry + 1n);

      await registry.write.settleSeries([1n, 52000_00000000n], { account: settler.account });
      await assert.rejects(
        registry.write.settleSeries([1n, 52000_00000000n], { account: settler.account }),
      );
    });
  });
});
