import { encodeFunctionData, maxUint256, parseUnits } from "viem";
import type { NetworkConnection } from "hardhat/types/network";

export async function deployRegistryFixture(conn: NetworkConnection) {
  const { viem } = conn;
  const [owner, admin, settler] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();

  const registryImpl = await viem.deployContract("OptionMarketRegistry", []);
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

  const bookImpl = await viem.deployContract("OptionOrderBook", []);
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
  tickSizeE8: 1_000_000, // $0.01 in 1e8
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

// ── Vault + PME helper ────────────────────────────────────────────────────

async function deployVaultAndPME(
  conn: NetworkConnection,
  usdcAddress: `0x${string}`,
  engineAddress: `0x${string}`,
) {
  const { viem } = conn;

  const vaultImpl = await viem.deployContract("CollateralVault", []);
  const vaultProxy = await viem.deployContract("ERC1967Proxy", [
    vaultImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: vaultImpl.abi,
      functionName: "initialize",
      args: [usdcAddress],
    }),
  ]);
  const vault = await viem.getContractAt("CollateralVault", vaultProxy.address);

  const perpsMock = await viem.deployContract("PerpsDEXMock", []);

  const pmeImpl = await viem.deployContract("PortfolioMarginEngine", []);
  const pmeProxy = await viem.deployContract("ERC1967Proxy", [
    pmeImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: pmeImpl.abi,
      functionName: "initialize",
      args: [vault.address],
    }),
  ]);
  const pme = await viem.getContractAt("PortfolioMarginEngine", pmeProxy.address);
  await pme.write.setPerps([perpsMock.address]);
  await pme.write.setOptions([engineAddress]);

  await vault.write.setMarginEngine([pme.address]);
  await vault.write.setAuthorizedCaller([engineAddress, true]);

  return { vault, pme, perpsMock };
}

// ── MarginEngine fixtures ─────────────────────────────────────────────────

export const ORACLE_DECIMALS = 8;
export const INITIAL_PRICE_E8 = 50000_00000000n; // $50,000

/** Spot index for Hashpower / hashrate instruments: USD per 1 PH/s per day (index scale 1e8). */
export const HASHRATE_USD_PER_PH_DAY = "42.1" as const;

/** @deprecated Use {@link HASHRATE_USD_PER_PH_DAY}. */
export const HASHRATE_USD_PER_100TH_DAY = HASHRATE_USD_PER_PH_DAY;

/** On-chain oracle answer for {@link HASHRATE_USD_PER_PH_DAY} with {@link ORACLE_DECIMALS} = 8. */
export const HASHRATE_INDEX_PRICE_E8 = parseUnits(HASHRATE_USD_PER_PH_DAY, 8);

/** Option strikes (1e8 index units) seeded by `deployLocalFullStackFixture` in fixtures.ts. */
export const HASHRATE_LOCAL_OPTIONS_STRIKES_E8 = [
  parseUnits("35.0", 8),
  parseUnits("40.0", 8),
  HASHRATE_INDEX_PRICE_E8,
  parseUnits("45.0", 8),
] as const;

export async function deployMarginEngineFixture(conn: NetworkConnection) {
  const data = await deployBookWithSeriesFixture(conn);
  const { registry, accounts } = data;
  const { owner } = accounts;
  const { viem } = conn;

  const usdc = await viem.deployContract("USDCMock", []);

  const oracle = await viem.deployContract("PriceOracleMock", [INITIAL_PRICE_E8, ORACLE_DECIMALS]);

  // Deploy vault first (engine needs it for initialize)
  const vaultImpl = await viem.deployContract("CollateralVault", []);
  const vaultProxy = await viem.deployContract("ERC1967Proxy", [
    vaultImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: vaultImpl.abi,
      functionName: "initialize",
      args: [usdc.address],
    }),
  ]);
  const vault = await viem.getContractAt("CollateralVault", vaultProxy.address);

  // Deploy engine with vault
  const engineImpl = await viem.deployContract("OptionMarginEngine", []);
  const engineProxy = await viem.deployContract("ERC1967Proxy", [
    engineImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: engineImpl.abi,
      functionName: "initialize",
      args: [registry.address, usdc.address, oracle.address, vault.address],
    }),
  ]);
  const engine = await viem.getContractAt("OptionMarginEngine", engineProxy.address);

  // Deploy PME with perps mock
  const perpsMock = await viem.deployContract("PerpsDEXMock", []);
  // PME reads spot price from perpsDex.getMarketPrice() — set it to match the oracle
  // INITIAL_PRICE_E8 = 50000_00000000 (8 dec) → token decimals (6): 50_000_000_000
  await perpsMock.write.setMarketPrice([50_000_000_000n]);

  const pmeImpl = await viem.deployContract("PortfolioMarginEngine", []);
  const pmeProxy = await viem.deployContract("ERC1967Proxy", [
    pmeImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: pmeImpl.abi,
      functionName: "initialize",
      args: [vault.address],
    }),
  ]);
  const pme = await viem.getContractAt("PortfolioMarginEngine", pmeProxy.address);
  await pme.write.setPerps([perpsMock.address], { account: owner.account });
  await pme.write.setOptions([engine.address], { account: owner.account });

  // Wire vault ↔ engine ↔ PME
  await vault.write.setMarginEngine([pme.address]);
  await vault.write.setAuthorizedCaller([engine.address, true]);
  await engine.write.setPortfolioMargin([pme.address], { account: owner.account });

  // Owner acts as router for Phase 3 tests
  await engine.write.setRouter([owner.account.address], { account: owner.account });

  // Get wallets for trader accounts
  const wallets = await viem.getWalletClients();
  const trader1 = wallets[3]!;
  const trader2 = wallets[4]!;

  // Transfer USDC and approve the vault (not the engine)
  const topUp = 100_000_000_000n; // 100k USDC (6 decimals)
  for (const w of [trader1, trader2]) {
    await usdc.write.transfer([w.account.address, topUp], { account: owner.account });
    const usdcAs = await viem.getContractAt("USDCMock", usdc.address, { client: { wallet: w } });
    await usdcAs.write.approve([vault.address, maxUint256]);
  }
  // Also approve for owner
  await usdc.write.approve([vault.address, maxUint256], { account: owner.account });

  return { ...data, engine, usdc, oracle, vault, pme, perpsMock, traders: { trader1, trader2 } };
}

// ── MarginEngine with liquidation config ─────────────────────────────────

export const LIQUIDATION_FEE_BPS = 500; // 5%
export const INSURANCE_DEPOSIT = 10_000_000_000n; // 10k USDC (6 dec)

// ── MatchingRouter fixtures ───────────────────────────────────────────────

export async function deployMatchingRouterFixture(conn: NetworkConnection) {
  const data = await deployMarginEngineFixture(conn);
  const { registry, book, engine, accounts, traders, usdc, vault } = data;
  const { owner } = accounts;
  const { viem } = conn;

  const routerImpl = await viem.deployContract("OptionMatchingRouter", []);
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

  // Fund traders with collateral via vault.deposit (vault is already approved)
  const depositAmount = 50_000_000_000n; // 50k USDC
  for (const w of [traders.trader1, traders.trader2]) {
    await vault.write.deposit([depositAmount], { account: w.account });
  }

  return { ...data, router, depositAmount };
}

// ── Settlement fixtures ──────────────────────────────────────────────────

export const SETTLEMENT_WINDOW = 1800; // 30 minutes
export const MIN_OBSERVATIONS = 3;

/**
 * Short expiry series (7 days from latest block time).
 * Used in settlement tests to enable time-travel past expiry.
 */
export async function deploySettlementFixture(conn: NetworkConnection) {
  const { viem, networkHelpers } = conn;
  const [owner] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();

  // ── Registry ──────────────────────────────────────────────────────────
  const registryImpl = await viem.deployContract("OptionMarketRegistry", []);
  const registryProxy = await viem.deployContract("ERC1967Proxy", [
    registryImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: registryImpl.abi,
      functionName: "initialize",
      args: [],
    }),
  ]);
  const registry = await viem.getContractAt("OptionMarketRegistry", registryProxy.address);

  // ── Mocks ─────────────────────────────────────────────────────────────
  const usdc = await viem.deployContract("USDCMock", []);
  const oracle = await viem.deployContract("PriceOracleMock", [INITIAL_PRICE_E8, ORACLE_DECIMALS]);

  // ── Vault ─────────────────────────────────────────────────────────────
  const vaultImpl = await viem.deployContract("CollateralVault", []);
  const vaultProxy = await viem.deployContract("ERC1967Proxy", [
    vaultImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: vaultImpl.abi,
      functionName: "initialize",
      args: [usdc.address],
    }),
  ]);
  const vault = await viem.getContractAt("CollateralVault", vaultProxy.address);

  // ── OrderBook ─────────────────────────────────────────────────────────
  const bookImpl = await viem.deployContract("OptionOrderBook", []);
  const bookProxy = await viem.deployContract("ERC1967Proxy", [
    bookImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: bookImpl.abi,
      functionName: "initialize",
      args: [registry.address],
    }),
  ]);
  const book = await viem.getContractAt("OptionOrderBook", bookProxy.address);

  // ── MarginEngine (with vault) ─────────────────────────────────────────
  const engineImpl = await viem.deployContract("OptionMarginEngine", []);
  const engineProxy = await viem.deployContract("ERC1967Proxy", [
    engineImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: engineImpl.abi,
      functionName: "initialize",
      args: [registry.address, usdc.address, oracle.address, vault.address],
    }),
  ]);
  const engine = await viem.getContractAt("OptionMarginEngine", engineProxy.address);

  // ── PME (with perps mock) ─────────────────────────────────────────────
  const perpsMock = await viem.deployContract("PerpsDEXMock", []);
  await perpsMock.write.setMarketPrice([50_000_000_000n]);

  const pmeImpl = await viem.deployContract("PortfolioMarginEngine", []);
  const pmeProxy = await viem.deployContract("ERC1967Proxy", [
    pmeImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: pmeImpl.abi,
      functionName: "initialize",
      args: [vault.address],
    }),
  ]);
  const pme = await viem.getContractAt("PortfolioMarginEngine", pmeProxy.address);
  await pme.write.setPerps([perpsMock.address], { account: owner.account });
  await pme.write.setOptions([engine.address], { account: owner.account });

  // ── MatchingRouter ────────────────────────────────────────────────────
  const routerImpl = await viem.deployContract("OptionMatchingRouter", []);
  const routerProxy = await viem.deployContract("ERC1967Proxy", [
    routerImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: routerImpl.abi,
      functionName: "initialize",
      args: [registry.address, book.address, engine.address],
    }),
  ]);
  const router = await viem.getContractAt("OptionMatchingRouter", routerProxy.address);

  // ── OptionSettlement ──────────────────────────────────────────────────
  const settlementImpl = await viem.deployContract("OptionSettlement", []);
  const settlementProxy = await viem.deployContract("ERC1967Proxy", [
    settlementImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: settlementImpl.abi,
      functionName: "initialize",
      args: [
        registry.address,
        engine.address,
        oracle.address,
        BigInt(SETTLEMENT_WINDOW),
        MIN_OBSERVATIONS,
      ],
    }),
  ]);
  const stl = await viem.getContractAt("OptionSettlement", settlementProxy.address);

  // ── Wiring ────────────────────────────────────────────────────────────
  await vault.write.setMarginEngine([pme.address]);
  await vault.write.setAuthorizedCaller([engine.address, true]);
  await engine.write.setPortfolioMargin([pme.address], { account: owner.account });

  await book.write.setRouter([router.address], { account: owner.account });
  await engine.write.setRouter([router.address], { account: owner.account });
  await engine.write.setSettlement([stl.address], { account: owner.account });
  await engine.write.setLiquidationFeeBps([LIQUIDATION_FEE_BPS], { account: owner.account });
  await registry.write.setAuthorizedContract([stl.address, true], { account: owner.account });

  // ── Create a series expiring in 7 days ─────────────────────────────────
  const latest = BigInt(await networkHelpers.time.latest());
  const shortExpiry = latest + 604800n; // 7 days

  await registry.write.createSeries(
    [
      defaultSeries.strikeE8,
      shortExpiry,
      defaultSeries.isCall,
      defaultSeries.tickSizeE8,
      defaultSeries.lotSize,
      defaultSeries.initialIV,
    ],
    { account: owner.account },
  );
  const seriesId = 1n;

  // ── Fund traders (approve vault, not engine) ───────────────────────────
  const wallets = await viem.getWalletClients();
  const trader1 = wallets[3]!;
  const trader2 = wallets[4]!;
  const trader3 = wallets[5]!; // extra trader for liquidation tests

  const topUp = 100_000_000_000n; // 100k USDC
  const depositAmount = 50_000_000_000n; // 50k USDC deposited into engine

  for (const w of [trader1, trader2, trader3]) {
    await usdc.write.transfer([w.account.address, topUp], { account: owner.account });
    const usdcAs = await viem.getContractAt("USDCMock", usdc.address, { client: { wallet: w } });
    await usdcAs.write.approve([vault.address, maxUint256]);
    await vault.write.deposit([depositAmount], { account: w.account });
  }

  // Owner funds insurance fund directly via the vault
  await usdc.write.approve([vault.address, maxUint256], { account: owner.account });
  await vault.write.depositInsuranceFund([INSURANCE_DEPOSIT], { account: owner.account });

  return {
    registry,
    book,
    engine,
    router,
    settlement: stl,
    oracle,
    usdc,
    vault,
    pme,
    perpsMock,
    seriesId,
    shortExpiry,
    traders: { trader1, trader2, trader3 },
    accounts: { owner, pc },
  };
}
