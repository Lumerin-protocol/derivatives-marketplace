import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { deployPerpsFixture } from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

/** The admin module (N27): the owner-only bodies, run by delegatecall from the implementation. */
describe("HashPowerPerpsDEX - admin module", function () {
  it("runs the owner-only calls through the proxy: owner allowed, anyone else rejected", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps } = contracts;
    const { owner, buyer } = accounts;

    await perps.write.setMakerFeeBps([2], { account: owner.account });
    assert.equal(await perps.read.makerFeeBps(), 2);

    await viem.assertions.revertWithCustomError(
      perps.write.setMakerFeeBps([3], { account: buyer.account }),
      perps,
      "OwnableUnauthorizedAccount",
    );
    assert.equal(await perps.read.makerFeeBps(), 2);
  });

  it("cannot be used directly and reports the implementation's version", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { owner } = accounts;
    const module = await viem.deployContract("HashPowerPerpsDEXAdminModule", [contracts.vault.address]);

    assert.equal(await module.read.VERSION(), await contracts.perps.read.VERSION());
    await viem.assertions.revertWithCustomError(
      module.write.setMakerFeeBps([1], { account: owner.account }),
      module,
      "OwnableUnauthorizedAccount",
    );
  });
});
