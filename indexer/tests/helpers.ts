/**
 * Deterministic test data generators and event param helpers.
 * AssemblyScript has no Math.random, so we use seeds for reproducible, meaningful IDs.
 */
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { dataSourceMock } from "matchstick-as/assembly/index";
import { Perps } from "../generated/schema";

function padLeft(s: string, len: i32, char: string): string {
  while (s.length < len) {
    s = char + s;
  }
  return s;
}

/** Deterministic address from numeric id. e.g. userAddress(1) => 0x00...01 */
export function userAddress(id: i32): Address {
  const hex = padLeft(id.toString(16), 40, "0");
  return Address.fromString("0x" + hex);
}

/** Perps contract address for dataSourceMock. Distinct from user ids 1, 2, ... */
export function contractAddress(): Address {
  return userAddress(255); // 0x00...ff
}

/** Mock dataSource.address() to avoid "No mocked Eth address" warning. Call in beforeEach. */
export function setupDataSourceMock(): void {
  dataSourceMock.setAddress(contractAddress().toHexString());
}

/** Deterministic 32-byte order ID from seed. e.g. orderId(1) => 0x00...01 */
export function orderId(seed: i32): Bytes {
  const hex = padLeft(seed.toString(16), 64, "0");
  return Bytes.fromHexString("0x" + hex) as Bytes;
}

/** Event param helpers to avoid verbose ethereum.EventParam / ethereum.Value nesting */
export function paramAddr(name: string, value: Address): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromAddress(value));
}

export function paramBytes(name: string, value: Bytes): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromBytes(value));
}

export function paramUint(name: string, value: BigInt): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromUnsignedBigInt(value));
}

export function paramInt(name: string, value: BigInt): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromSignedBigInt(value));
}

/** Price level ID for assertions. e.g. priceLevel(price, true) => "{price}-bid" */
export function priceLevel(price: BigInt, isBid: boolean): string {
  return price.toString() + (isBid ? "-bid" : "-ask");
}

/** Pre-create Perps singleton so handlers don't call loadPerpsFromContract. */
export function setupPerps(): void {
  const perps = new Perps(0);
  perps.contractAddress = Bytes.empty();
  perps.collateralToken = Bytes.empty();
  perps.priceOracle = Bytes.empty();
  perps.collateralVault = Bytes.empty();
  perps.portfolioMarginEngine = Bytes.empty();
  perps.quantityDecimals = 6;
  perps.minimumPriceIncrement = BigInt.zero();
  perps.marginPercent = 0;
  perps.maintenanceMarginPercent = 0;
  perps.liquidationFee = BigInt.zero();
  perps.takerFeeBps = 0;
  perps.makerFeeBps = 0;
  perps.fundingRateMaxBps = BigInt.zero();
  perps.fundingPeriod = BigInt.zero();
  perps.cumulativeFundingPerUnit = BigInt.zero();
  perps.lastFundingUpdateTime = BigInt.zero();
  perps.minimumMarginPerOrder = BigInt.zero();
  perps.reservePoolBalance = BigInt.zero();
  perps.collectedFeesBalance = BigInt.zero();
  perps.totalUsers = 0;
  perps.totalOrders = 0;
  perps.activeOrders = 0;
  perps.totalTrades = 0;
  perps.totalVolume = BigInt.zero();
  perps.totalLiquidations = 0;
  perps.totalBadDebt = BigInt.zero();
  perps.initializedAt = BigInt.zero();
  perps.lastUpdatedAt = BigInt.zero();
  perps.save();
}

/** Tx hash from matchstick mock defaults */
const MOCK_TX_HASH = Bytes.fromHexString(
  "0xa16081f360e3847006db660bae1c6d1b2e17ec2a",
) as Bytes;

/**
 * Liquidation/etc. id from matchstick mock defaults.
 * createEventId = txHash.concatI32(logIndex).
 */
export function mockEventId(logIndex: i32 = 1): string {
  return MOCK_TX_HASH.concatI32(logIndex).toHexString();
}
