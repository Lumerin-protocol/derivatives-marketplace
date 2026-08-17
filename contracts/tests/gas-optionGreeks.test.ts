import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { encodeFunctionData } from "viem";
import { deployMarginEngineFixture } from "./optionsFixtures.ts";

const { networkHelpers, viem } = await network.connect();

describe("Gas: OptionMarginEngine Greeks", () => {
  it("getNetGreeks representative short position", async () => {
    const { engine, seriesId, traders, accounts } = await networkHelpers.loadFixture(
      deployMarginEngineFixture,
    );
    const user = traders.trader1.account.address;

    await engine.write.initializeIV([seriesId]);
    await engine.write.updatePosition([user, seriesId, -5n], { account: accounts.owner.account });

    const publicClient = await viem.getPublicClient();
    const gas = await publicClient.estimateGas({
      account: user,
      to: engine.address,
      data: encodeFunctionData({
        abi: engine.abi,
        functionName: "getNetGreeks",
        args: [user],
      }),
    });
    console.log(`  getNetGreeks representative short: ${gas.toLocaleString()} gas`);

    const [, gamma, vega] = await engine.read.getNetGreeks([user]);
    assert.ok(gamma < 0n);
    assert.ok(vega < 0n);
  });
});
