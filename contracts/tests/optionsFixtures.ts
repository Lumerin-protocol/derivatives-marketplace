import { encodeFunctionData } from "viem";
import type { NetworkConnection } from "hardhat/types/network";

export async function deployRegistryFixture(conn: NetworkConnection) {
  const { viem } = conn;
  const [owner, admin, settler] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();

  const registryImpl = await viem.deployContract(
    "contracts/OptionMarketRegistry.sol:OptionMarketRegistry",
    [],
  );
  const registryProxy = await viem.deployContract("ERC1967Proxy", [
    registryImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: registryImpl.abi,
      functionName: "initialize",
      args: [],
    }),
  ]);
  const registry = await viem.getContractAt("OptionMarketRegistry", registryProxy.address);

  await registry.write.setAuthorizedContract([settler.account.address, true], {
    account: owner.account,
  });

  return { registry, accounts: { owner, admin, settler, pc } };
}

export async function deployOrderBookFixture(conn: NetworkConnection) {
  const data = await deployRegistryFixture(conn);
  const { registry, accounts } = data;
  const { owner } = accounts;
  const { viem } = conn;

  const bookImpl = await viem.deployContract(
    "contracts/OptionOrderBook.sol:OptionOrderBook",
    [],
  );
  const bookProxy = await viem.deployContract("ERC1967Proxy", [
    bookImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: bookImpl.abi,
      functionName: "initialize",
      args: [registry.address],
    }),
  ]);
  const book = await viem.getContractAt("OptionOrderBook", bookProxy.address);

  // Owner acts as router for Phase 2 tests
  await book.write.setRouter([owner.account.address], { account: owner.account });

  return { ...data, book };
}

const YEAR_LATER = BigInt(Math.floor(Date.now() / 1000) + 365 * 86400);

export const defaultSeries = {
  strikeE8: 50000_00000000n, // $50,000
  expiryTs: YEAR_LATER,
  isCall: true,
  tickSizeE8: 1_000_000n, // $0.01 in 1e8
  lotSize: 1_000_000, // 1 contract (1e6)
  initialIV: 500_000_000_000_000_000n, // 50% = 0.5e18
} as const;

export async function deployBookWithSeriesFixture(conn: NetworkConnection) {
  const data = await deployOrderBookFixture(conn);
  const { registry, accounts } = data;
  const { owner } = accounts;

  const hash = await registry.write.createSeries(
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

  const seriesId = 1n;

  return { ...data, seriesId };
}
