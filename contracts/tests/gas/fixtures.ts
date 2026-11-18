import type { NetworkConnection } from "hardhat/types/network";
import { deployPerpsFixture } from "../fixtures.ts";

const GAS_BENCHMARK_TIMESTAMP = 1_800_000_000n;

/** {deployPerpsFixture} pinned to a fixed block time, so receipt gas is deterministic. */
export async function deployPerpsGasFixture(conn: NetworkConnection) {
  const tc = await conn.viem.getTestClient();
  await tc.setNextBlockTimestamp({ timestamp: GAS_BENCHMARK_TIMESTAMP });
  await tc.mine({ blocks: 1 });
  return await deployPerpsFixture(conn);
}
