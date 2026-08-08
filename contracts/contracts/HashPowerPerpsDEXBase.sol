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
    uint256 private constant MAX_ORACLE_STALENESS = 3600; // 1 hour
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
    uint8 internal immutable collateralDecimals;

    // State variables
    address private __gap0;
    AggregatorV3Interface public priceOracle;
    /// @dev Dead — former marginPercent. Margin is now delegated to PortfolioMarginEngine.
    uint8 private __gap1;
    /// @dev Dead — former maintenanceMarginPercent. Margin is now delegated to PortfolioMarginEngine.
    uint8 private __gap2;
    /// @dev Dead — former liquidationFee (flat). Now bps-based via liquidationFeeBps.
    uint256 private __gap3;
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
    EnumerableSet.AddressSet internal usersWithPositions; // Users with active positions

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
    uint256 public minimumMarginPerOrder; // Minimum margin (collateral) locked per resting order (0 = no minimum)
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
    ///         The remainder goes to the insurance fund.
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
        uint256 aggregatedEntryPrice; // Weighted average entry price
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
    event MatchFeeUpdated(int16 newTakerFeeBps, int16 newMakerFeeBps);
    event MakerFeeBpsUpdated(int16 newMakerFeeBps);
    event TakerFeeBpsUpdated(int16 newTakerFeeBps);
    event LiquidationFeeBpsUpdated(uint16 newLiquidationFeeBps);
    event LiquidatorShareBpsUpdated(uint16 newLiquidatorShareBps);
    event OracleUpdated(address newOracle);
    event PortfolioMarginUpdated(address newPortfolioMargin);
    event PositionLiquidated(
        address indexed user, address indexed liquidator, int256 positionSize, int256 pnl, uint256 liquidatorFee
    );
    /// @notice Emitted when a resting order is force-cancelled by a permissionless liquidator.
    /// @dev `OrderCancelled` is also emitted from the same path so order-lifecycle indexers
    ///      keep working unchanged.
    event OrderLiquidated(bytes32 indexed orderId, address indexed user, address indexed liquidator, uint256 fee);
    event BadDebt(address indexed user, uint256 amount); // The user does not have enough collateral to cover the loss
    event FundingUpdated(int256 fundingRate, int256 cumulativeFundingPerUnit, uint256 timestamp);
    event FundingSettled(address indexed user, int256 amount);
    event FundingParametersUpdated(uint256 maxBps, uint256 period);
    event MinimumMarginPerOrderUpdated(uint256 newMinimumMarginPerOrder);
    /// @notice Emitted whenever the points hook address changes.
    event HookUpdated(address indexed hook);

    // Errors
    error InvalidPrice();
    error InvalidSize();
    error InsufficientMargin(); // The margin % is not sufficient to cover the position
    error InsufficientCollateral(); // The user wants to remove more collateral than they have
    error OracleStale();
    error InvalidOracle();
    error InvalidMarginPercent();
    error OrderNotBelongToSender();
    error MaxOrdersPerParticipantReached();
    error NotLiquidatable();
    error OrdersStillOpen(); // liquidatePosition called while user has open orders
    /// @notice Partial liquidation left balance above IM while a real IM>MM buffer remains.
    error OverLiquidation();
    error OrderNotBelongToUser(); // liquidateOrder called with an id not owned by the specified user
    error InsufficientReservePool(); // The reserve pool does not have enough collateral to cover user profit
    error InvalidFundingParameters();
    /// @notice Fee magnitude above `MAX_FEE_BPS`, or a maker+taker sum below zero (which
    ///         would make every match a net outflow from the insurance fund).
    error InvalidFee();
    error OrderMarginTooLow(); // Order margin is below minimumMarginPerOrder
    error MaxPriceLevelsReached(); // Too many active price levels on one side of the book
    error InsuranceFundNotConfigured(); // CollateralVault.insuranceFund not set by vault owner
    /// @notice FOK could not fill entirely, or IOC matched nothing.
    error TimeInForceNotFilled();
    error InvalidTimeInForce();
    error InvalidReduceQuantity();
    error OrderNotExists();
    error ZeroAddress();
    /// @notice The margin engine aggregates a different vault than this venue settles into.
    error VaultMismatch();
    /// @dev A dependency did not answer a call the venue depends on: no code at the address,
    ///      or the call reverted. Which dependency is bad is implied by the setter that reverted.
    error InvalidDependency();

    /// @param _vault The shared collateral vault. Its `collateralToken()` becomes the underlying ERC20.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(ICollateralVault _vault) {
        if (address(_vault) == address(0)) revert InsufficientCollateral();
        vault = _vault;
        collateralDecimals = IERC20Metadata(address(_vault.collateralToken())).decimals();
        _disableInitializers();
    }

    // ── Internal helpers: admin / config ──────────────────────────────────────

    /// @dev Validates a proposed (maker, taker) fee pair. Both bounds matter:
    ///      `MAX_FEE_BPS` keeps the unreserved fee small relative to the MM floor, and the
    ///      non-negative sum keeps a match from being a net outflow — without it a maker
    ///      rebate exceeding the taker fee drains the insurance fund once per trade,
    ///      unbounded in volume.
    function _validateFees(int16 _makerFeeBps, int16 _takerFeeBps) internal pure {
        if (_makerFeeBps > MAX_FEE_BPS || _makerFeeBps < -MAX_FEE_BPS) revert InvalidFee();
        if (_takerFeeBps > MAX_FEE_BPS || _takerFeeBps < -MAX_FEE_BPS) revert InvalidFee();
        if (int256(_makerFeeBps) + int256(_takerFeeBps) < 0) revert InvalidFee();
    }

    // ── Dependency probes ─────────────────────────────────────────────────────
    //
    // `catch` only fires on a revert raised by the callee, so the code check ahead of it
    // is load-bearing: a call to an address holding no code succeeds with empty return
    // data and fails later in this contract's decoder, out of the catch block's reach.

    function _requireContract(address target) internal view {
        if (target.code.length == 0) revert InvalidDependency();
    }

    // ── Internal helpers: points hook ─────────────────────────────────────────

    /// @dev Notify the points hook of a fill. Skipped when no hook is configured. The call is
    ///      intentionally not isolated: a reverting hook reverts the fill (unplug via setHook).
    ///      `_makerPrice` is the resting maker order's price; `_refPriceForPoints()` supplies the
    ///      oracle reference for the hook's price-improvement multiplier (0 when stale → no bonus).
    function _notifyFill(
        address _maker,
        address _taker,
        uint256 _notional,
        int256 _makerFee,
        int256 _takerFee,
        uint256 _makerPrice
    ) internal {
        IPointsHook _hook = hook;
        if (address(_hook) == address(0)) return;
        uint256 takerFeeAbs = _takerFee > 0 ? uint256(_takerFee) : 0;
        _hook.onFill(_maker, _taker, _notional, _makerFee, takerFeeAbs, _makerPrice, _refPriceForPoints());
    }

    /// @dev Oracle reference price for the points price-improvement multiplier, in the same
    ///      units as an order's price. Unlike `getMarketPrice()`, this returns 0 instead of
    ///      reverting when the oracle is stale or non-positive, so a points-side read can never
    ///      block a fill — the hook simply applies no bonus (1x) when the reference is 0.
    function _refPriceForPoints() internal view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = priceOracle.latestRoundData();
        if (answer <= 0) return 0;
        if (block.timestamp - updatedAt > MAX_ORACLE_STALENESS) return 0;
        uint256 price = M.scaleDecimals(uint256(answer), oracleDecimals, collateralDecimals);
        return M.roundToNearest(price, minimumPriceIncrement);
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
    function _move(address _from, address _to, uint256 _amount) internal {
        vault.internalTransfer(_from, _to, _amount);
    }

    /// @dev Shared reserve / fee ledger: vault `INSURANCE_FUND_ADDR` receipt account.
    function _insuranceFundAccount() internal view returns (address) {
        address fund = vault.INSURANCE_FUND_ADDR();
        if (fund == address(0)) revert InsuranceFundNotConfigured();
        return fund;
    }

    // ── Internal helpers: pricing ─────────────────────────────────────────────

    /// @dev Body of {getMarketPrice}: current oracle price scaled to collateral decimals.
    function _marketPrice() internal view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = priceOracle.latestRoundData();

        // Check for stale price
        if (block.timestamp - updatedAt > MAX_ORACLE_STALENESS) {
            revert OracleStale();
        }

        // Handle negative prices
        if (answer < 0) {
            revert InvalidOracle();
        }

        // Convert oracle price to collateral token decimals (oracle already quotes 1 PH/s/day)
        uint256 price = M.scaleDecimals(uint256(answer), oracleDecimals, collateralDecimals);

        // Round to nearest minimumPriceIncrement
        price = M.roundToNearest(price, minimumPriceIncrement);

        return price;
    }

    // ── Internal helpers: order placement / matching ──────────────────────────

    /// @dev Mint the next order id. Keeps `nonce` private to this layer.
    function _nextOrderId() internal returns (bytes32) {
        return bytes32(++nonce);
    }

    /// @dev Absolute qty of resting orders that reduce `_net`.
    function _restingReduceAbs(address _user, int256 _net) internal view returns (uint256 total) {
        if (_net == 0) return 0;
        EnumerableSet.Bytes32Set storage ids = participantOrderIdsIndex[_user];
        uint256 len = ids.length();
        for (uint256 i = 0; i < len; i++) {
            Order memory order = orders[ids.at(i)];
            if (order.quantity == 0) continue;
            if (_net > 0 ? order.quantity < 0 : order.quantity > 0) {
                total += M.abs(order.quantity);
            }
        }
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

        while (currentPrice != 0 && remainingQuantity != 0) {
            if (_isBuy && currentPrice > _limitPrice) break;
            if (!_isBuy && currentPrice < _limitPrice) break;

            (, uint256 nextPrice) = oppositePrices.getNextNode(currentPrice);
            remainingQuantity = _matchOrdersAtPrice(_taker, currentPrice, remainingQuantity, _isBuy);
            currentPrice = nextPrice;
        }

        return remainingQuantity;
    }

    /// @notice Match orders at a specific price level (direct walk).
    /// @dev Self-cross (maker == taker) nets out size with no trade, fees, or
    ///      position update — same STP semantics as Futures.
    function _matchOrdersAtPrice(address _taker, uint256 _price, int256 _remainingQty, bool _isBuy)
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

            _remainingQty = _executeMatch(_taker, makerOrderId, makerOrder, _remainingQty);
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
        bool makerIsBid = makerQty > 0;

        _subtractOrderAggregate(_taker, makerIsBid, makerPrice, makerAbs, makerAbs - cancelAmt);

        if (cancelAmt == makerAbs) {
            _removeOrder(_makerOrderId, _taker, makerPrice, makerIsBid);
            emit OrderCancelled(_makerOrderId, _taker);
        } else {
            uint256 reducedMakerAbs = makerAbs - cancelAmt;
            int256 newMakerQty = M.toSigned(makerQty > 0, reducedMakerAbs);
            _makerOrder.quantity = newMakerQty;
            emit OrderUpdated(_makerOrderId, _taker, newMakerQty);
        }

        return _remainingQty > 0 ? int256(remainingAbs - cancelAmt) : -int256(remainingAbs - cancelAmt);
    }

    /// @notice Execute a single order match
    function _executeMatch(address _taker, bytes32 _makerOrderId, Order storage _makerOrder, int256 _remainingQty)
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

        int256 takerFee = int256(notionalValue) * int256(takerFeeBps) / int256(BPS);
        int256 makerFee = int256(notionalValue) * int256(makerFeeBps) / int256(BPS);

        _createPosition(_makerOrderId, makerParticipant, _taker, makerPrice, takerQty, takerFee, makerFee);

        _transferFee(_taker, takerFee);
        _transferFee(makerParticipant, makerFee);

        _notifyFill(makerParticipant, _taker, notionalValue, makerFee, takerFee, makerPrice);

        int256 newMakerQty = _reduceQuantity(makerQty, matchAmt);
        _subtractOrderAggregate(makerParticipant, _remainingQty < 0, makerPrice, M.abs(makerQty), M.abs(newMakerQty));
        _makerOrder.quantity = newMakerQty;

        emit OrderUpdated(_makerOrderId, makerParticipant, newMakerQty);
        if (newMakerQty == 0) {
            _removeOrder(_makerOrderId, makerParticipant, makerPrice, _remainingQty < 0);
        }

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

    /// @notice Remove an order from the book (internal)
    /// @dev Callers are responsible for updating the aggregate before this call.
    function _removeOrder(bytes32 _orderId, address _participant, uint256 _price, bool _isBid) internal {
        _priceOrderIds(_price, _isBid).remove(uint256(_orderId));
        participantOrderIdsIndex[_participant].remove(_orderId);
        delete orders[_orderId];
    }

    // ── Internal helpers: position accounting ─────────────────────────────────

    /// @notice Update net positions when orders match
    /// @param taker Address of the taker whose funding was already settled before the matching loop
    function _createPosition(
        bytes32 matchedOrderId,
        address makerParticipant,
        address taker,
        uint256 _price,
        int256 _takerQty,
        int256 _takerFee,
        int256 _makerFee
    ) internal {
        // Determine buyer and seller based on taker quantity sign
        // Positive = taker is buying, negative = taker is selling
        (address buyer, address seller) = _takerQty > 0 ? (taker, makerParticipant) : (makerParticipant, taker);

        // Use absolute quantity for position updates
        // Buyer always gets positive (long), seller always gets negative (short)
        int256 absQty = int256(M.abs(_takerQty));

        // Skip funding settlement for the taker — already settled once before the loop.
        if (buyer != taker) _settleFunding(buyer);
        _updateUserPosition(buyer, absQty, _price);

        if (seller != taker) _settleFunding(seller);
        _updateUserPosition(seller, -absQty, _price);

        Position storage makerPos = positions[makerParticipant];
        Position storage takerPos = positions[taker];
        _emitOrderMatched(
            matchedOrderId,
            makerParticipant,
            taker,
            _price,
            _takerQty,
            _makerFee,
            _takerFee,
            makerPos.netQuantity,
            takerPos.netQuantity,
            makerPos.aggregatedEntryPrice,
            takerPos.aggregatedEntryPrice
        );
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

    /// @notice Update a user's net position with aggregated entry price
    function _updateUserPosition(address _user, int256 _quantity, uint256 _tradePrice) internal {
        Position storage position = positions[_user];

        // If no existing position, initialize it
        if (position.netQuantity == 0) {
            position.netQuantity = _quantity;
            position.aggregatedEntryPrice = _tradePrice;
            usersWithPositions.add(_user);
            userFundingSnapshot[_user] = cumulativeFundingPerUnit;
            return;
        }

        // Same direction - add to position with weighted average entry price
        if (M.isSameSign(position.netQuantity, _quantity)) {
            uint256 oldValue = M.abs(position.netQuantity) * position.aggregatedEntryPrice;
            uint256 newValue = M.abs(_quantity) * _tradePrice;
            int256 newNet = position.netQuantity + _quantity;
            position.aggregatedEntryPrice = (oldValue + newValue) / M.abs(newNet);
            position.netQuantity = newNet;
            return;
        }

        // Opposite direction: settle the reduced part, then open remainder (if any)
        _settleOpposite(_user, _quantity, _tradePrice);
    }

    /// @notice Handle opposite-direction trade (partial/full close or flip)
    function _settleOpposite(address _user, int256 _quantity, uint256 _tradePrice) internal {
        Position storage position = positions[_user];
        uint256 absQuantity = M.abs(_quantity);
        uint256 oldAbsQuantity = M.abs(position.netQuantity);
        uint256 settledAbs = absQuantity < oldAbsQuantity ? absQuantity : oldAbsQuantity;
        _settleReducedPosition(
            _user,
            int256(_tradePrice) - int256(position.aggregatedEntryPrice),
            _toSignedQuantity(settledAbs, position.netQuantity)
        );

        if (absQuantity > oldAbsQuantity) {
            // Flip: close old position and open opposite
            int256 openQty = _toSignedQuantity(absQuantity - oldAbsQuantity, _quantity);
            position.netQuantity = openQty;
            position.aggregatedEntryPrice = _tradePrice;
            userFundingSnapshot[_user] = cumulativeFundingPerUnit;
        } else if (position.netQuantity + _quantity == 0) {
            position.netQuantity = 0;
            usersWithPositions.remove(_user);
        } else {
            position.netQuantity += _quantity;
        }
    }

    // ── Internal helpers: margin / liquidation ────────────────────────────────

    /// @dev Closes `_closeAbs` (< |netQuantity|) of a verified-underwater user's position at the
    ///      mark, realizes PnL on the closed slice via {_settleReducedPosition}, and reduces
    ///      `netQuantity` toward zero (entry price unchanged). Does NOT pay the fee and does NOT
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
        int256 priceDiff = int256(_currentPrice) - int256(_position.aggregatedEntryPrice);

        bool isLong = _position.netQuantity > 0;
        signedClose = M.toSigned(isLong, _closeAbs);

        pnl = _settleReducedPosition(_user, priceDiff, signedClose);

        // Reduce magnitude toward zero; aggregatedEntryPrice is unchanged by a reducing close.
        // signedClose has the position's sign, so subtracting it moves netQuantity toward zero.
        positions[_user].netQuantity = _position.netQuantity - signedClose;
    }

    /// @dev Closes the user's position and settles PnL against the insurance fund. Caller must
    ///      have verified all predicates. Charges a liquidation fee on the closed notional
    ///      (computed as `currentPrice * |closedQuantity| / 10^QUANTITY_DECIMALS`).
    function _doLiquidatePosition(address _user, uint256 _currentPrice) internal {
        Position memory position = positions[_user];

        int256 pnl = _calculatePositionPnl(position, _currentPrice);

        // Settle PnL
        if (pnl < 0) {
            uint256 loss = uint256(-pnl);
            uint256 userBalance = vault.balanceOf(_user);
            uint256 transferAmount = loss < userBalance ? loss : userBalance;
            if (transferAmount > 0) {
                _move(_user, _insuranceFundAccount(), transferAmount);
            }
            if (transferAmount < loss) {
                emit BadDebt(_user, loss - transferAmount);
            }
        } else if (pnl > 0) {
            uint256 profit = uint256(pnl);
            if (vault.balanceOf(_insuranceFundAccount()) >= profit) {
                _move(_insuranceFundAccount(), _user, profit);
            }
        }

        int256 closedQuantity = position.netQuantity;
        uint256 closedNotional = _calculateValue(_currentPrice, M.abs(closedQuantity));
        uint256 liqFee = _chargeLiquidationFee(_user, closedNotional);

        delete positions[_user];
        usersWithPositions.remove(_user);

        emit PositionLiquidated(_user, _msgSender(), closedQuantity, pnl, liqFee);
        _notifyLiquidation(_msgSender(), liqFee);
    }

    /// @notice Settle a reduced portion of a position (when offsetting)
    /// @param _user User address
    /// @param _priceDiff Price difference (tradePrice - entryPrice)
    /// @param _quantity Quantity being closed (positive = long, negative = short)
    /// @return pnl The PnL realized from reducing this position
    function _settleReducedPosition(address _user, int256 _priceDiff, int256 _quantity) internal returns (int256 pnl) {
        // Calculate PnL: priceDiff * quantity / QUANTITY_DECIMALS
        // Long (positive qty): profit when price goes up (positive priceDiff)
        // Short (negative qty): profit when price goes down (negative priceDiff)
        pnl = (_priceDiff * _quantity) / int256(10 ** QUANTITY_DECIMALS);

        // Transfer PnL to/from user
        if (pnl > 0) {
            uint256 profit = uint256(pnl);
            if (vault.balanceOf(_insuranceFundAccount()) < profit) {
                revert InsufficientReservePool();
            }
            _move(_insuranceFundAccount(), _user, profit);
        } else if (pnl < 0) {
            uint256 loss = uint256(-pnl);
            uint256 available = vault.balanceOf(_user);
            if (available >= loss) {
                _move(_user, _insuranceFundAccount(), loss);
            } else {
                if (available > 0) {
                    _move(_user, _insuranceFundAccount(), available);
                }
                emit BadDebt(_user, loss - available);
            }
        }
    }

    /// @notice Charge a liquidation fee on the closed notional value, split between
    ///         liquidator (msg.sender) and insurance fund according to `liquidatorShareBps`.
    /// @dev Fee is `_notionalValue * liquidationFeeBps / 10000`, capped at the user's
    ///      actual vault balance. The liquidator receives `fee * liquidatorShareBps / 10000`
    ///      (also capped at available balance), and the remainder goes to the insurance fund.
    /// @param _user The liquidated user (fee source)
    /// @param _notionalValue Notional value of the liquidated position/order
    /// @return totalFee Total fee actually collected (may be less than computed if balance insufficient)
    function _chargeLiquidationFee(address _user, uint256 _notionalValue) internal returns (uint256 totalFee) {
        uint16 feeBps = liquidationFeeBps;
        if (feeBps == 0) return 0;

        uint256 computedFee = _notionalValue * uint256(feeBps) / BPS;
        if (computedFee == 0) return 0;

        uint256 userBal = vault.balanceOf(_user);
        totalFee = computedFee < userBal ? computedFee : userBal;
        if (totalFee == 0) return 0;

        address liquidator = _msgSender();
        address insurance = _insuranceFundAccount();

        uint16 liqShareBps = liquidatorShareBps;
        uint256 liquidatorShare = totalFee * uint256(liqShareBps) / BPS;
        uint256 insuranceShare = totalFee - liquidatorShare;

        _move(_user, liquidator, liquidatorShare);
        _move(_user, insurance, insuranceShare);
    }

    /// @notice Calculate PnL for a position at a given price
    /// @param _position The position to calculate PnL for
    /// @param _currentPrice The current market price
    /// @return pnl The unrealized PnL (positive = profit, negative = loss)
    function _calculatePositionPnl(Position memory _position, uint256 _currentPrice) internal pure returns (int256) {
        if (_position.netQuantity == 0) return 0;
        int256 priceDiff = int256(_currentPrice) - int256(_position.aggregatedEntryPrice);
        // PnL = priceDiff * quantity / QUANTITY_DECIMALS (sign of quantity handles long/short)
        return (priceDiff * _position.netQuantity) / int256(10 ** QUANTITY_DECIMALS);
    }

    /// @notice Ensure user meets initial margin requirement.
    ///         Delegates to the cross-product PortfolioMarginEngine.
    function _ensureInitialMargin(address _user) internal view {
        if (vault.balanceOf(_user) < portfolioMargin.computePortfolioIM(_user)) {
            revert InsufficientMargin();
        }
    }

    // ── Internal helpers: validation / book lookups ───────────────────────────

    function _validateTIF(TimeInForce _tif) internal pure {
        if (uint8(_tif) > uint8(TimeInForce.FOK)) revert InvalidTimeInForce();
    }

    function _validateQty(int256 _quantity) internal pure {
        if (_quantity == 0) revert InvalidSize();
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

    /// @notice Add a price level to the sorted price list if not already present
    function _addPriceLevel(uint256 _price, bool _isBid) internal {
        StructuredLinkedList.List storage priceList = _isBid ? activeBidPrices : activeAskPrices;
        PriceLadderLib.insertPrice(priceList, _price, _isBid, MAX_PRICE_LEVELS_PER_SIDE);
    }

    /// @notice Remove a price level from the sorted price list if order queue is empty
    function _removePriceLevelIfEmpty(StructuredLinkedList.List storage orderQueue, uint256 _price, bool _isBid)
        internal
    {
        StructuredLinkedList.List storage priceList = _isBid ? activeBidPrices : activeAskPrices;
        PriceLadderLib.removeIfEmpty(orderQueue, priceList, _price);
    }

    /// @dev Body of {getBestBidPrice}: best (highest) bid, or 0 if empty.
    function _bestBidPrice() internal view returns (uint256) {
        if (activeBidPrices.sizeOf() == 0) return 0;
        (, uint256 bestBid) = activeBidPrices.getNextNode(0);
        return bestBid;
    }

    /// @dev Body of {getBestAskPrice}: best (lowest) ask, or 0 if empty.
    function _bestAskPrice() internal view returns (uint256) {
        if (activeAskPrices.sizeOf() == 0) return 0;
        (, uint256 bestAsk) = activeAskPrices.getNextNode(0);
        return bestAsk;
    }

    /// @notice Transfer a pre-calculated fee between participant and reserve pool
    /// @param _participant Address of the participant
    /// @param _fee Signed fee amount (positive = participant pays, negative = rebate)
    /// @dev Both directions clamp, matching {_settleFunding} and {_chargeLiquidationFee}.
    ///      The hazard is an ordering one inside the fill, not keeper latency:
    ///      {_executeMatch} calls {_createPosition}, which settles the maker's funding —
    ///      clamping to balance and emitting `BadDebt` — and only then charges the maker
    ///      fee against whatever settlement left behind. An unclamped debit would let a
    ///      maker whose balance the same transaction just drained revert a stranger's
    ///      taker order. Coverage of the fee itself rests on the MM floor (`mmSpotShock`
    ///      on the full resting notional against a fee bounded by `MAX_FEE_BPS`), so this
    ///      clamp only bites for an account already below MM, where it costs the
    ///      insurance fund a few bps rather than blocking the book.
    function _transferFee(address _participant, int256 _fee) internal {
        if (_fee >= 0) {
            uint256 owed = uint256(_fee);
            uint256 available = vault.balanceOf(_participant);
            uint256 paid = owed < available ? owed : available;
            if (paid > 0) {
                _move(_participant, _insuranceFundAccount(), paid);
            }
            if (paid < owed) {
                emit BadDebt(_participant, owed - paid);
            }
        } else {
            uint256 rebate = uint256(-_fee);
            uint256 reserveBalance = vault.balanceOf(_insuranceFundAccount());
            uint256 payout = rebate < reserveBalance ? rebate : reserveBalance;
            if (payout > 0) {
                _move(_insuranceFundAccount(), _participant, payout);
            }
        }
    }

    // ── Internal helpers: funding ─────────────────────────────────────────────

    /// @notice Compute the current cumulative funding per unit without writing state
    /// @dev Uses the order-book mid-price as mark price and the oracle as index price.
    ///      If either side of the book is empty, no additional funding accrues.
    /// @return currentCumFunding The theoretical cumulative funding as of block.timestamp
    function _getCurrentCumulativeFunding() internal view returns (int256 currentCumFunding) {
        currentCumFunding = cumulativeFundingPerUnit;

        if (lastFundingUpdateTime == 0 || fundingPeriod == 0) return currentCumFunding;

        uint256 timeElapsed = block.timestamp - lastFundingUpdateTime;
        if (timeElapsed == 0) return currentCumFunding;

        // Mark price = order-book mid-price
        uint256 bestBid = _bestBidPrice();
        uint256 bestAsk = _bestAskPrice();
        if (bestBid == 0 || bestAsk == 0) return currentCumFunding;

        uint256 markPrice = (bestBid + bestAsk) / 2;
        uint256 indexPrice = _marketPrice();

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
    /// @dev Called before any position-affecting operation.
    function _updateGlobalFunding() internal {
        if (lastFundingUpdateTime == 0 || fundingPeriod == 0) return;

        int256 newCumFunding = _getCurrentCumulativeFunding();

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
            uint256 owed = uint256(pendingFunding);
            uint256 userBalance = vault.balanceOf(_user);
            if (userBalance >= owed) {
                _move(_user, _insuranceFundAccount(), owed);
            } else {
                if (userBalance > 0) {
                    _move(_user, _insuranceFundAccount(), userBalance);
                }
                emit BadDebt(_user, owed - userBalance);
            }
        } else {
            uint256 owed = uint256(-pendingFunding);
            uint256 reserveBalance = vault.balanceOf(_insuranceFundAccount());
            uint256 payout = owed < reserveBalance ? owed : reserveBalance;
            if (payout > 0) {
                _move(_insuranceFundAccount(), _user, payout);
            }
        }

        emit FundingSettled(_user, pendingFunding);
    }

    /// @dev Body of {getPendingFunding}: pending (unsettled) funding for a user.
    ///      Positive = user owes, negative = user receives (in collateral token units).
    function _pendingFunding(address _user) internal view returns (int256) {
        Position memory position = positions[_user];
        if (position.netQuantity == 0) return 0;

        int256 currentCumFunding = _getCurrentCumulativeFunding();
        int256 delta = currentCumFunding - userFundingSnapshot[_user];
        if (delta == 0) return 0;

        return (position.netQuantity * delta) / (int256(10 ** QUANTITY_DECIMALS) * int256(10 ** FUNDING_DECIMALS));
    }

    // ── Internal helpers: admin ───────────────────────────────────────────────

    /// @notice Clear all orders at a single price level and remove them from participant indexes
    function _clearPriceLevelOrders(uint256 _price, bool _isBid) internal {
        StructuredLinkedList.List storage queue = _priceOrderIds(_price, _isBid);
        (, uint256 orderIdUint) = queue.getNextNode(0);
        while (orderIdUint != 0) {
            (, uint256 nextOrderIdUint) = queue.getNextNode(orderIdUint);
            bytes32 orderId = bytes32(orderIdUint);
            Order storage order = orders[orderId];
            address participant = order.participant;
            _subtractOrderAggregate(participant, _isBid, _price, M.abs(order.quantity), 0);
            participantOrderIdsIndex[participant].remove(orderId);
            delete orders[orderId];
            queue.remove(orderIdUint);
            orderIdUint = nextOrderIdUint;
        }
    }
}
