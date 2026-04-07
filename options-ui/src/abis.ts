import { parseAbi } from "viem";

export const registryAbi = parseAbi([
  "function getSeries(uint64 seriesId) view returns (uint64 strikeE8, uint64 expiryTs, bool isCall, uint32 tickSizeE8, uint32 lotSize, uint8 status, uint256 initialIV, uint256 settlementPrice)",
  "function nextSeriesId() view returns (uint64)",
]);

export const optionMarginEngineAbi = parseAbi([
  "function deposit(uint256 amount)",
  "function withdraw(uint256 amount)",
  "function getCollateral(address user) view returns (uint256)",
  "function getPosition(address user, uint64 seriesId) view returns (int128)",
  "function computeAccountIM(address user) view returns (uint256)",
  "function getReservedMargin(address user) view returns (uint256)",
  "function collateralToken() view returns (address)",
]);

export const optionMatchingRouterAbi = parseAbi([
  "function book() view returns (address)",
  "function submitOrder((uint64 seriesId, bool isBuy, uint64 priceTicks, uint128 size, uint8 orderType, bool postOnly, bool reduceOnly)) returns (uint64 orderId, uint128 filledSize, uint128 restedSize)",
  "function cancelOrder(uint64 orderId)",
]);

export const optionOrderBookAbi = parseAbi([
  "function bestBid(uint64 seriesId) view returns (uint64 orderId, uint64 priceTicks)",
  "function bestAsk(uint64 seriesId) view returns (uint64 orderId, uint64 priceTicks)",
  "function nextLevel(uint64 seriesId, bool isBuy, uint64 afterTick) view returns (uint64 nextTick, bool found)",
  "function nextOrderInQueue(uint64 seriesId, bool isBuy, uint64 priceTicks, uint64 afterOrderId) view returns (uint64)",
  "function getOrder(uint64 orderId) view returns (address trader, uint64 seriesId, bool isBuy, bool postOnly, bool reduceOnly, uint128 size, uint128 remaining, uint64 priceTicks)",
]);

export const collateralVaultAbi = parseAbi([
  "function getBalance(address user) view returns (uint256)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
