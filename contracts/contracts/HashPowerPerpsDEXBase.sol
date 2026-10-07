//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { StructuredLinkedList } from "solidity-linked-list/contracts/StructuredLinkedList.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { AggregatorV3Interface } from "./interfaces/AggregatorV3Interface.sol";
import { ICollateralVault } from "collateral-margin/contracts/contracts/interfaces/ICollateralVault.sol";
import { IPortfolioMarginEngine } from "collateral-margin/contracts/contracts/interfaces/IPortfolioMarginEngine.sol";
import { IPointsHook } from "collateral-margin/contracts/contracts/interfaces/IPointsHook.sol";
import { PriceLadderLib } from "./libs/PriceLadderLib.sol";
import { MathLib as M } from "./libs/MathLib.sol";
import { Versionable } from "./interfaces/Versionable.sol";

/// @title HashPowerPerpsDEXBase — storage layout and internal helpers for {HashPowerPerpsDEX}
/// @dev Owns the full UUPS storage layout (declaration order is part of the layout — do not reorder).
///      {HashPowerPerpsDEX} declares no state of its own; append new storage here, at the end.
abstract contract HashPowerPerpsDEXBase is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    Versionable
{
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using EnumerableSet for EnumerableSet.AddressSet;
    using StructuredLinkedList for StructuredLinkedList.List;

    // Constants
    uint256 public constant MAX_ORACLE_STALENESS = 3600; // 1 hour
    uint8 public constant FUNDING_DECIMALS = 18;
    uint8 public constant MAX_ORDERS_PER_PARTICIPANT = 100;
    uint8 public constant QUANTITY_DECIMALS = 6;
    uint256 public constant MAX_PRICE_LEVELS_PER_SIDE = 200;
    uint256 internal constant BPS = 10_000; // Basis points denominator
    /// @notice Hard ceiling on |makerFeeBps| and |takerFeeBps|: 100 bps (1%).
    /// @dev Keeps a trading fee at most a fifth of the 5% MM spot shock, so the argument
    ///      that the MM floor already covers the unreserved fee holds by construction
    ///      rather than by operational convention. An `int16` setter would otherwise
    ///      accept 327%.
    int16 internal constant MAX_FEE_BPS = 100;
    /// @notice Minimum price increment for orders: $0.01 in USDC (6 decimals).
    uint256 public constant minimumPriceIncrement = 0.01e6;
    /// @notice Contract size in hashes/s·day: the hashes produced by a given hashrate sustained over one day.
    ///         Fixed at 1e15 (1 PH/s over a day) so one contract equals 1 PH/s/day. Matches the hashprice
    ///         oracle quote basis (1 PH/s per day) — no unit rebase is applied in `getMarketPrice()`.
    ///         Intentionally a constant: resizing live contracts is a migration, not a live parameter change.
    uint256 public constant CONTRACT_SIZE_HPS_DAY = 1e15;

    // Immutables (set in constructor, derived from vault)
    ICollateralVault public immutable vault;
    /// @dev Collateral token decimals (must be 6). Distinct from QUANTITY_DECIMALS.
    uint8 internal immutable collateralDecimals;
    /// @notice Keyless protocol backstop account (vault `BACKSTOP_ADDR`). Liquidation hands the
    ///         closed quantity to it as an explicit position; anyone may shrink that position
    ///         through `unwindBackstop`. It never rests orders and is never liquidated.
    address public immutable BACKSTOP;

    // State variables
    address private __gap0;
    AggregatorV3Interface public priceOracle;
    /// @dev Dead — former marginPercent. Margin is now delegated to PortfolioMarginEngine.
    uint8 private __gap1;
    /// @dev Dead — former maintenanceMarginPercent. Margin is now delegated to PortfolioMarginEngine.
    uint8 private __gap2;
    uint256 internal __gap3;
    uint8 private __gap4;
    uint8 internal oracleDecimals;
    uint256 private nonce; // Nonce for order IDs

    // Order book mappings
    mapping(bytes32 => Order) internal orders;
    mapping(uint256 => StructuredLinkedList.List) private priceOrdersLongQueue; // FIFO queue of long orders by price
    mapping(uint256 => StructuredLinkedList.List) private priceOrdersShortQueue; // FIFO queue of short orders by price
    mapping(address => EnumerableSet.Bytes32Set) internal participantOrderIdsIndex; // Orders by participant
    mapping(address => uint256) private __gap5;

    // Price level tracking for limit order matching
    StructuredLinkedList.List internal activeBidPrices; // Sorted bid prices (highest first)
    StructuredLinkedList.List internal activeAskPrices; // Sorted ask prices (lowest first)

    // Position mappings - net position per user
    mapping(address => Position) internal positions; // Net position per user
    /// @dev Dead legacy enumeration slot. Retained untouched for upgrade storage compatibility;
    ///      never read, written, reused, or cleared.
    EnumerableSet.AddressSet internal usersWithPositions;

    // Reserve and fees
    int16 public takerFeeBps; // Taker fee in basis points (e.g., 5 = 0.05%)
    int16 public makerFeeBps; // Maker fee in basis points (e.g., 0 = 0%)

    // Funding state
    int256 public cumulativeFundingPerUnit; // Global cumulative funding per unit (tokenDecimals * 10^FUNDING_DECIMALS)
    uint256 public lastFundingUpdateTime; // Last timestamp funding was updated
    uint256 public fundingRateMaxBps; // Max absolute funding rate per fundingPeriod in bps (e.g., 100 = 1%)
    uint256 public fundingPeriod; // Period for max funding rate (e.g., 86400 = 24 hours)
    mapping(address => int256) internal userFundingSnapshot; // Per-user snapshot of cumulativeFundingPerUnit

    // Order book limits
    /// @notice Deprecated compatibility value; no order path enforces it.
    /// @dev Retained forever at its historical slot, with its generated getter, because
    ///      integrations and existing proxies may still read governance's last configured value.
    uint256 public minimumMarginPerOrder;
    /// @dev Deprecated/dead legacy cache slots. Retained forever for proxy storage compatibility.
    ///      v2.13+ must never read or write these mappings.
    mapping(address => uint256) internal userBuyOrderValue;
    mapping(address => uint256) internal userSellOrderValue;

    // Level 2: Unified collateral vault (moved to immutable)
    address private __gap6;
    IPortfolioMarginEngine public portfolioMargin;

    /// @notice Optional points/rewards hook notified on fills and liquidations.
    /// @dev Appended at the end of storage to preserve the upgradeable layout. When unset
    ///      (`address(0)`) the venue mints no points and skips the call entirely. When set,
    ///      hook calls are NOT wrapped in try/catch: a reverting hook will revert the fill or
    ///      liquidation. The hook is a simple, owner-controlled contract and can be unplugged
    ///      instantly via `setHook(address(0))`; unplug it before finalizing the POINTS token.
    IPointsHook public hook;

    /// @notice Liquidation fee in basis points on the liquidated notional.
    ///         e.g., 50 = 0.5% of the closed position or cancelled order value.
    /// @dev Appended at end of storage to preserve the upgradeable layout.
    uint16 public liquidationFeeBps;
    /// @notice Share of the liquidation fee paid to the keeper (msg.sender).
    ///         In basis points: 10_000 = 100% to liquidator, 5_000 = 50/50 split.
    ///         The remainder becomes venue revenue in this contract's vault account.
    /// @dev Appended at end of storage to preserve the upgradeable layout.
    uint16 public liquidatorShareBps;

    /// @dev Deprecated/dead legacy cache slots. Retained forever for proxy storage compatibility.
    ///      v2.13+ must never read or write these mappings.
    mapping(address => uint256) internal userBuyOrderQty;
    mapping(address => uint256) internal userSellOrderQty;

    /// @notice Canonical cached totals for a user's remaining resting orders.
    struct OrderAggregate {
        uint256 buyQty;
        uint256 sellQty;
        uint256 buyValue;
        uint256 sellValue;
    }

    /// @dev Appended at the storage tail in v2.13. Never move above the four legacy mappings.
    mapping(address => OrderAggregate) internal userOrderAggregate;

    /// @notice Represents an order in the order book
    struct Order {
        address participant;
        uint256 price; // Order price
        int256 quantity; // Order quantity (positive = long/buy, negative = short/sell)
    }

    /// @notice Represents a user's net position
    struct Position {
        int256 netQuantity; // Net position quantity (positive = long, negative = short)
        int256 netEntryValue; // Exact signed entry value in collateral units
    }

    /// @notice Order lifetime / fill policy. GTD is not supported.
    enum TimeInForce {
        GTC, // rest unfilled size on the book
        IOC, // fill what is available now; cancel remainder; revert if nothing fills
        FOK // fill entire size now or revert

    }

    /// @notice One placement in a `createOrders` / `updateOrders` batch.
    struct OrderIntent {
        uint256 price;
        int256 quantity; // >0 bid/long, <0 ask/short
        TimeInForce timeInForce;
    }

    /// @notice Shrink a resting order in place (FIFO position preserved).
    struct ReduceIntent {
        bytes32 orderId;
        int256 newQuantity; // same sign as resting; 0 < |new| < |old|
    }

    // Events
    event OrderCreated(bytes32 indexed orderId, address indexed participant, uint256 price, int256 quantity);
    event OrderCancelled(bytes32 indexed orderId, address indexed participant);
    /// @notice Resting size changed (partial fill, IOC remainder close, or reduce-only amend).
    /// @dev Indexers must attribute fills only when paired with `OrderMatched` in the same tx;
    ///      a lone shrink is a reduce-only amend (FIFO kept, not a trade).
    event OrderUpdated(bytes32 indexed orderId, address indexed participant, int256 newQuantity);
    event OrderMatched(
        bytes32 indexed makerOrderId,
        address indexed maker,
        address indexed taker,
        uint256 tradePrice,
        int256 takerQuantity,
        int256 makerFee,
        int256 takerFee,
        int256 makerNetQtyAfter,
        int256 takerNetQtyAfter,
        uint256 makerEntryPriceAfter,
        uint256 takerEntryPriceAfter
    );
    event MakerFeeBpsUpdated(int16 newMakerFeeBps);
    event TakerFeeBpsUpdated(int16 newTakerFeeBps);
    event LiquidationFeeBpsUpdated(uint16 newLiquidationFeeBps);
    event LiquidatorShareBpsUpdated(uint16 newLiquidatorShareBps);
    event OracleUpdated(address newOracle);
    event PortfolioMarginUpdated(address newPortfolioMargin);
    event PositionLiquidated(
        address indexed user, address indexed liquidator, int256 closedQuantity, int256 pnl, uint256 liquidatorFee
    );
    /// @notice Emitted when a resting order is force-cancelled by a permissionless liquidator.
    /// @dev `OrderCancelled` is also emitted from the same path so order-lifecycle indexers
    ///      keep working unchanged.
    event OrderLiquidated(bytes32 indexed orderId, address indexed user, address indexed liquidator, uint256 fee);
    event FundingUpdated(int256 fundingRate, int256 cumulativeFundingPerUnit, uint256 timestamp);
    event FundingSettled(address indexed user, int256 amount);
    event FundingParametersUpdated(uint256 maxBps, uint256 period);
    /// @dev Deprecated compatibility event retained with the legacy setter.
    event MinimumMarginPerOrderUpdated(uint256 newMinimumMarginPerOrder);
    /// @notice Emitted whenever the points hook address changes.
    event HookUpdated(address indexed hook);
    /// @notice Liquidation moved `quantity` (signed, the liquidated user's side) from `user` to the
    ///         backstop at `price`. Indexers apply it to the backstop's position only; the user's
    ///         side is already covered by `PositionLiquidated`.
    event BackstopAssigned(address indexed user, int256 quantity, uint256 price);
    /// @notice `caller` reduced the backstop by `filledQuantity` (signed, the backstop's taker side)
    ///         and was paid `fee` from the fee pot.
    event BackstopUnwound(address indexed caller, int256 filledQuantity, uint256 fee);

    // Errors
    error InvalidPrice();
    error InvalidQty();
    error InsufficientMarginBalance();
    error OracleStale();
    error InvalidOracle();
    error ValueOutOfRange(int256 min, int256 max);
    error OrderNotBelongToSender();
    error MaxOrdersPerParticipantReached();
    error NotLiquidatable();
    error OrdersStillOpen(); // liquidatePosition called while user has open orders
    /// @notice Partial liquidation left balance above IM while a real IM>MM buffer remains.
    error OverLiquidation();
    error OrderNotBelongToUser(); // liquidateOrder called with an id not owned by the specified user
    error InvalidFundingParameters();
    /// @notice Fee magnitude above `MAX_FEE_BPS`, or a maker+taker sum below zero (which
    ///         would make every match a net outflow from the fee pot).
    error InvalidFee();
    /// @dev Deprecated compatibility declaration. Runtime order paths no longer raise it.
    error OrderMarginTooLow();
    error MaxPriceLevelsReached(); // Too many active price levels on one side of the book
    error InsuranceFundNotConfigured(); // CollateralVault.insuranceFund not set by vault owner
    /// @notice FOK could not fill entirely, or IOC matched nothing.
    error TimeInForceNotFilled();
    error InvalidTimeInForce();
    error InvalidReduceQuantity();
    error OrderNotExists();
    error EmptyBatch();
    /// @notice New order placement is rejected while the vault has halted trading.
    error TradingHalted();
    error ZeroAddress();
    /// @notice The margin engine aggregates a different vault than this venue settles into.
    error VaultMismatch();
    /// @dev A dependency did not answer a call the venue depends on: no code at the address,
    ///      or the call reverted. Which dependency is bad is implied by the setter that reverted.
    error InvalidDependency();
    /// @notice Perps prices, values, and ticks are denominated in six-decimal collateral.
    error UnsupportedTokenDecimals();
    /// @notice The backstop account cannot be liquidated; use `unwindBackstop`.
    error BackstopAccount();
    /// @notice The backstop holds no position to unwind.
    error PositionNotExists();
    /// @notice Owner escape hatch that must run while the vault is halted.
    error NotHalted();

    /// @param _vault The shared collateral vault. Its `collateralToken()` becomes the underlying ERC20.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(ICollateralVault _vault) {
        if (address(_vault) == address(0)) revert ZeroAddress();
        vault = _vault;
        collateralDecimals = IERC20Metadata(address(_vault.collateralToken())).decimals();
        if (collateralDecimals != 6) revert UnsupportedTokenDecimals();
        BACKSTOP = _vault.BACKSTOP_ADDR();
        if (BACKSTOP == address(0)) revert ZeroAddress();
        _disableInitializers();
    }

    // ── Internal helpers: admin / config ──────────────────────────────────────

    /// @dev Validates a proposed (maker, taker) fee pair. Both bounds matter:
    ///      `MAX_FEE_BPS` keeps the unreserved fee small relative to the MM floor, and the
    ///      non-negative sum keeps a match from being a net outflow — without it a maker
    ///      rebate exceeding the taker fee drains the fee pot once per trade, unbounded in
    ///      volume.
    function _validateFees(int16 _makerFeeBps, int16 _takerFeeBps) internal pure {
        if (_makerFeeBps > MAX_FEE_BPS || _makerFeeBps < -MAX_FEE_BPS) revert InvalidFee();
        if (_takerFeeBps > MAX_FEE_BPS || _takerFeeBps < -MAX_FEE_BPS) revert InvalidFee();
        if (int256(_makerFeeBps) + int256(_takerFeeBps) < 0) revert InvalidFee();
    }

    /// @dev Inclusive `[0, BPS]` bound for liquidation fee / share knobs (100% of notional).
    function _validateBPS(uint16 _bps) internal pure {
        if (_bps > BPS) revert ValueOutOfRange(0, int256(BPS));
    }

    // ── Dependency probes ─────────────────────────────────────────────────────
    //
    // `catch` only fires on a revert raised by the callee, so the code check ahead of it
    // is load-bearing: a call to an address holding no code succeeds with empty return
    // data and fails later in this contract's decoder, out of the catch block's reach.

    function _requireContract(address target) internal view {
        if (target.code.length == 0) revert InvalidDependency();
    }

    /// @dev Historical initializer arguments still include the vault even though the
    ///      dependency is immutable. Reject a proxy wired with deployment calldata for a
    ///      different implementation vault instead of silently accepting the mismatch.
    function _validateVault(ICollateralVault _vault) internal view {
        if (address(_vault) != address(vault)) revert VaultMismatch();
    }

    /// @dev Validate every read the venue relies on before adopting a portfolio margin
    ///      engine. The zero address is handled by callers because initializeV2 deliberately
    ///      permits it while the ongoing governance setter does not.
    function _setPortfolioMargin(IPortfolioMarginEngine _pm) internal {
        address pm = address(_pm);
        _requireContract(pm);

        try _pm.vault() returns (ICollateralVault pinned) {
            if (address(pinned) != address(vault)) revert VaultMismatch();
        } catch {
            revert InvalidDependency();
        }

        try _pm.linearOrderMargin(0) returns (uint256) { }
        catch {
            revert InvalidDependency();
        }

        try _pm.imSpotShock() returns (uint256) { }
        catch {
            revert InvalidDependency();
        }

        try _pm.mmSpotShock() returns (uint256) { }
        catch {
            revert InvalidDependency();
        }

        portfolioMargin = _pm;
        emit PortfolioMarginUpdated(pm);
    }

    // ── Internal helpers: points hook ─────────────────────────────────────────

    /// @dev Notify the points hook of a fill. Skipped when no hook is configured. The call is
    ///      intentionally not isolated: a reverting hook reverts the fill (unplug via setHook).
    ///      `_makerPrice` is the resting maker order's price; `_refPrice` is cached once per
    ///      taker order for the hook's price-improvement multiplier (0 when stale → no bonus).
    function _notifyFill(
        IPointsHook _hook,
        address _maker,
        address _taker,
        uint256 _notional,
        int256 _makerFee,
        int256 _takerFee,
        uint256 _makerPrice,
        uint256 _refPrice
    ) internal {
        if (address(_hook) == address(0)) return;
        uint256 takerFeeAbs = _takerFee > 0 ? uint256(_takerFee) : 0;
        _hook.onFill(_maker, _taker, _notional, _makerFee, takerFeeAbs, _makerPrice, _refPrice);
    }

    /// @dev True when a Chainlink-shaped round is usable for hard mark-price paths.
    function _isUsableOracleRound(int256 answer, uint256 updatedAt) internal view returns (bool) {
        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) return false;
        if (block.timestamp - updatedAt > MAX_ORACLE_STALENESS) return false;
        return true;
    }

    /// @dev Soft oracle → venue price. Returns 0 when the round is unusable (never reverts).
    ///      Used by points bonus and funding accrual so a stale feed cannot brick cancels.
    function _softMarketPrice() internal view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = priceOracle.latestRoundData();
        if (!_isUsableOracleRound(answer, updatedAt)) return 0;
        return _getMarketPrice(uint256(answer));
    }

    /// @dev Oracle reference price for the points price-improvement multiplier, in the same
    ///      units as an order's price. Unlike `getMarketPrice()`, this returns 0 instead of
    ///      reverting when the oracle is stale or non-positive, so a points-side read can never
    ///      block a fill — the hook simply applies no bonus (1x) when the reference is 0.
    function _refPriceForPoints() internal view returns (uint256) {
        return _softMarketPrice();
    }

    /// @dev Notify the points hook of a liquidation. Skipped when no hook is configured. Not
    ///      isolated: a reverting hook reverts the liquidation (unplug via setHook).
    function _notifyLiquidation(address _liquidator, uint256 _fee) internal {
        IPointsHook _hook = hook;
        if (address(_hook) == address(0)) return;
        _hook.onLiquidation(_liquidator, _fee);
    }

    // ── Internal helpers: collateral movement ─────────────────────────────────

    /// @dev Move collateral between two accounts via the vault.
    function _internalTransfer(address from, address to, uint256 amount) internal {
        vault.internalTransfer(from, to, amount);
    }

    /// @dev Shared reserve / fee ledger: vault `INSURANCE_FUND_ADDR` receipt account.
    function _insuranceFundAccount() internal view returns (address) {
        address fund = vault.INSURANCE_FUND_ADDR();
        if (fund == address(0)) revert InsuranceFundNotConfigured();
        return fund;
    }

    // ── Internal helpers: pricing ─────────────────────────────────────────────

    /// @dev Hard path for mark price / admin probes. Reverts `InvalidOracle` or
    ///      `OracleStale`; returns when the round is usable. Soft callers that must
    ///      not revert (points ref) check the same predicates and return 0 instead.
    function _validateOracleRound(int256 answer, uint256 updatedAt) internal view {
        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) revert InvalidOracle();
        if (block.timestamp - updatedAt > MAX_ORACLE_STALENESS) revert OracleStale();
    }

    /// @dev Raw oracle answer after hard validation (mirrors Futures `_getPrice`).
    function _getPrice() internal view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = priceOracle.latestRoundData();
        _validateOracleRound(answer, updatedAt);
        return uint256(answer);
    }

    /// @dev Scale a raw hashprice answer to venue price units and round to the tick
    ///      (mirrors Futures `_getMarketPrice`).
    function _getMarketPrice(uint256 _hashpriceUsd) internal view returns (uint256) {
        uint256 scaled = M.scaleDecimals(_hashpriceUsd, oracleDecimals, collateralDecimals);
        return M.roundToNearest(scaled, minimumPriceIncrement);
    }

    /// @dev Body of {getMarketPrice}: hard-validated oracle price in venue units.
    function _marketPrice() internal view returns (uint256) {
        return _getMarketPrice(_getPrice());
    }

    function _activePricesSlice(StructuredLinkedList.List storage priceList, uint256 _maxLevels)
        internal
        view
        returns (uint256[] memory)
    {
        uint256 total = priceList.sizeOf();
        uint256 count = M.min(total, _maxLevels);
        uint256[] memory out = new uint256[](count);
        (, uint256 current) = priceList.getNextNode(0);
        for (uint256 i = 0; i < count && current != 0; i++) {
            out[i] = current;
            (, current) = priceList.getNextNode(current);
        }
        return out;
    }

    // ── Internal helpers: order placement / matching ──────────────────────────

    /// @dev Mint the next order id. Keeps `nonce` private to this layer.
    function _nextOrderId() internal returns (bytes32) {
        return bytes32(++nonce);
    }

    /// @dev Absolute qty of resting orders that reduce `_net`.
    function _restingReduceAbs(address _user, int256 _net) internal view returns (uint256 total) {
        if (_net == 0) return 0;
        OrderAggregate storage aggregate = userOrderAggregate[_user];
        return _net > 0 ? aggregate.sellQty : aggregate.buyQty;
    }

    /// @notice Match incoming order with opposite orders using limit price logic (direct walk).
    /// @param _taker Address of the taker (funding already settled before the matching loop)
    function _matchWithOppositeOrders(address _taker, uint256 _limitPrice, int256 _quantity)
        internal
        returns (int256 remainingQuantity)
    {
        remainingQuantity = _quantity;
        bool _isBuy = _quantity > 0;
        StructuredLinkedList.List storage oppositePrices = _isBuy ? activeAskPrices : activeBidPrices;

        if (oppositePrices.sizeOf() == 0) return remainingQuantity;

        (, uint256 currentPrice) = oppositePrices.getNextNode(0);
        if ((_isBuy && currentPrice > _limitPrice) || (!_isBuy && currentPrice < _limitPrice)) {
            return remainingQuantity;
        }
        IPointsHook pointsHook = hook;
        uint256 refPrice = address(pointsHook) == address(0) ? 0 : _refPriceForPoints();

        while (currentPrice != 0 && remainingQuantity != 0) {
            if (_isBuy && currentPrice > _limitPrice) break;
            if (!_isBuy && currentPrice < _limitPrice) break;

            (, uint256 nextPrice) = oppositePrices.getNextNode(currentPrice);
            remainingQuantity =
                _matchOrdersAtPrice(_taker, currentPrice, remainingQuantity, _isBuy, pointsHook, refPrice);
            currentPrice = nextPrice;
        }

        return remainingQuantity;
    }

    /// @notice Match orders at a specific price level (direct walk).
    /// @dev Self-cross (maker == taker) nets out size with no trade, fees, or
    ///      position update — same STP semantics as Futures.
    function _matchOrdersAtPrice(
        address _taker,
        uint256 _price,
        int256 _remainingQty,
        bool _isBuy,
        IPointsHook _pointsHook,
        uint256 _refPrice
    )
        internal
        returns (int256)
    {
        StructuredLinkedList.List storage makerOrderQueue = _priceOrderIds(_price, !_isBuy);

        (, uint256 orderIdUint) = makerOrderQueue.getNextNode(0);
        while (_remainingQty != 0 && orderIdUint != 0) {
            bytes32 makerOrderId = bytes32(orderIdUint);
            Order storage makerOrder = orders[makerOrderId];

            if (makerOrder.participant == _taker) {
                _remainingQty = _netSelfCross(_taker, makerOrderId, makerOrder, _remainingQty);
                (, orderIdUint) = makerOrderQueue.getNextNode(0);
                continue;
            }

            _remainingQty = _executeMatch(_taker, makerOrderId, makerOrder, _remainingQty, _pointsHook, _refPrice);
            (, orderIdUint) = makerOrderQueue.getNextNode(0);
        }

        // Remove price level once after finishing this level, instead of after every filled order.
        _removePriceLevelIfEmpty(makerOrderQueue, _price, !_isBuy);

        return _remainingQty;
    }

    /// @dev Cancel overlapping size against the taker's own resting order.
    ///      No fill, no fees, no position change.
    function _netSelfCross(address _taker, bytes32 _makerOrderId, Order storage _makerOrder, int256 _remainingQty)
        internal
        returns (int256)
    {
        uint256 makerPrice = _makerOrder.price;
        int256 makerQty = _makerOrder.quantity;
        uint256 makerAbs = M.abs(makerQty);
        uint256 remainingAbs = M.abs(_remainingQty);
        uint256 cancelAmt = makerAbs < remainingAbs ? makerAbs : remainingAbs;

        if (cancelAmt == makerAbs) {
            _removeRestingOrder(_makerOrderId, _taker, makerPrice, makerQty);
            emit OrderCancelled(_makerOrderId, _taker);
        } else {
            uint256 reducedMakerAbs = makerAbs - cancelAmt;
            int256 newMakerQty = M.toSigned(makerQty > 0, reducedMakerAbs);
            _reduceRestingOrder(_makerOrderId, _makerOrder, newMakerQty);
        }

        return _remainingQty > 0 ? int256(remainingAbs - cancelAmt) : -int256(remainingAbs - cancelAmt);
    }

    /// @notice Execute a single order match
    function _executeMatch(
        address _taker,
        bytes32 _makerOrderId,
        Order storage _makerOrder,
        int256 _remainingQty,
        IPointsHook _pointsHook,
        uint256 _refPrice
    )
        internal
        returns (int256)
    {
        // Cache fields from storage once to avoid repeated SLOADs.
        uint256 makerPrice = _makerOrder.price;
        address makerParticipant = _makerOrder.participant;
        int256 makerQty = _makerOrder.quantity;
        uint256 matchAmt = M.min(M.abs(makerQty), M.abs(_remainingQty));
        int256 takerQty = _toSignedQuantity(matchAmt, _remainingQty);
        uint256 notionalValue = _calculateValue(makerPrice, matchAmt);

        // The backstop is unfunded by design: a taker fee would only be booked as BadDebt.
        int256 takerFee = _taker == BACKSTOP ? int256(0) : int256(notionalValue) * int256(takerFeeBps) / int256(BPS);
        int256 makerFee = int256(notionalValue) * int256(makerFeeBps) / int256(BPS);

        _createPosition(makerParticipant, _taker, makerPrice, takerQty);

        // Collect the positive side first so a same-match rebate can use revenue
        // earned by that match instead of depending on a pre-funded fee pot.
        // Fee shortfalls, if any, are recorded by the vault here, before OrderUpdated /
        // OrderMatched — same log order as Futures.
        if (makerFee < 0) {
            _transferFee(_taker, takerFee);
            _transferFee(makerParticipant, makerFee);
        } else {
            _transferFee(makerParticipant, makerFee);
            _transferFee(_taker, takerFee);
        }

        _notifyFill(_pointsHook, makerParticipant, _taker, notionalValue, makerFee, takerFee, makerPrice, _refPrice);

        int256 newMakerQty = _reduceQuantity(makerQty, matchAmt);
        if (newMakerQty == 0) {
            _removeRestingOrder(_makerOrderId, makerParticipant, makerPrice, makerQty);
            emit OrderUpdated(_makerOrderId, makerParticipant, 0);
        } else {
            _reduceRestingOrder(_makerOrderId, _makerOrder, newMakerQty);
        }

        Position storage makerPos = positions[makerParticipant];
        Position storage takerPos = positions[_taker];
        _emitOrderMatched(
            _makerOrderId,
            makerParticipant,
            _taker,
            makerPrice,
            takerQty,
            makerFee,
            takerFee,
            makerPos.netQuantity,
            takerPos.netQuantity,
            _averageEntryPrice(makerPos),
            _averageEntryPrice(takerPos)
        );

        unchecked {
            return _remainingQty - takerQty;
        }
    }

    /// @notice Calculate value (price * quantity / decimals)
    function _calculateValue(uint256 _price, uint256 _absQuantity) internal pure returns (uint256) {
        return (_price * _absQuantity) / (10 ** QUANTITY_DECIMALS);
    }

    /// @notice Convert absolute quantity to signed based on reference sign
    function _toSignedQuantity(uint256 _absQuantity, int256 _referenceSign) internal pure returns (int256) {
        return M.toSigned(_referenceSign > 0, _absQuantity);
    }

    /// @notice Reduce absolute value of signed quantity
    function _reduceQuantity(int256 _quantity, uint256 _reduction) internal pure returns (int256) {
        return _quantity - M.toSigned(_quantity > 0, _reduction);
    }

    // ── Internal helpers: cancel / reduce / book upkeep ───────────────────────

    /// @dev Add one canonical remaining order to the aggregate.
    function _addOrderAggregate(address _user, bool _isBuy, uint256 _price, uint256 _absQty) internal {
        OrderAggregate storage aggregate = userOrderAggregate[_user];
        uint256 value = _calculateValue(_price, _absQty);
        if (_isBuy) {
            aggregate.buyQty += _absQty;
            aggregate.buyValue += value;
        } else {
            aggregate.sellQty += _absQty;
            aggregate.sellValue += value;
        }
    }

    /// @dev Replace an order's old remaining quantity with a smaller canonical remainder.
    ///      Subtracting `value(old) - value(new)` keeps the cache exactly equal to a full
    ///      scan while leaving fill notional and fee rounding unchanged.
    function _subtractOrderAggregate(address _user, bool _isBuy, uint256 _price, uint256 _oldAbsQty, uint256 _newAbsQty)
        internal
    {
        OrderAggregate storage aggregate = userOrderAggregate[_user];
        uint256 qtyReduction = _oldAbsQty - _newAbsQty;
        uint256 valueReduction = _calculateValue(_price, _oldAbsQty) - _calculateValue(_price, _newAbsQty);
        if (_isBuy) {
            aggregate.buyQty -= qtyReduction;
            aggregate.buyValue -= valueReduction;
        } else {
            aggregate.sellQty -= qtyReduction;
            aggregate.sellValue -= valueReduction;
        }
    }

    /// @dev Replace all four fields from canonical remaining orders. This also removes any
    ///      historical value dust accumulated by the deprecated incremental mappings.
    function _rebuildOrderAggregateCache(address _user) internal {
        OrderAggregate memory aggregate;
        EnumerableSet.Bytes32Set storage ids = participantOrderIdsIndex[_user];
        uint256 len = ids.length();
        for (uint256 i = 0; i < len; i++) {
            Order storage order = orders[ids.at(i)];
            int256 quantity = order.quantity;
            if (quantity > 0) {
                uint256 absQty = uint256(quantity);
                aggregate.buyQty += absQty;
                aggregate.buyValue += _calculateValue(order.price, absQty);
            } else if (quantity < 0) {
                uint256 absQty = M.abs(quantity);
                aggregate.sellQty += absQty;
                aggregate.sellValue += _calculateValue(order.price, absQty);
            }
        }
        userOrderAggregate[_user] = aggregate;
    }

    /// @dev Remove one canonical resting order from every per-order accounting structure.
    ///      Price-ladder cleanup stays with the caller because matching and reset walk a whole
    ///      level and deliberately remove that level only after its queue traversal finishes.
    ///      Callers emit `OrderUpdated` / `OrderCancelled` themselves (matches Futures).
    function _removeRestingOrder(bytes32 _orderId, address _participant, uint256 _price, int256 _quantity)
        internal
    {
        bool isBid = _quantity > 0;
        _subtractOrderAggregate(_participant, isBid, _price, M.abs(_quantity), 0);
        _priceOrderIds(_price, isBid).remove(uint256(_orderId));
        participantOrderIdsIndex[_participant].remove(_orderId);
        delete orders[_orderId];
    }

    /// @dev Unindex a resting order, drop its price level if that empties it, and announce it
    ///      cancelled. Callers own the authorization decision; this only performs the removal.
    function _dropRestingOrder(bytes32 _orderId, Order memory _order) internal {
        bool isBid = _order.quantity > 0;
        _removeRestingOrder(_orderId, _order.participant, _order.price, _order.quantity);
        _removePriceLevelIfEmpty(_priceOrderIds(_order.price, isBid), _order.price, isBid);
        emit OrderCancelled(_orderId, _order.participant);
    }

    /// @dev Shrink one canonical resting order in place, preserving its queue/FIFO position.
    function _reduceRestingOrder(bytes32 _orderId, Order storage _order, int256 _newQuantity) internal {
        int256 oldQuantity = _order.quantity;
        address participant = _order.participant;
        _subtractOrderAggregate(
            participant, oldQuantity > 0, _order.price, M.abs(oldQuantity), M.abs(_newQuantity)
        );
        _order.quantity = _newQuantity;
        emit OrderUpdated(_orderId, participant, _newQuantity);
    }

    // ── Internal helpers: position accounting ─────────────────────────────────

    /// @notice Update net positions when orders match
    /// @param taker Address of the taker whose funding was already settled before the matching loop
    /// @dev Settles maker then taker so insurance-fund shortfall allocation is role-deterministic
    ///      (matches Futures). `OrderMatched` is emitted by {_executeMatch} after fees/updates.
    ///      A trader taker must pay its realized loss in full: the fill price is the taker's
    ///      choice, so an unpaid remainder would let a colluding maker collect it from the fund.
    ///      The maker and the backstop keep the bad-debt path; a maker that could not pay would
    ///      otherwise block every taker at its level.
    function _createPosition(address makerParticipant, address taker, uint256 _price, int256 _takerQty)
        internal
    {
        // Maker takes the opposite of the taker fill. Skip taker funding — settled once pre-loop.
        if (makerParticipant != taker) _settleFunding(makerParticipant);
        _updateUserPosition(makerParticipant, -_takerQty, _price, false);
        _updateUserPosition(taker, _takerQty, _price, taker != BACKSTOP);
    }

    function _emitOrderMatched(
        bytes32 matchedOrderId,
        address maker,
        address taker,
        uint256 price,
        int256 takerQty,
        int256 makerFee,
        int256 takerFee,
        int256 makerNetQty,
        int256 takerNetQty,
        uint256 makerEntry,
        uint256 takerEntry
    ) internal {
        emit OrderMatched(
            matchedOrderId,
            maker,
            taker,
            price,
            takerQty,
            makerFee,
            takerFee,
            makerNetQty,
            takerNetQty,
            makerEntry,
            takerEntry
        );
    }

    function _averageEntryPrice(Position memory _position) internal pure returns (uint256) {
        if (_position.netQuantity == 0) return 0;
        return (M.abs(_position.netEntryValue) * (10 ** QUANTITY_DECIMALS)) / M.abs(_position.netQuantity);
    }

    function _signedValue(uint256 _price, int256 _quantity) internal pure returns (int256) {
        return (_quantity * int256(_price)) / int256(10 ** QUANTITY_DECIMALS);
    }

    /// @notice Update a user's net position with exact signed entry value
    /// @param _mustPay Revert instead of recording bad debt when the user cannot pay a realized loss
    function _updateUserPosition(address _user, int256 _quantity, uint256 _tradePrice, bool _mustPay) internal {
        Position storage position = positions[_user];
        int256 entryValue = position.netEntryValue;
        int256 tradeValue = _signedValue(_tradePrice, _quantity);

        // If no existing position, initialize it
        if (position.netQuantity == 0) {
            position.netQuantity = _quantity;
            position.netEntryValue = tradeValue;
            userFundingSnapshot[_user] = cumulativeFundingPerUnit;
            return;
        }

        // Same direction - add exact signed entry values.
        if (M.isSameSign(position.netQuantity, _quantity)) {
            position.netQuantity += _quantity;
            position.netEntryValue = entryValue + tradeValue;
            return;
        }

        // Opposite direction: settle the reduced part, then open remainder (if any)
        _settleOpposite(_user, _quantity, _tradePrice, entryValue, _mustPay);
    }

    /// @notice Handle opposite-direction trade (partial/full close or flip)
    function _settleOpposite(address _user, int256 _quantity, uint256 _tradePrice, int256 _entryValue, bool _mustPay)
        internal
    {
        Position storage position = positions[_user];
        uint256 absQuantity = M.abs(_quantity);
        uint256 oldAbsQuantity = M.abs(position.netQuantity);
        uint256 settledAbs = absQuantity < oldAbsQuantity ? absQuantity : oldAbsQuantity;
        int256 signedSettled = _toSignedQuantity(settledAbs, position.netQuantity);
        int256 remainingEntryValue;
        if (settledAbs < oldAbsQuantity) {
            remainingEntryValue =
                (_entryValue * int256(oldAbsQuantity - settledAbs)) / int256(oldAbsQuantity);
        }
        _settleReducedPosition(_user, _tradePrice, signedSettled, _entryValue - remainingEntryValue, _mustPay);

        if (absQuantity > oldAbsQuantity) {
            // Flip: close old position and open opposite
            int256 openQty = _toSignedQuantity(absQuantity - oldAbsQuantity, _quantity);
            position.netQuantity = openQty;
            position.netEntryValue = _signedValue(_tradePrice, openQty);
            userFundingSnapshot[_user] = cumulativeFundingPerUnit;
        } else if (position.netQuantity + _quantity == 0) {
            position.netQuantity = 0;
            position.netEntryValue = 0;
        } else {
            position.netQuantity += _quantity;
            position.netEntryValue = remainingEntryValue;
        }
    }

    // ── Internal helpers: margin / liquidation ────────────────────────────────

    /// @dev The backstop inherits the liquidated quantity (same sign as the user's position) so
    ///      positions keep summing to zero: the user's counterparties are untouched and the
    ///      backstop now faces them. Funding is settled first so the inherited size accrues from
    ///      now. An opposite backstop leg nets and realizes against the fund; what the backstop
    ///      cannot pay is recorded as `BadDebt` by the vault. No margin check: the backstop is a
    ///      ledger for protocol exposure, not a margined trader.
    function _handOffToBackstop(address _user, int256 _signedClose, uint256 _mark) internal {
        _settleFunding(BACKSTOP);
        _updateUserPosition(BACKSTOP, _signedClose, _mark, false);
        emit BackstopAssigned(_user, _signedClose, _mark);
    }

    /// @dev Limit price `_bps` away from `_mark` on the taker's side, rounded to the tick toward
    ///      the mark so the result is always inside the band and always tick-aligned.
    function _bandPrice(uint256 _mark, bool _isBuy, uint16 _bps) internal pure returns (uint256) {
        uint256 offset = _mark * _bps / BPS;
        uint256 raw = _isBuy ? _mark + offset : _mark - offset + minimumPriceIncrement - 1;
        return raw / minimumPriceIncrement * minimumPriceIncrement;
    }

    /// @dev Closes `_closeAbs` (< |netQuantity|) of a verified-underwater user's position at the
    ///      mark, realizes PnL on the closed slice via {_settleReducedPosition}, and scales
    ///      the exact entry value with `netQuantity`. Does NOT pay the fee and does NOT
    ///      emit — the caller applies the incentive gate and emits `PositionLiquidated`.
    ///      Returns the realized `pnl` on the closed slice and the SIGNED closed quantity (same
    ///      sign as the position). Callers MUST have already checked the underwater / orders-clear
    ///      / partial invariants.
    function _doPartialLiquidatePosition(
        address _user,
        Position memory _position,
        uint256 _closeAbs,
        uint256 _currentPrice
    )
        internal
        returns (int256 pnl, int256 signedClose)
    {
        bool isLong = _position.netQuantity > 0;
        signedClose = M.toSigned(isLong, _closeAbs);
        int256 entryValue = _position.netEntryValue;
        uint256 absNet = M.abs(_position.netQuantity);
        int256 remainingEntryValue = (entryValue * int256(absNet - _closeAbs)) / int256(absNet);

        pnl = _settleReducedPosition(_user, _currentPrice, signedClose, entryValue - remainingEntryValue, false);

        // signedClose has the position's sign, so subtracting it moves netQuantity toward zero.
        Position storage position = positions[_user];
        position.netQuantity = _position.netQuantity - signedClose;
        position.netEntryValue = remainingEntryValue;
    }

    /// @dev Closes the user's position and settles PnL against the insurance fund. Caller must
    ///      have verified all predicates. Charges a liquidation fee on the closed notional
    ///      (computed as `currentPrice * |closedQuantity| / 10^QUANTITY_DECIMALS`).
    ///      Does NOT emit — caller runs the over-liquidation guard, then emits/notifies.
    function _doLiquidatePosition(address _user, uint256 _currentPrice)
        internal
        returns (int256 pnl, int256 closedQuantity, uint256 liqFee)
    {
        Position memory position = positions[_user];
        int256 entryValue = position.netEntryValue;
        closedQuantity = position.netQuantity;
        pnl = _signedValue(_currentPrice, closedQuantity) - entryValue;

        _transferPnl(_insuranceFundAccount(), _user, pnl);

        uint256 closedNotional = _calculateValue(_currentPrice, M.abs(closedQuantity));
        liqFee = _chargeLiquidationFee(_user, closedNotional);

        delete positions[_user];
    }

    /// @notice Settle a reduced portion of a position (when offsetting)
    /// @param _user User address
    /// @param _price Execution/mark price in collateral units
    /// @param _quantity Quantity being closed (positive = long, negative = short)
    /// @param _entryValue Signed entry value allocated to the closed quantity
    /// @param _mustPay Revert instead of recording bad debt when the user cannot pay the loss
    /// @return pnl The PnL realized from reducing this position
    function _settleReducedPosition(address _user, uint256 _price, int256 _quantity, int256 _entryValue, bool _mustPay)
        internal
        returns (int256 pnl)
    {
        pnl = _signedValue(_price, _quantity) - _entryValue;
        if (!_transferPnl(_insuranceFundAccount(), _user, pnl) && _mustPay) revert InsufficientMarginBalance();
    }

    /// @dev Settle signed PnL from `_from` to `_to` without blocking position reduction.
    ///      A trader who cannot pay is recorded as bad debt by the vault. The insurance
    ///      fund pays a winner in full, borrowing whatever its balance does not cover.
    ///      Callers pass `(insuranceFund, user, pnl)` so positive PnL credits the user.
    /// @return paidInFull False when the vault recorded part of the amount as bad debt
    function _transferPnl(address _from, address _to, int256 _pnl) internal returns (bool paidInFull) {
        if (_pnl == 0) return true;
        address payer;
        address receiver;
        uint256 amount;
        if (_pnl > 0) {
            payer = _from;
            receiver = _to;
            amount = uint256(_pnl);
        } else {
            payer = _to;
            receiver = _from;
            amount = uint256(-_pnl);
        }

        return vault.settleTransfer(payer, receiver, amount) == amount;
    }

    /// @dev New orders are the only way a fill starts, so rejecting them stops new exposure.
    function _requireTradingOpen() internal view {
        if (vault.halted()) revert TradingHalted();
    }

    /// @notice Charge a liquidation fee on the closed notional value, split between
    ///         liquidator (msg.sender) and venue revenue according to `liquidatorShareBps`.
    /// @dev Fee is `_notionalValue * liquidationFeeBps / 10000`, capped at the user's
    ///      actual vault balance. The liquidator receives `fee * liquidatorShareBps / 10000`
    ///      (also capped at available balance), and the remainder becomes venue revenue.
    /// @param _user The liquidated user (fee source)
    /// @param _notionalValue Notional value of the liquidated position/order
    /// @return totalFee Total fee actually collected (may be less than computed if balance insufficient)
    function _chargeLiquidationFee(address _user, uint256 _notionalValue) internal returns (uint256 totalFee) {
        uint16 feeBps = liquidationFeeBps;
        if (feeBps == 0) return 0;

        uint256 computedFee = _notionalValue * uint256(feeBps) / BPS;
        if (computedFee == 0) return 0;

        uint256 userBal = _vaultBalance(_user);
        totalFee = M.min(computedFee, userBal);
        if (totalFee == 0) return 0;

        address liquidator = _msgSender();
        uint16 liqShareBps = liquidatorShareBps;
        uint256 liquidatorShare = totalFee * uint256(liqShareBps) / BPS;
        uint256 exchangeShare = totalFee - liquidatorShare;

        if (liquidatorShare != 0) _internalTransfer(_user, liquidator, liquidatorShare);
        if (exchangeShare != 0) {
            _internalTransfer(_user, address(this), exchangeShare);
        }
    }

    /// @notice Calculate PnL for a position at a given price
    /// @param _position The position to calculate PnL for
    /// @param _currentPrice The current market price
    /// @return pnl The unrealized PnL (positive = profit, negative = loss)
    function _calculatePositionPnl(Position memory _position, uint256 _currentPrice) internal pure returns (int256) {
        if (_position.netQuantity == 0) return 0;
        return _signedValue(_currentPrice, _position.netQuantity) - _position.netEntryValue;
    }

    /// @notice Ensure the account is not short of portfolio IM. A reducing single order may
    ///         finish below IM within the limits the engine's `reduceLimits` returned before
    ///         it; strict callers pass zero for both.
    function _ensureNoCollateralDeficit(address _user, uint256 _maxAllowedIm, uint256 _maxAllowedMmDeficit)
        internal
        view
    {
        if (!portfolioMargin.meetsTradeMargin(_user, _maxAllowedIm, _maxAllowedMmDeficit)) {
            revert InsufficientMarginBalance();
        }
    }

    /// @dev Every vault balance read goes through here: each external call site costs runtime
    ///      bytecode, and this contract sits near the EIP-170 limit.
    function _vaultBalance(address _account) internal view returns (uint256) {
        return vault.balanceOf(_account);
    }

    // ── Internal helpers: validation / book lookups ───────────────────────────

    function _validateTIF(TimeInForce _tif) internal pure {
        if (uint8(_tif) > uint8(TimeInForce.FOK)) revert InvalidTimeInForce();
    }

    function _validateOrderIntent(uint256 _price, int256 _quantity, TimeInForce _tif) internal pure {
        _validateTIF(_tif);
        _validatePrice(_price);
        _validateQty(_quantity);
    }

    function _isLocallyReducing(address _participant, int256 _quantity) internal view returns (bool) {
        int256 position = positions[_participant].netQuantity;
        if (position == 0 || (position > 0 ? _quantity >= 0 : _quantity <= 0)) return false;
        return M.abs(_quantity) + _restingReduceAbs(_participant, position) <= M.abs(position);
    }

    function _validateQty(int256 _quantity) internal pure {
        if (_quantity == 0) revert InvalidQty();
    }

    function _validatePrice(uint256 _price) internal pure {
        if (_price == 0) revert InvalidPrice();
        if (_price % minimumPriceIncrement != 0) revert InvalidPrice();
    }

    /// @notice Get order queue by price and direction
    function _priceOrderIds(uint256 _price, bool _isBuy) internal view returns (StructuredLinkedList.List storage) {
        if (_isBuy) {
            return priceOrdersLongQueue[_price];
        } else {
            return priceOrdersShortQueue[_price];
        }
    }

    /// @notice Add a new price level to the sorted price list.
    function _addPriceLevel(uint256 _price, bool _isBid) internal {
        StructuredLinkedList.List storage priceList = _isBid ? activeBidPrices : activeAskPrices;
        PriceLadderLib.insertNewPrice(priceList, _price, _isBid, MAX_PRICE_LEVELS_PER_SIDE);
    }

    /// @notice Remove a price level from the sorted price list if order queue is empty
    function _removePriceLevelIfEmpty(StructuredLinkedList.List storage orderQueue, uint256 _price, bool _isBid)
        internal
    {
        StructuredLinkedList.List storage priceList = _isBid ? activeBidPrices : activeAskPrices;
        PriceLadderLib.removeIfEmpty(orderQueue, priceList, _price);
    }

    /// @dev Best (highest) bid, or 0 if empty.
    function _bestBidPrice() internal view returns (uint256) {
        if (activeBidPrices.sizeOf() == 0) return 0;
        (, uint256 bestBid) = activeBidPrices.getNextNode(0);
        return bestBid;
    }

    /// @dev Best (lowest) ask, or 0 if empty.
    function _bestAskPrice() internal view returns (uint256) {
        if (activeAskPrices.sizeOf() == 0) return 0;
        (, uint256 bestAsk) = activeAskPrices.getNextNode(0);
        return bestAsk;
    }

    /// @notice Fee pot size: the venue's vault balance (match + liquidation exchange share).
    function collectedFeesBalance() public view returns (uint256) {
        return _vaultBalance(address(this));
    }

    /// @dev Move a signed trading fee between a participant and the fee pot
    ///      (this contract's vault account — see {collectedFeesBalance}).
    ///      A rebate is capped at the pot. `makerFeeBps + takerFeeBps >= 0` keeps one match
    ///      from being a net outflow, and the cap keeps a run of rebates from overdrawing it.
    function _transferFee(address _participant, int256 _fee) internal {
        if (_fee == 0) return;

        if (_fee > 0) {
            vault.settleTransfer(_participant, address(this), uint256(_fee));
            return;
        }

        uint256 rebate = M.min(uint256(-_fee), _vaultBalance(address(this)));
        if (rebate > 0) {
            _internalTransfer(address(this), _participant, rebate);
        }
    }

    // ── Internal helpers: funding ─────────────────────────────────────────────

    /// @notice Compute the current cumulative funding per unit without writing state
    /// @dev Uses the order-book mid-price as mark price and the oracle as index price.
    ///      If either side of the book is empty, no additional funding accrues.
    /// @dev Reuses `_indexPrice` when already loaded by a caller; zero loads it lazily.
    /// @return currentCumFunding The theoretical cumulative funding as of block.timestamp
    function _getCurrentCumulativeFunding(uint256 _indexPrice) internal view returns (int256 currentCumFunding) {
        currentCumFunding = cumulativeFundingPerUnit;

        if (lastFundingUpdateTime == 0 || fundingPeriod == 0) return currentCumFunding;

        uint256 timeElapsed = block.timestamp - lastFundingUpdateTime;
        if (timeElapsed == 0) return currentCumFunding;

        // Mark price = order-book mid-price
        uint256 bestBid = _bestBidPrice();
        uint256 bestAsk = _bestAskPrice();
        if (bestBid == 0 || bestAsk == 0) return currentCumFunding;

        uint256 markPrice = (bestBid + bestAsk) / 2;
        // Soft-load index when the caller did not supply one. A stale/unusable oracle must
        // not revert funding views or cancel/reduce paths — skip accrual instead.
        uint256 indexPrice = _indexPrice == 0 ? _softMarketPrice() : _indexPrice;
        if (indexPrice == 0) return currentCumFunding;

        // fundingRate (scaled by 10^FUNDING_DECIMALS) = (mark - index) * 10^FUNDING_DECIMALS / index
        int256 priceDiff = int256(markPrice) - int256(indexPrice);
        int256 fundingRateScaled = (priceDiff * int256(10 ** FUNDING_DECIMALS)) / int256(indexPrice);

        // Clamp to [-maxRate, maxRate]
        int256 maxRateScaled = (int256(fundingRateMaxBps) * int256(10 ** FUNDING_DECIMALS)) / int256(BPS);
        if (fundingRateScaled > maxRateScaled) fundingRateScaled = maxRateScaled;
        if (fundingRateScaled < -maxRateScaled) fundingRateScaled = -maxRateScaled;

        // deltaCumFunding (tokenDecimals * 10^FUNDING_DECIMALS) =
        //   fundingRateScaled * indexPrice * timeElapsed / fundingPeriod
        int256 deltaCumFunding = (fundingRateScaled * int256(indexPrice) * int256(timeElapsed)) / int256(fundingPeriod);

        currentCumFunding += deltaCumFunding;
    }

    /// @notice Update the global cumulative funding rate (writes state)
    /// @dev Called before position-affecting ops and cancel/reduce paths. When the book is
    ///      two-sided but the oracle round is unusable, skip entirely (do not advance
    ///      `lastFundingUpdateTime`) so a later live update can catch up the elapsed window.
    function _updateGlobalFunding() internal {
        if (lastFundingUpdateTime == 0 || fundingPeriod == 0) return;

        // Accrual needs a mid and an index. Empty book → no accrual but still bump the
        // timestamp (existing policy). Unusable oracle → abort without bumping so cancels
        // stay ungated and funding is not permanently dropped for the stale window.
        uint256 bestBid = _bestBidPrice();
        uint256 bestAsk = _bestAskPrice();
        uint256 indexPrice;
        if (bestBid != 0 && bestAsk != 0) {
            indexPrice = _softMarketPrice();
            if (indexPrice == 0) return;
        }

        int256 newCumFunding = _getCurrentCumulativeFunding(indexPrice);

        if (newCumFunding != cumulativeFundingPerUnit) {
            // Derive the effective rate for the event
            int256 delta = newCumFunding - cumulativeFundingPerUnit;
            cumulativeFundingPerUnit = newCumFunding;
            emit FundingUpdated(delta, newCumFunding, block.timestamp);
        }

        lastFundingUpdateTime = block.timestamp;
    }

    /// @notice Settle pending funding for a user against the reserve pool
    /// @dev Must be called before any position change so funding is settled at the old size.
    /// @param _user The user whose funding is being settled
    function _settleFunding(address _user) internal {
        // When funding isn't configured, skip storage reads and calculations.
        if (lastFundingUpdateTime == 0 || fundingPeriod == 0) return;

        Position storage position = positions[_user];
        if (position.netQuantity == 0) {
            // No position – just sync snapshot so a new position starts clean
            userFundingSnapshot[_user] = cumulativeFundingPerUnit;
            return;
        }

        int256 delta = cumulativeFundingPerUnit - userFundingSnapshot[_user];
        if (delta == 0) return;

        // pendingFunding (in tokenDecimals) =
        //   netQuantity * delta / (10^QUANTITY_DECIMALS * 10^FUNDING_DECIMALS)
        // Positive = user owes, Negative = user receives
        int256 pendingFunding =
            (position.netQuantity * delta) / (int256(10 ** QUANTITY_DECIMALS) * int256(10 ** FUNDING_DECIMALS));

        userFundingSnapshot[_user] = cumulativeFundingPerUnit;

        if (pendingFunding == 0) return;

        if (pendingFunding > 0) {
            vault.settleTransfer(_user, _insuranceFundAccount(), uint256(pendingFunding));
        } else {
            vault.settleTransfer(_insuranceFundAccount(), _user, uint256(-pendingFunding));
        }

        emit FundingSettled(_user, pendingFunding);
    }

    /// @dev Body of {getPendingFunding}: pending (unsettled) funding for a user.
    ///      Positive = user owes, negative = user receives (in collateral token units).
    /// @dev Reuses `_indexPrice` when already loaded by a caller; zero loads it lazily.
    function _pendingFunding(address _user, uint256 _indexPrice) internal view returns (int256) {
        Position memory position = positions[_user];
        if (position.netQuantity == 0) return 0;

        int256 currentCumFunding = _getCurrentCumulativeFunding(_indexPrice);
        int256 delta = currentCumFunding - userFundingSnapshot[_user];
        if (delta == 0) return 0;

        return (position.netQuantity * delta) / (int256(10 ** QUANTITY_DECIMALS) * int256(10 ** FUNDING_DECIMALS));
    }

}
