import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { isAddressEqual } from "viem";
import { engineIndexOracle } from "../scripts/lib/engine-index.ts";

const { viem } = await network.connect();

/** BTC/USD $100,000 (8 decimals). */
const BTC_USD = 10_000_000_000_000n;

async function oracles() {
  const btc = await viem.deployContract("HashpriceBTCMock", []);
  const btcUsd = await viem.deployContract("PriceOracleMock", [BTC_USD, 8]);
  const hashpriceUSD = await viem.deployContract("HashpriceUSD", [btc.address, btcUsd.address]);
  const glideUSD = await viem.deployContract("HashpriceGlideUSD", [hashpriceUSD.address]);
  return { hashpriceUSD, glideUSD, pc: await viem.getPublicClient() };
}

/**
 * N31: with `MARGIN_ENGINE_ADDRESS` set, `deploy-perps.ts` set the engine's oracle to the perps
 * feed. Perps runs on the glide, so the engine's index (options delta and the `getRiskView`
 * fallback) moved to the glide instead of staying on `HashpriceUSD`.
 */
describe("N31 — the perps deploy keeps the engine on the index", () => {
  it("sets the engine to the glide's index, not to the glide", async () => {
    const { hashpriceUSD, glideUSD, pc } = await oracles();

    const index = await engineIndexOracle(pc, glideUSD.address);

    assert.ok(isAddressEqual(index, hashpriceUSD.address), `engine oracle ${index} is not HashpriceUSD`);
  });

  it("keeps a perps feed that is the index itself", async () => {
    const { hashpriceUSD, pc } = await oracles();

    const index = await engineIndexOracle(pc, hashpriceUSD.address);

    assert.ok(isAddressEqual(index, hashpriceUSD.address));
  });
});
