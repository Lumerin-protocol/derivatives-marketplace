import { network } from "hardhat";
import { deployPerpsWithCollateralFixture } from "../tests/fixtures.ts";

const conn = await network.getOrCreate();
const { contracts, accounts } = await conn.networkHelpers.loadFixture(
  deployPerpsWithCollateralFixture,
);
const { perps, optionsMock, pme } = contracts;
const { seller } = accounts;

async function step(name: string, fn: () => Promise<unknown>) {
  try {
    const r = await fn();
    console.log(`OK   ${name}:`, r);
  } catch (e: any) {
    console.log(`FAIL ${name}:`, e?.shortMessage ?? e?.message ?? e);
  }
}

await step("optionsMock.getNetGreeks(seller)", () => optionsMock.read.getNetGreeks([seller.account.address]));
await step("perps.getUserPosition(seller)", () => perps.read.getUserPosition([seller.account.address]));
await step("perps.decimals()", () => perps.read.decimals());
await step("perps.QUANTITY_DECIMALS()", () => perps.read.QUANTITY_DECIMALS());
await step("pme.imVolShock", () => pme.read.imVolShock());
await step("pme.mmVolShock", () => pme.read.mmVolShock());
