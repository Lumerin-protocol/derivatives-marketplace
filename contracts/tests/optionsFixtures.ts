import { encodeFunctionData, maxUint256 } from "viem";
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

// ── MarginEngine fixtures ─────────────────────────────────────────────────

export const ORACLE_DECIMALS = 8;
export const INITIAL_PRICE_E8 = 50000_00000000n; // $50,000

export async function deployMarginEngineFixture(conn: NetworkConnection) {
  const data = await deployBookWithSeriesFixture(conn);
  const { registry, accounts } = data;
  const { owner } = accounts;
  const { viem } = conn;

  const usdc = await viem.deployContract("contracts/USDCMock.sol:USDCMock", []);

  const oracle = await viem.deployContract(
    "contracts/PriceOracleMock.sol:PriceOracleMock",
    [INITIAL_PRICE_E8, ORACLE_DECIMALS],
  );

  const engineImpl = await viem.deployContract(
    "contracts/OptionMarginEngine.sol:OptionMarginEngine",
    [],
  );
  const engineProxy = await viem.deployContract("ERC1967Proxy", [
    engineImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: engineImpl.abi,
      functionName: "initialize",
      args: [registry.address, usdc.address, oracle.address],
    }),
  ]);
  const engine = await viem.getContractAt("OptionMarginEngine", engineProxy.address);

  // Owner acts as router for Phase 3 tests
  await engine.write.setRouter([owner.account.address], { account: owner.account });

  // Get wallets for trader accounts
  const wallets = await viem.getWalletClients();
  const trader1 = wallets[3]!;
  const trader2 = wallets[4]!;

  // Transfer USDC and approve the engine
  const topUp = 100_000_000_000n; // 100k USDC (6 decimals)
  for (const w of [trader1, trader2]) {
    await usdc.write.transfer([w.account.address, topUp], { account: owner.account });
    const usdcAs = await viem.getContractAt("USDCMock", usdc.address, { client: { wallet: w } });
    await usdcAs.write.approve([engine.address, maxUint256]);
  }
  // Also approve for owner
  await usdc.write.approve([engine.address, maxUint256], { account: owner.account });

  return { ...data, engine, usdc, oracle, traders: { trader1, trader2 } };
}

// ── MatchingRouter fixtures ───────────────────────────────────────────────

export async function deployMatchingRouterFixture(conn: NetworkConnection) {
  const data = await deployMarginEngineFixture(conn);
  const { registry, book, engine, accounts, traders, usdc } = data;
  const { owner } = accounts;
  const { viem } = conn;

  const routerImpl = await viem.deployContract(
    "contracts/OptionMatchingRouter.sol:OptionMatchingRouter",
    [],
  );
  const routerProxy = await viem.deployContract("ERC1967Proxy", [
    routerImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: routerImpl.abi,
      functionName: "initialize",
      args: [registry.address, book.address, engine.address],
    }),
  ]);
  const router = await viem.getContractAt("OptionMatchingRouter", routerProxy.address);

  // Set router as the authorized caller on book and engine
  await book.write.setRouter([router.address], { account: owner.account });
  await engine.write.setRouter([router.address], { account: owner.account });

  // Fund traders with collateral via engine.deposit
  const depositAmount = 50_000_000_000n; // 50k USDC
  for (const w of [traders.trader1, traders.trader2]) {
    const eng = await viem.getContractAt("OptionMarginEngine", engine.address, {
      client: { wallet: w },
    });
    await eng.write.deposit([depositAmount]);
  }

  return { ...data, router, depositAmount };
}
