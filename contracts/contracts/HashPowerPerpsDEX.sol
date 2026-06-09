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
import { MulticallStopOnFailureUpgradeable } from "./MulticallStopOnFailureUpgradeable.sol";
import { AggregatorV3Interface } from "./interfaces/AggregatorV3Interface.sol";
import { ICollateralVault } from "collateral-margin/contracts/contracts/interfaces/ICollateralVault.sol";
import { IPortfolioMarginEngine } from "collateral-margin/contracts/contracts/interfaces/IPortfolioMarginEngine.sol";
import { IPointsHook } from "collateral-margin/contracts/contracts/interfaces/IPointsHook.sol";
import { console } from "hardhat/console.sol";
import { Versionable } from "./interfaces/Versionable.sol";

/// @title HashPower Perps DEX
/// @notice Perpetual trading contract with on-chain order book
/// @dev Positions are created between two users when orders match
/// @dev TODO: Add support for partial liquidation
/// @dev TODO: when not enough reserve pool, the user should be able to get revenue
/// @dev on their collateral balance and withdraw later when collateral is added
contract HashPowerPerpsDEX is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    MulticallStopOnFailureUpgradeable,
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
    uint256 public constant MAX_PRICE_LEVELS_PER_SIDE = 200; // Max active price levels per side (bid/ask)
    uint256 public immutable minimumPriceIncrement; // Minimum price increment for orders
    string public constant VERSION = "2.2.0";

    // State variables
    IERC20 public collateralToken;
    AggregatorV3Interface public priceOracle;
    uint8 public marginPercent; // Initial margin requirement as percentage (e.g., 10 = 10%)
    uint8 public maintenanceMarginPercent; // Maintenance margin percentage (e.g., 5 = 5%)
    /// @notice Flat liquidation fee in collateral token units. Paid once per call to a
    ///         permissionless liquidation entry point: per cancelled order in `liquidateOrder`
    ///         (composable as N-shot via `multicallStopOnFailure`) and per closed position in
    ///         `liquidatePosition`. Also acts as the minimum taker fee in `_calculateMatchFee`.
    uint256 public liquidationFee;
    uint8 private tokenDecimals;
    uint8 private oracleDecimals;
    uint256 private nonce; // Nonce for order IDs

    // Order book mappings
    mapping(bytes32 => Order) private orders;
    mapping(uint256 => StructuredLinkedList.List) private priceOrdersLongQueue; // FIFO queue of long orders by price
    mapping(uint256 => StructuredLinkedList.List) private priceOrdersShortQueue; // FIFO queue of short orders by price
    mapping(address => EnumerableSet.Bytes32Set) private participantOrderIdsIndex; // Orders by participant
    mapping(address => uint256) private _gap;

    // Price level tracking for limit order matching
    StructuredLinkedList.List private activeBidPrices; // Sorted bid prices (highest first)
    StructuredLinkedList.List private activeAskPrices; // Sorted ask prices (lowest first)

    // Position mappings - net position per user
    mapping(address => Position) private positions; // Net position per user
    EnumerableSet.AddressSet private usersWithPositions; // Users with active positions

    // Reserve and fees
    int16 public takerFeeBps; // Taker fee in basis points (e.g., 5 = 0.05%)
    int16 public makerFeeBps; // Maker fee in basis points (e.g., 0 = 0%)

    // Funding state
    int256 public cumulativeFundingPerUnit; // Global cumulative funding per unit (tokenDecimals * 10^FUNDING_DECIMALS)
    uint256 public lastFundingUpdateTime; // Last timestamp funding was updated
    uint256 public fundingRateMaxBps; // Max absolute funding rate per fundingPeriod in bps (e.g., 100 = 1%)
    uint256 public fundingPeriod; // Period for max funding rate (e.g., 86400 = 24 hours)
    mapping(address => int256) private userFundingSnapshot; // Per-user snapshot of cumulativeFundingPerUnit

    // Order book limits
    uint256 public minimumMarginPerOrder; // Minimum margin (collateral) locked per resting order (0 = no minimum)
    mapping(address => uint256) private userBuyOrderValue; // Cached total buy order value per user
    mapping(address => uint256) private userSellOrderValue; // Cached total sell order value per user

    // Level 2: Unified collateral vault
    ICollateralVault public vault;
    IPortfolioMarginEngine public portfolioMargin;

    /// @notice Optional points/rewards hook notified on fills and liquidations.
    /// @dev Appended at the end of storage to preserve the upgradeable layout. When unset
    ///      (`address(0)`) the venue mints no points and skips the call entirely. When set,
    ///      hook calls are NOT wrapped in try/catch: a reverting hook will revert the fill or
    ///      liquidation. The hook is a simple, owner-controlled contract and can be unplugged
    ///      instantly via `setHook(address(0))`; unplug it before finalizing the POINTS token.
    IPointsHook public hook;

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

    // Events
    event OrderCreated(bytes32 indexed orderId, address indexed participant, uint256 price, int256 quantity);
    event OrderCancelled(bytes32 indexed orderId, address indexed participant);
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
    event MarginPercentUpdated(uint8 newMarginPercent);
    event MaintenanceMarginPercentUpdated(uint8 newMaintenanceMarginPercent);
    event LiquidationFeeUpdated(uint256 newLiquidationFee);
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
    error OrderNotBelongToUser(); // liquidateOrder called with an id not owned by the specified user
    error InsufficientReservePool(); // The reserve pool does not have enough collateral to cover user profit
    error InvalidFundingParameters();
    error OrderMarginTooLow(); // Order margin is below minimumMarginPerOrder
    error MaxPriceLevelsReached(); // Too many active price levels on one side of the book
    error InsuranceFundNotConfigured(); // CollateralVault.insuranceFund not set by vault owner

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(uint256 _minimumPriceIncrement) {
        _disableInitializers();
        if (_minimumPriceIncrement == 0) {
            revert InvalidPrice();
        }
        minimumPriceIncrement = _minimumPriceIncrement;
    }

    /// @notice Initialize the contract
    /// @param _priceOracle The Chainlink-style price oracle
    /// @param _vault The shared collateral vault. Its `collateralToken()` is used as the underlying ERC20.
    function initialize(AggregatorV3Interface _priceOracle, ICollateralVault _vault) external initializer {
        if (address(_priceOracle) == address(0)) {
            revert InvalidOracle();
        }
        if (address(_vault) == address(0)) {
            revert InsufficientCollateral();
        }

        __Ownable_init(_msgSender());
        __UUPSUpgradeable_init();
        __Multicall_init();

        vault = _vault;
        IERC20Metadata vaultToken = IERC20Metadata(address(_vault.collateralToken()));
        collateralToken = vaultToken;
        priceOracle = _priceOracle;
        tokenDecimals = vaultToken.decimals();
        oracleDecimals = _priceOracle.decimals();
    }

    /// @notice Authorize upgrade (only owner)
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner { }

    /// @notice One-shot post-upgrade migration to wire up the collateral vault
    ///         and (optionally) the portfolio margin engine added in v2.
    /// @dev Intended to be invoked atomically via `upgradeToAndCall`:
    ///      `proxy.upgradeToAndCall(newImpl, abi.encodeCall(this.initializeV2, (vault, pm)))`.
    /// @param _vault The shared collateral vault. Its `collateralToken()` becomes the underlying ERC20.
    /// @param _pm The portfolio margin engine (may be `address(0)` to set later via `setPortfolioMargin`).
    function initializeV2(ICollateralVault _vault, IPortfolioMarginEngine _pm) external reinitializer(2) onlyOwner {
        if (address(_vault) == address(0)) {
            revert InsufficientCollateral();
        }

        vault = _vault;
        portfolioMargin = _pm;

        IERC20Metadata vaultToken = IERC20Metadata(address(_vault.collateralToken()));
        collateralToken = vaultToken;
        tokenDecimals = vaultToken.decimals();
    }

    // ── Vault integration ───────────────────────────────────────────────────

    /// @notice Set the portfolio margin engine for cross-product margin checks.
    function setPortfolioMargin(IPortfolioMarginEngine _pm) external onlyOwner {
        portfolioMargin = _pm;
    }

    /// @notice Emitted whenever the points hook address changes.
    event HookUpdated(address indexed hook);

    /// @notice Set (or clear) the points/rewards hook. Pass `address(0)` to disable points.
    /// @dev The venue proxy must hold `HOOK_CALLER_ROLE` on the hook BEFORE it is plugged in:
    ///      hook calls are not try/catch-isolated, so a hook that reverts (e.g. missing role,
    ///      or after the POINTS token is finalized) would block fills and liquidations. Clear
    ///      the hook with `address(0)` to disable points instantly.
    function setHook(address _hook) external onlyOwner {
        hook = IPointsHook(_hook);
        emit HookUpdated(_hook);
    }

    /// @dev Notify the points hook of a fill. Skipped when no hook is configured. The call is
    ///      intentionally not isolated: a reverting hook reverts the fill (unplug via setHook).
    function _notifyFill(address _maker, address _taker, uint256 _notional, int256 _makerFee, int256 _takerFee)
        private
    {
        IPointsHook _hook = hook;
        if (address(_hook) == address(0)) return;
        uint256 takerFeeAbs = _takerFee > 0 ? uint256(_takerFee) : 0;
        _hook.onFill(_maker, _taker, _notional, _makerFee, takerFeeAbs);
    }

    /// @dev Notify the points hook of a liquidation. Skipped when no hook is configured. Not
    ///      isolated: a reverting hook reverts the liquidation (unplug via setHook).
    function _notifyLiquidation(address _liquidator, uint256 _fee) private {
        IPointsHook _hook = hook;
        if (address(_hook) == address(0)) return;
        _hook.onLiquidation(_liquidator, _fee);
    }

    /// @notice Returns the user's collateral balance from the vault.
    function balanceOf(address account) public view returns (uint256) {
        return vault.balanceOf(account);
    }

    /// @dev Move collateral between two accounts via the vault.
    function _move(address _from, address _to, uint256 _amount) private {
        if (_amount == 0) return;
        vault.internalTransfer(_from, _to, _amount);
    }

    /// @dev Shared reserve / fee ledger: vault `INSURANCE_FUND_ADDR` receipt account.
    function _insuranceFundAccount() private view returns (address) {
        address fund = vault.INSURANCE_FUND_ADDR();
        if (fund == address(0)) revert InsuranceFundNotConfigured();
        return fund;
    }

    /// @notice Get current market price from oracle
    /// @return price The current price (scaled to collateral token decimals)
    function getMarketPrice() public view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = priceOracle.latestRoundData();

        // Check for stale price
        if (block.timestamp - updatedAt > MAX_ORACLE_STALENESS) {
            revert OracleStale();
        }

        // Handle negative prices
        if (answer < 0) {
            revert InvalidOracle();
        }

        // Convert oracle price to collateral token decimals
        uint256 price = _scaleDecimals(uint256(answer), oracleDecimals, tokenDecimals);

        // Round to nearest minimumPriceIncrement
        price = _roundToNearest(price, minimumPriceIncrement);

        return price;
    }

    /// @notice Create an order (buy or sell) with limit price matching (direct walk, no simulate list).
    /// @param _price Limit price (must be multiple of minimumPriceIncrement)
    /// @param _quantity Order quantity (positive = long/buy, negative = short/sell)
    /// @dev Buy orders match with asks at or below the limit price
    /// @dev Sell orders match with bids at or above the limit price
    function createOrder(uint256 _price, int256 _quantity) external {
        address sender = _msgSender();
        _updateGlobalFunding();
        _validateQuantity(_quantity);
        _validatePrice(_price);

        // Settle taker's funding once before matching so per-match _updateUserPosition
        // calls can skip it (cumulativeFundingPerUnit is constant within this tx).
        _settleFunding(sender);

        bool isBuy = _quantity > 0;
        bytes32 orderId = bytes32(++nonce);
        emit OrderCreated(orderId, sender, _price, _quantity);

        // Snapshot position before matching to detect reduce-only orders
        int256 positionBefore = positions[sender].netQuantity;

        int256 remainingQuantity = _matchWithOppositeOrders(sender, _price, _quantity);

        if (remainingQuantity != _quantity) {
            emit OrderUpdated(orderId, sender, remainingQuantity);
        }

        if (remainingQuantity != 0) {
            // Validate minimum margin per resting order
            if (minimumMarginPerOrder > 0) {
                uint256 restingValue = _calculateValue(_price, _abs(remainingQuantity));
                uint256 restingMargin = (restingValue * portfolioMargin.imSpotShock()) / 1e18;
                if (restingMargin < minimumMarginPerOrder) {
                    revert OrderMarginTooLow();
                }
            }

            // Validate max orders per participant
            EnumerableSet.Bytes32Set storage participantOrders = participantOrderIdsIndex[sender];
            if (participantOrders.length() >= MAX_ORDERS_PER_PARTICIPANT) {
                revert MaxOrdersPerParticipantReached();
            }

            // Create order with quantity that was not matched
            orders[orderId] = Order({ participant: sender, price: _price, quantity: remainingQuantity });
            _getOrderValue(isBuy)[sender] += _calculateValue(_price, _abs(remainingQuantity));
            participantOrders.add(orderId);
            StructuredLinkedList.List storage orderQueue = _priceOrderIds(_price, isBuy);
            orderQueue.pushBack(uint256(orderId));

            _addPriceLevel(_price, isBuy);
        }

        // Skip margin check for reduce-only orders (opposite side, not exceeding position)
        bool isReduceOnly = positionBefore != 0 && (positionBefore > 0 ? _quantity < 0 : _quantity > 0)
            && _abs(_quantity) <= _abs(positionBefore);

        if (!isReduceOnly) {
            _ensureInitialMargin(sender);
        }
    }

    /// @notice Match incoming order with opposite orders using limit price logic (direct walk).
    /// @param _taker Address of the taker (funding already settled before this call)
    function _matchWithOppositeOrders(address _taker, uint256 _limitPrice, int256 _quantity)
        private
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
    function _matchOrdersAtPrice(address _taker, uint256 _price, int256 _remainingQty, bool _isBuy)
        private
        returns (int256)
    {
        StructuredLinkedList.List storage makerOrderQueue = _priceOrderIds(_price, !_isBuy);

        (, uint256 orderIdUint) = makerOrderQueue.getNextNode(0);
        while (_remainingQty != 0 && orderIdUint != 0) {
            bytes32 makerOrderId = bytes32(orderIdUint);
            Order storage makerOrder = orders[makerOrderId];
            _remainingQty = _executeMatch(_taker, makerOrderId, makerOrder, _remainingQty);
            (, orderIdUint) = makerOrderQueue.getNextNode(0);
        }

        // Remove price level once after finishing this level, instead of after every filled order.
        _removePriceLevelIfEmpty(_price, !_isBuy);

        return _remainingQty;
    }

    /// @notice Execute a single order match
    function _executeMatch(address _taker, bytes32 _makerOrderId, Order storage _makerOrder, int256 _remainingQty)
        private
        returns (int256)
    {
        // Cache fields from storage once to avoid repeated SLOADs.
        uint256 makerPrice = _makerOrder.price;
        address makerParticipant = _makerOrder.participant;
        int256 makerQty = _makerOrder.quantity;
        uint256 matchAmt = _min(_abs(makerQty), _abs(_remainingQty));
        int256 takerQty = _toSignedQuantity(matchAmt, _remainingQty);
        uint256 notionalValue = _calculateValue(makerPrice, matchAmt);

        int256 takerFee = _calculateMatchFee(notionalValue, true);
        int256 makerFee = _calculateMatchFee(notionalValue, false);

        _createPosition(_makerOrderId, makerParticipant, _taker, makerPrice, takerQty, takerFee, makerFee);

        _transferFee(_taker, takerFee);
        _transferFee(makerParticipant, makerFee);

        _notifyFill(makerParticipant, _taker, notionalValue, makerFee, takerFee);

        // Update cached order value (maker is buy when taker is selling, and vice versa)
        _getOrderValue(_remainingQty < 0)[makerParticipant] -= notionalValue;

        int256 newMakerQty = _reduceQuantity(makerQty, matchAmt);
        _makerOrder.quantity = newMakerQty;

        emit OrderUpdated(_makerOrderId, makerParticipant, newMakerQty);
        if (newMakerQty == 0) {
            _removeOrder(_makerOrderId, makerParticipant, makerPrice, _remainingQty < 0);
        }

        unchecked {
            return _remainingQty - takerQty;
        }
    }

    /// @notice Get absolute value of int256
    function _abs(int256 _value) private pure returns (uint256) {
        return _value > 0 ? uint256(_value) : uint256(-_value);
    }

    /// @notice Check if two quantities have the same sign
    function _isSameSign(int256 _a, int256 _b) private pure returns (bool) {
        return (_a > 0 && _b > 0) || (_a < 0 && _b < 0);
    }

    /// @notice Calculate value (price * quantity / decimals)
    function _calculateValue(uint256 _price, uint256 _absQuantity) private pure returns (uint256) {
        return (_price * _absQuantity) / (10 ** QUANTITY_DECIMALS);
    }

    /// @notice Convert absolute quantity to signed based on reference sign
    function _toSignedQuantity(uint256 _absQuantity, int256 _referenceSign) private pure returns (int256) {
        return _referenceSign > 0 ? int256(_absQuantity) : -int256(_absQuantity);
    }

    /// @notice Get minimum of two values
    function _min(uint256 _a, uint256 _b) private pure returns (uint256) {
        return _a < _b ? _a : _b;
    }

    /// @notice Reduce absolute value of signed quantity
    function _reduceQuantity(int256 _quantity, uint256 _reduction) private pure returns (int256) {
        return _quantity > 0 ? _quantity - int256(_reduction) : _quantity + int256(_reduction);
    }

    /// @notice Cancel an order
    /// @param _orderId Order ID to cancel
    function cancelOrder(bytes32 _orderId) external {
        _updateGlobalFunding();
        Order memory order = orders[_orderId];
        if (order.participant != _msgSender()) {
            revert OrderNotBelongToSender();
        }

        bool isBid = order.quantity > 0;
        _getOrderValue(isBid)[order.participant] -= _calculateValue(order.price, _abs(order.quantity));

        _removeOrder(_orderId, order.participant, order.price, isBid);
        _removePriceLevelIfEmpty(order.price, isBid);
        emit OrderCancelled(_orderId, order.participant);
    }

    function _getOrderValue(bool _isBuy) private view returns (mapping(address => uint256) storage) {
        if (_isBuy) {
            return userBuyOrderValue;
        } else {
            return userSellOrderValue;
        }
    }

    /// @notice Remove an order from the book (internal)
    /// @dev Callers are responsible for updating order values via _getOrderValue before this call.
    function _removeOrder(bytes32 _orderId, address _participant, uint256 _price, bool _isBid) private {
        _priceOrderIds(_price, _isBid).remove(uint256(_orderId));
        participantOrderIdsIndex[_participant].remove(_orderId);
        delete orders[_orderId];
    }

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
    ) private {
        // Determine buyer and seller based on taker quantity sign
        // Positive = taker is buying, negative = taker is selling
        (address buyer, address seller) = _takerQty > 0 ? (taker, makerParticipant) : (makerParticipant, taker);

        // Use absolute quantity for position updates
        // Buyer always gets positive (long), seller always gets negative (short)
        int256 absQty = int256(_abs(_takerQty));

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
    ) private {
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
    function _updateUserPosition(address _user, int256 _quantity, uint256 _tradePrice) private {
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
        if (_isSameSign(position.netQuantity, _quantity)) {
            uint256 oldValue = _abs(position.netQuantity) * position.aggregatedEntryPrice;
            uint256 newValue = _abs(_quantity) * _tradePrice;
            int256 newNet = position.netQuantity + _quantity;
            position.aggregatedEntryPrice = (oldValue + newValue) / _abs(newNet);
            position.netQuantity = newNet;
            return;
        }

        // Opposite direction: settle the reduced part, then open remainder (if any)
        _settleOpposite(_user, _quantity, _tradePrice);
    }

    /// @notice Handle opposite-direction trade (partial/full close or flip)
    function _settleOpposite(address _user, int256 _quantity, uint256 _tradePrice) private {
        Position storage position = positions[_user];
        uint256 absQuantity = _abs(_quantity);
        uint256 oldAbsQuantity = _abs(position.netQuantity);
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

    /// @notice Check if a user's position can be liquidated.
    /// @dev Returns true iff the user has a position AND is below MM. Note: this view does NOT
    ///      check the orders-must-be-clear rule enforced by `liquidatePosition`. Callers that
    ///      want the full preflight should also check `getUserOrders(user).length == 0`.
    function isLiquidatable(address _user) public view returns (bool) {
        Position memory position = positions[_user];
        if (position.netQuantity == 0) return false;

        return balanceOf(_user) < portfolioMargin.computePortfolioMM(_user);
    }

    /// @dev True iff the user is below the portfolio MM predicate. Used for permissionless
    ///      `liquidateOrder*` / `liquidatePosition` entry points (those don't need a position
    ///      to be present — orders alone can break MM).
    function _underwater(address _user) internal view returns (bool) {
        return balanceOf(_user) < portfolioMargin.computePortfolioMM(_user);
    }

    /// @notice Force-close a single underwater user's position. Permissionless; pays
    ///         `liquidationFee` from the user's vault to `msg.sender`.
    /// @dev Strict orders-first invariant: reverts with `OrdersStillOpen` if the user has any
    ///      open orders. The keeper must clear them first by composing
    ///      `multicallStopOnFailure([liquidateOrder × N, liquidatePosition])` so the position
    ///      close runs atomically once the orders are gone.
    ///
    ///      Multi-user batches: there is no `liquidateBatch` entry point. Instead, compose
    ///      nested {MulticallStopOnFailureUpgradeable.multicallStopOnFailure} calls — wrap
    ///      each per-user clear-and-close as its OWN inner multicall, then bundle them in an
    ///      outer multicall. The inner converts a per-user revert (e.g. `NotLiquidatable`,
    ///      `OrdersStillOpen`) into a successful return, so the outer skips that user and
    ///      keeps going. See {MulticallStopOnFailureUpgradeable} for the OOG semantics this
    ///      composition still preserves at the leaf level (a clean OOG inside the inner
    ///      reverts the inner with a non-empty selector, which the outer treats as a normal
    ///      stop — keepers should size the outer-tx gas as the sum of per-user estimates +
    ///      a buffer rather than relying on `eth_estimateGas` over the whole bundle).
    function liquidatePosition(address _user) external {
        _updateGlobalFunding();
        _settleFunding(_user);

        if (positions[_user].netQuantity == 0) revert NotLiquidatable();
        if (!_underwater(_user)) revert NotLiquidatable();
        if (participantOrderIdsIndex[_user].length() != 0) revert OrdersStillOpen();

        _doLiquidatePosition(_user);
    }

    /// @notice Force-cancel a single resting order owned by an underwater user. Permissionless;
    ///         pays `liquidationFee` from the user's vault to `msg.sender`.
    /// @dev    Batch use: bundle several `liquidateOrder` calls via {multicallStopOnFailure}
    ///         to FIFO-sweep orders until the user is healthy again or an id goes stale.
    ///         The first failed sub-call (`NotLiquidatable` once MM is restored, or
    ///         `OrderNotBelongToUser` if another keeper raced you) ends the batch while
    ///         keeping fees from earlier successes — see {MulticallStopOnFailureUpgradeable}.
    function liquidateOrder(address _user, bytes32 _orderId) external {
        _updateGlobalFunding();

        if (!_underwater(_user)) revert NotLiquidatable();

        Order memory order = orders[_orderId];
        if (order.participant != _user) revert OrderNotBelongToUser();

        _doLiquidateOrder(_user, _orderId, order);
    }

    /// @dev Cancels a single order on behalf of a (verified-underwater) user and pays the
    ///      flat liquidation fee. Caller must have already verified `_underwater(_user)` and
    ///      that `_order.participant == _user`.
    function _doLiquidateOrder(address _user, bytes32 _orderId, Order memory _order) private {
        bool isBid = _order.quantity > 0;
        _getOrderValue(isBid)[_user] -= _calculateValue(_order.price, _abs(_order.quantity));
        _removeOrder(_orderId, _user, _order.price, isBid);
        _removePriceLevelIfEmpty(_order.price, isBid);

        uint256 fee = liquidationFee;
        uint256 paid;
        if (fee > 0) {
            uint256 userBalance = balanceOf(_user);
            paid = fee < userBalance ? fee : userBalance;
            if (paid > 0) {
                _move(_user, _msgSender(), paid);
            }
        }

        emit OrderCancelled(_orderId, _user);
        emit OrderLiquidated(_orderId, _user, _msgSender(), paid);

        _notifyLiquidation(_msgSender(), paid);
    }

    /// @dev Closes the user's position, settles PnL against the insurance fund, and pays the
    ///      position liquidation fee. Caller must have verified all predicates.
    function _doLiquidatePosition(address _user) private {
        Position memory position = positions[_user];
        uint256 currentPrice = getMarketPrice();

        int256 pnl = _calculatePositionPnl(position, currentPrice);

        uint256 liquidatorFee = liquidationFee;

        // Settle PnL
        if (pnl < 0) {
            uint256 loss = uint256(-pnl);
            uint256 userBalance = balanceOf(_user);
            uint256 transferAmount = loss < userBalance ? loss : userBalance;
            if (transferAmount > 0) {
                _move(_user, _insuranceFundAccount(), transferAmount);
            }
            if (transferAmount < loss) {
                emit BadDebt(_user, loss - transferAmount);
            }
        } else if (pnl > 0) {
            uint256 profit = uint256(pnl);
            if (balanceOf(_insuranceFundAccount()) >= profit) {
                _move(_insuranceFundAccount(), _user, profit);
            }
        }

        // Pay liquidator fee from user's remaining balance
        if (liquidatorFee > 0) {
            uint256 userBalance = balanceOf(_user);
            if (userBalance >= liquidatorFee) {
                _move(_user, _msgSender(), liquidatorFee);
            } else {
                if (userBalance > 0) {
                    _move(_user, _msgSender(), userBalance);
                    liquidatorFee = userBalance;
                } else {
                    liquidatorFee = 0;
                }
            }
        }

        int256 closedQuantity = position.netQuantity;
        delete positions[_user];
        usersWithPositions.remove(_user);

        emit PositionLiquidated(_user, _msgSender(), closedQuantity, pnl, liquidatorFee);

        _notifyLiquidation(_msgSender(), liquidatorFee);
    }

    /// @notice Settle a reduced portion of a position (when offsetting)
    /// @param _user User address
    /// @param _priceDiff Price difference (tradePrice - entryPrice)
    /// @param _quantity Quantity being closed (positive = long, negative = short)
    /// @return pnl The PnL realized from reducing this position
    function _settleReducedPosition(address _user, int256 _priceDiff, int256 _quantity) private returns (int256 pnl) {
        // Calculate PnL: priceDiff * quantity / QUANTITY_DECIMALS
        // Long (positive qty): profit when price goes up (positive priceDiff)
        // Short (negative qty): profit when price goes down (negative priceDiff)
        pnl = (_priceDiff * _quantity) / int256(10 ** QUANTITY_DECIMALS);

        // Transfer PnL to/from user
        if (pnl > 0) {
            uint256 profit = uint256(pnl);
            if (balanceOf(_insuranceFundAccount()) < profit) {
                revert InsufficientReservePool();
            }
            _move(_insuranceFundAccount(), _user, profit);
        } else if (pnl < 0) {
            uint256 loss = uint256(-pnl);
            uint256 available = balanceOf(_user);
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

    /// @notice Calculate PnL for a position at a given price
    /// @param _position The position to calculate PnL for
    /// @param _currentPrice The current market price
    /// @return pnl The unrealized PnL (positive = profit, negative = loss)
    function _calculatePositionPnl(Position memory _position, uint256 _currentPrice) private pure returns (int256) {
        if (_position.netQuantity == 0) return 0;
        int256 priceDiff = int256(_currentPrice) - int256(_position.aggregatedEntryPrice);
        // PnL = priceDiff * quantity / QUANTITY_DECIMALS (sign of quantity handles long/short)
        return (priceDiff * _position.netQuantity) / int256(10 ** QUANTITY_DECIMALS);
    }

    /// @notice Get initial margin requirement for a user.
    ///         Reads the IM spot shock from the PortfolioMarginEngine.
    function getInitialMargin(address _user) public view returns (uint256) {
        return _getMargin(_user, portfolioMargin.imSpotShock());
    }

    /// @notice Get initial margin for a user
    /// @dev Deprecated: use getInitialMargin instead
    function getRequiredMargin(address _user) public view returns (uint256) {
        return getInitialMargin(_user);
    }

    /// @notice Get maintenance margin requirement for a user.
    ///         Reads the MM spot shock from the PortfolioMarginEngine.
    function getMaintenanceMargin(address _user) public view returns (uint256) {
        return _getMargin(_user, portfolioMargin.mmSpotShock());
    }

    function _getMargin(address _user, uint256 _shockWad) private view returns (uint256) {
        uint256 buyVal = _getOrderValue(true)[_user];
        uint256 sellVal = _getOrderValue(false)[_user];
        Position memory position = positions[_user];

        uint256 totalMargin;

        if (position.netQuantity != 0) {
            uint256 currentPrice = getMarketPrice();
            uint256 positionValue = _calculateValue(currentPrice, _abs(position.netQuantity));

            // Offset risk-reducing orders against the position
            uint256 reducingVal;
            if (position.netQuantity > 0) {
                reducingVal = sellVal < positionValue ? sellVal : positionValue;
            } else {
                reducingVal = buyVal < positionValue ? buyVal : positionValue;
            }
            uint256 orderShock = portfolioMargin.imSpotShock();
            totalMargin = ((buyVal + sellVal - reducingVal) * orderShock) / 1e18;

            uint256 requiredMarginForPosition = (positionValue * _shockWad) / 1e18;

            int256 unrealizedPnl = _calculatePositionPnl(position, currentPrice);
            if (unrealizedPnl < 0) {
                requiredMarginForPosition += uint256(-unrealizedPnl);
            }

            int256 pendingFunding = getPendingFunding(_user);
            if (pendingFunding > 0) {
                requiredMarginForPosition += uint256(pendingFunding);
            }

            totalMargin += requiredMarginForPosition;
        } else {
            uint256 orderShock = portfolioMargin.imSpotShock();
            totalMargin = ((buyVal + sellVal) * orderShock) / 1e18;
        }

        return totalMargin;
    }

    /// @notice Ensure user meets initial margin requirement.
    ///         Delegates to the cross-product PortfolioMarginEngine.
    function _ensureInitialMargin(address _user) private view {
        if (balanceOf(_user) < portfolioMargin.computePortfolioIM(_user)) {
            revert InsufficientMargin();
        }
    }

    /// @notice Ensure user meets maintenance margin requirement.
    ///         Delegates to the cross-product PortfolioMarginEngine.
    function _ensureMaintenanceMargin(address _user) private view {
        if (balanceOf(_user) < portfolioMargin.computePortfolioMM(_user)) {
            revert InsufficientMargin();
        }
    }

    /// @notice Validate price
    function _validatePrice(uint256 _price) private view {
        if (_price == 0) {
            revert InvalidPrice();
        }
        if (_price % minimumPriceIncrement != 0) {
            revert InvalidPrice();
        }
    }

    function _validateQuantity(int256 _quantity) private pure {
        if (_quantity == 0) {
            revert InvalidSize();
        }
    }

    /// @notice Get order queue by price and direction
    function _priceOrderIds(uint256 _price, bool _isBuy) private view returns (StructuredLinkedList.List storage) {
        if (_isBuy) {
            return priceOrdersLongQueue[_price];
        } else {
            return priceOrdersShortQueue[_price];
        }
    }

    /// @notice Add a price level to the sorted price list if not already present
    /// @param _price The price level to add
    /// @param _isBid True for bid (buy) prices, false for ask (sell) prices
    function _addPriceLevel(uint256 _price, bool _isBid) private {
        StructuredLinkedList.List storage priceList = _isBid ? activeBidPrices : activeAskPrices;

        // Check if price level already exists
        if (priceList.nodeExists(_price)) {
            return;
        }

        // Enforce max price levels per side
        uint256 size = priceList.sizeOf();
        if (size >= MAX_PRICE_LEVELS_PER_SIDE) {
            revert MaxPriceLevelsReached();
        }

        // Find insertion point for sorted order
        // Bids: highest first (descending), Asks: lowest first (ascending)
        if (size == 0) {
            priceList.pushFront(_price);
            return;
        }

        // Iterate through list to find insertion point
        (, uint256 current) = priceList.getNextNode(0); // Get head
        uint256 prev = 0;

        while (current != 0) {
            if (_isBid) {
                // Bids: insert before first price that is smaller
                if (current < _price) {
                    priceList.insertBefore(current, _price);
                    return;
                }
            } else {
                // Asks: insert before first price that is larger
                if (current > _price) {
                    priceList.insertBefore(current, _price);
                    return;
                }
            }
            prev = current;
            (, current) = priceList.getNextNode(current);
        }

        // If we get here, insert at end (after the last element)
        priceList.insertAfter(prev, _price);
    }

    /// @notice Remove a price level from the sorted price list if order queue is empty
    /// @param _price The price level to potentially remove
    /// @param _isBid True for bid (buy) prices, false for ask (sell) prices
    function _removePriceLevelIfEmpty(uint256 _price, bool _isBid) private {
        StructuredLinkedList.List storage orderQueue =
            _isBid ? priceOrdersLongQueue[_price] : priceOrdersShortQueue[_price];

        if (orderQueue.sizeOf() == 0) {
            StructuredLinkedList.List storage priceList = _isBid ? activeBidPrices : activeAskPrices;
            if (priceList.nodeExists(_price)) {
                priceList.remove(_price);
            }
        }
    }

    /// @notice Get the best bid price (highest)
    function getBestBidPrice() public view returns (uint256) {
        if (activeBidPrices.sizeOf() == 0) return 0;
        (, uint256 bestBid) = activeBidPrices.getNextNode(0);
        return bestBid;
    }

    /// @notice Get the best ask price (lowest)
    function getBestAskPrice() public view returns (uint256) {
        if (activeAskPrices.sizeOf() == 0) return 0;
        (, uint256 bestAsk) = activeAskPrices.getNextNode(0);
        return bestAsk;
    }

    /// @notice Simulate an order: how much would match and at what average price (view, no state change).
    /// @param _price Limit price (same as createOrder)
    /// @param _quantity Order quantity (positive = buy, negative = sell)
    /// @return filledQuantity Signed quantity that would be matched (same sign as _quantity)
    /// @return averageFillPrice Volume-weighted average fill price (0 if no fill). Uses same decimals as price.
    /// @return remainingQuantity Signed quantity that would rest on the book or remain unfilled
    function simulateOrder(uint256 _price, int256 _quantity)
        external
        view
        returns (int256 filledQuantity, uint256 averageFillPrice, int256 remainingQuantity)
    {
        if (_quantity == 0) return (0, 0, 0);

        bool isBuy = _quantity > 0;
        int256 remaining = _quantity;
        uint256 totalNotional = 0;
        uint256 totalFilledAbs = 0;
        StructuredLinkedList.List storage oppositePrices = isBuy ? activeAskPrices : activeBidPrices;
        (, uint256 currentPrice) = oppositePrices.getNextNode(0);

        while (currentPrice != 0 && remaining != 0) {
            if (isBuy && currentPrice > _price) break;
            if (!isBuy && currentPrice < _price) break;

            StructuredLinkedList.List storage orderQueue =
                isBuy ? priceOrdersShortQueue[currentPrice] : priceOrdersLongQueue[currentPrice];
            (, uint256 orderIdUint) = orderQueue.getNextNode(0);

            while (orderIdUint != 0 && remaining != 0) {
                Order storage makerOrder = orders[bytes32(orderIdUint)];
                uint256 matchAmt = _min(_abs(makerOrder.quantity), _abs(remaining));
                if (matchAmt > 0) {
                    totalNotional += _calculateValue(makerOrder.price, matchAmt);
                    totalFilledAbs += matchAmt;
                    remaining -= _toSignedQuantity(matchAmt, remaining);
                }
                (, orderIdUint) = orderQueue.getNextNode(orderIdUint);
            }

            (, currentPrice) = oppositePrices.getNextNode(currentPrice);
        }

        remainingQuantity = remaining;
        filledQuantity = _quantity - remainingQuantity;
        if (totalFilledAbs > 0) {
            averageFillPrice = (totalNotional * (10 ** QUANTITY_DECIMALS)) / totalFilledAbs;
        }
    }

    /// @notice Calculate match fee for a participant
    /// @dev Fee is max(notional * feeBps / 10000, liquidationFee) for takers
    /// @param _notionalValue Notional value of the matched trade
    /// @param _isTaker Whether the participant is the taker
    function _calculateMatchFee(uint256 _notionalValue, bool _isTaker) private view returns (int256) {
        int16 feeBps = _isTaker ? takerFeeBps : makerFeeBps;
        int256 fee = (int256(_notionalValue) * int256(feeBps)) / 10_000;

        // Use liquidationFee as minimum fee for taker so every trade covers
        // potential liquidation cost of one party
        if (_isTaker && fee < int256(liquidationFee)) {
            fee = int256(liquidationFee);
        }

        return fee;
    }

    /// @notice Transfer a pre-calculated fee between participant and reserve pool
    /// @param _participant Address of the participant
    /// @param _fee Signed fee amount (positive = participant pays, negative = rebate)
    function _transferFee(address _participant, int256 _fee) private {
        if (_fee > 0) {
            _move(_participant, _insuranceFundAccount(), uint256(_fee));
        } else if (_fee < 0) {
            _move(_insuranceFundAccount(), _participant, uint256(-_fee));
        }
    }

    // ──────────────────────────────────────────────
    // Funding
    // ──────────────────────────────────────────────

    /// @notice Compute the current cumulative funding per unit without writing state
    /// @dev Uses the order-book mid-price as mark price and the oracle as index price.
    ///      If either side of the book is empty, no additional funding accrues.
    /// @return currentCumFunding The theoretical cumulative funding as of block.timestamp
    function _getCurrentCumulativeFunding() private view returns (int256 currentCumFunding) {
        currentCumFunding = cumulativeFundingPerUnit;

        if (lastFundingUpdateTime == 0 || fundingPeriod == 0) return currentCumFunding;

        uint256 timeElapsed = block.timestamp - lastFundingUpdateTime;
        if (timeElapsed == 0) return currentCumFunding;

        // Mark price = order-book mid-price
        uint256 bestBid = getBestBidPrice();
        uint256 bestAsk = getBestAskPrice();
        if (bestBid == 0 || bestAsk == 0) return currentCumFunding;

        uint256 markPrice = (bestBid + bestAsk) / 2;
        uint256 indexPrice = getMarketPrice();

        // fundingRate (scaled by 10^FUNDING_DECIMALS) = (mark - index) * 10^FUNDING_DECIMALS / index
        int256 priceDiff = int256(markPrice) - int256(indexPrice);
        int256 fundingRateScaled = (priceDiff * int256(10 ** FUNDING_DECIMALS)) / int256(indexPrice);

        // Clamp to [-maxRate, maxRate]
        int256 maxRateScaled = (int256(fundingRateMaxBps) * int256(10 ** FUNDING_DECIMALS)) / 10_000;
        if (fundingRateScaled > maxRateScaled) fundingRateScaled = maxRateScaled;
        if (fundingRateScaled < -maxRateScaled) fundingRateScaled = -maxRateScaled;

        // deltaCumFunding (tokenDecimals * 10^FUNDING_DECIMALS) =
        //   fundingRateScaled * indexPrice * timeElapsed / fundingPeriod
        int256 deltaCumFunding = (fundingRateScaled * int256(indexPrice) * int256(timeElapsed)) / int256(fundingPeriod);

        currentCumFunding += deltaCumFunding;
    }

    /// @notice Update the global cumulative funding rate (writes state)
    /// @dev Called before any position-affecting operation.
    function _updateGlobalFunding() private {
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
    function _settleFunding(address _user) private {
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
            uint256 userBalance = balanceOf(_user);
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
            uint256 reserveBalance = balanceOf(_insuranceFundAccount());
            uint256 payout = owed < reserveBalance ? owed : reserveBalance;
            if (payout > 0) {
                _move(_insuranceFundAccount(), _user, payout);
            }
        }

        emit FundingSettled(_user, pendingFunding);
    }

    /// @notice Trigger a funding-rate update (callable by anyone / keepers)
    /// @dev Useful during idle periods to keep the cumulative funding current.
    function updateFunding() external {
        _updateGlobalFunding();
    }

    /// @notice Get the pending (unsettled) funding for a user
    /// @param _user Address of the user
    /// @return pendingFunding Positive = user owes, negative = user receives (in collateral token units)
    function getPendingFunding(address _user) public view returns (int256) {
        Position memory position = positions[_user];
        if (position.netQuantity == 0) return 0;

        int256 currentCumFunding = _getCurrentCumulativeFunding();
        int256 delta = currentCumFunding - userFundingSnapshot[_user];
        if (delta == 0) return 0;

        return (position.netQuantity * delta) / (int256(10 ** QUANTITY_DECIMALS) * int256(10 ** FUNDING_DECIMALS));
    }

    // View functions

    /// @notice Get order details
    function getOrder(bytes32 _orderId) external view returns (Order memory) {
        return orders[_orderId];
    }

    /// @notice Get user's orders
    function getUserOrders(address _user) external view returns (bytes32[] memory) {
        return participantOrderIdsIndex[_user].values();
    }

    /// @notice Get user's net position
    function getUserPosition(address _user) external view returns (Position memory) {
        return positions[_user];
    }

    /// @notice Get all users with positions
    function getUsersWithPositions() external view returns (address[] memory) {
        return usersWithPositions.values();
    }

    /// @notice Get total unrealized PnL for a user (including pending funding)
    function getUnrealizedPnl(address _user) external view returns (int256) {
        Position memory position = positions[_user];
        if (position.netQuantity == 0) return 0;
        int256 pnl = _calculatePositionPnl(position, getMarketPrice());
        // Subtract pending funding (positive funding = user owes = reduces PnL)
        pnl -= getPendingFunding(_user);
        return pnl;
    }

    /// @notice Get order book depth (active price levels)
    /// @param _maxLevels Maximum number of price levels to return per side
    /// @return bidPrices Array of bid prices (highest first)
    /// @return askPrices Array of ask prices (lowest first)
    function getOrderBookPrices(uint256 _maxLevels)
        external
        view
        returns (uint256[] memory bidPrices, uint256[] memory askPrices)
    {
        uint256 bidCount = _min(activeBidPrices.sizeOf(), _maxLevels);
        uint256 askCount = _min(activeAskPrices.sizeOf(), _maxLevels);

        bidPrices = new uint256[](bidCount);
        askPrices = new uint256[](askCount);

        // Get bid prices
        (, uint256 current) = activeBidPrices.getNextNode(0);
        for (uint256 i = 0; i < bidCount && current != 0; i++) {
            bidPrices[i] = current;
            (, current) = activeBidPrices.getNextNode(current);
        }

        // Get ask prices
        (, current) = activeAskPrices.getNextNode(0);
        for (uint256 i = 0; i < askCount && current != 0; i++) {
            askPrices[i] = current;
            (, current) = activeAskPrices.getNextNode(current);
        }

        return (bidPrices, askPrices);
    }

    /// @notice Get total quantity at a specific price level
    /// @param _price The price level
    /// @param _isBid True for bid side, false for ask side
    /// @return totalQuantity The total absolute quantity at this price level
    function getQuantityAtPrice(uint256 _price, bool _isBid) external view returns (uint256 totalQuantity) {
        StructuredLinkedList.List storage orderQueue =
            _isBid ? priceOrdersLongQueue[_price] : priceOrdersShortQueue[_price];

        (, uint256 orderId) = orderQueue.getNextNode(0);
        while (orderId != 0) {
            Order storage order = orders[bytes32(orderId)];
            totalQuantity += _abs(order.quantity);
            (, orderId) = orderQueue.getNextNode(orderId);
        }

        return totalQuantity;
    }

    /// @notice Get the resting-order margin component for a user (position margin excluded).
    ///         Used by the portfolio margin engine for cross-product margin calculation.
    function getOrderMargin(address _user) external view returns (uint256) {
        uint256 buyVal = userBuyOrderValue[_user];
        uint256 sellVal = userSellOrderValue[_user];
        if (buyVal + sellVal == 0) return 0;

        Position memory position = positions[_user];
        uint256 reducingVal;
        if (position.netQuantity != 0) {
            uint256 currentPrice = getMarketPrice();
            uint256 positionValue = _calculateValue(currentPrice, _abs(position.netQuantity));
            if (position.netQuantity > 0) {
                reducingVal = sellVal < positionValue ? sellVal : positionValue;
            } else {
                reducingVal = buyVal < positionValue ? buyVal : positionValue;
            }
        }
        uint256 shock = portfolioMargin.imSpotShock();
        return ((buyVal + sellVal - reducingVal) * shock) / 1e18;
    }

    // Admin functions

    /// @notice Set the price oracle
    function setOracle(AggregatorV3Interface _oracle) external onlyOwner {
        if (address(_oracle) == address(0)) {
            revert InvalidOracle();
        }
        priceOracle = _oracle;
        oracleDecimals = _oracle.decimals();
    }

    /// @notice Set the flat liquidation fee (in collateral token units). Paid per cancelled
    ///         order in `liquidateOrder` (composable via `multicallStopOnFailure`) and per
    ///         closed position in `liquidatePosition`.
    function setLiquidationFee(uint256 _liquidationFee) external onlyOwner {
        liquidationFee = _liquidationFee;
        emit LiquidationFeeUpdated(_liquidationFee);
    }

    /// @notice Set maker and taker fees in basis points
    /// @param _takerFeeBps Taker fee (e.g., 5 = 0.05%)
    /// @param _makerFeeBps Maker fee (e.g., 0 = 0%)
    function setMatchFee(int16 _takerFeeBps, int16 _makerFeeBps) external onlyOwner {
        takerFeeBps = _takerFeeBps;
        makerFeeBps = _makerFeeBps;
        emit MatchFeeUpdated(_takerFeeBps, _makerFeeBps);
    }

    /// @notice Set minimum margin per resting order (in collateral token units)
    /// @param _minimumMarginPerOrder Minimum margin locked per resting order (0 = no minimum)
    function setMinimumMarginPerOrder(uint256 _minimumMarginPerOrder) external onlyOwner {
        minimumMarginPerOrder = _minimumMarginPerOrder;
        emit MinimumMarginPerOrderUpdated(_minimumMarginPerOrder);
    }

    /// @notice Set funding rate parameters
    /// @param _fundingRateMaxBps Max absolute funding rate per period in basis points (e.g., 100 = 1%)
    /// @param _fundingPeriod Time period for max funding rate in seconds (e.g., 86400 = 24 hours)
    function setFundingParameters(uint256 _fundingRateMaxBps, uint256 _fundingPeriod) external onlyOwner {
        if (_fundingPeriod == 0) {
            revert InvalidFundingParameters();
        }

        // Settle any accrued funding before changing parameters
        _updateGlobalFunding();

        fundingRateMaxBps = _fundingRateMaxBps;
        fundingPeriod = _fundingPeriod;

        // Initialize timestamp on first call to prevent retroactive accrual
        if (lastFundingUpdateTime == 0) {
            lastFundingUpdateTime = block.timestamp;
        }

        emit FundingParametersUpdated(_fundingRateMaxBps, _fundingPeriod);
    }

    /// @notice Reset all trading state (orders, positions, funding, nonce)
    /// @dev Intended for testnet use to wipe state without redeploying. ERC20 balances are not touched.
    function resetState() external onlyOwner {
        // Clear all bid orders and price levels
        (, uint256 price) = activeBidPrices.getNextNode(0);
        while (price != 0) {
            (, uint256 nextPrice) = activeBidPrices.getNextNode(price);
            _clearPriceLevelOrders(price, true);
            activeBidPrices.remove(price);
            price = nextPrice;
        }

        // Clear all ask orders and price levels
        (, price) = activeAskPrices.getNextNode(0);
        while (price != 0) {
            (, uint256 nextPrice) = activeAskPrices.getNextNode(price);
            _clearPriceLevelOrders(price, false);
            activeAskPrices.remove(price);
            price = nextPrice;
        }

        // Clear all positions and per-user funding snapshots
        address[] memory users = usersWithPositions.values();
        for (uint256 i = 0; i < users.length; i++) {
            delete userFundingSnapshot[users[i]];
            delete positions[users[i]];
            usersWithPositions.remove(users[i]);
        }

        cumulativeFundingPerUnit = 0;
        lastFundingUpdateTime = 0;
        // nonce = 0;
        emit LiquidationFeeUpdated(liquidationFee);
        emit MatchFeeUpdated(takerFeeBps, makerFeeBps);
        emit MinimumMarginPerOrderUpdated(minimumMarginPerOrder);
        emit FundingParametersUpdated(fundingRateMaxBps, fundingPeriod);
        emit MarginPercentUpdated(marginPercent);
        emit MaintenanceMarginPercentUpdated(maintenanceMarginPercent);
    }

    /// @notice Clear all orders at a single price level and remove them from participant indexes
    function _clearPriceLevelOrders(uint256 _price, bool _isBid) private {
        StructuredLinkedList.List storage queue = _isBid ? priceOrdersLongQueue[_price] : priceOrdersShortQueue[_price];
        (, uint256 orderIdUint) = queue.getNextNode(0);
        while (orderIdUint != 0) {
            (, uint256 nextOrderIdUint) = queue.getNextNode(orderIdUint);
            bytes32 orderId = bytes32(orderIdUint);
            address participant = orders[orderId].participant;
            participantOrderIdsIndex[participant].remove(orderId);
            delete _getOrderValue(_isBid)[participant];
            delete orders[orderId];
            queue.remove(orderIdUint);
            orderIdUint = nextOrderIdUint;
        }
    }

    /// @notice Scale a value from one decimal precision to another
    function _scaleDecimals(uint256 _value, uint8 _fromDecimals, uint8 _toDecimals) private pure returns (uint256) {
        if (_fromDecimals > _toDecimals) {
            return _value / (10 ** (_fromDecimals - _toDecimals));
        } else if (_fromDecimals < _toDecimals) {
            return _value * (10 ** (_toDecimals - _fromDecimals));
        }
        return _value;
    }

    /// @notice Round a value to the nearest multiple of an increment
    function _roundToNearest(uint256 _value, uint256 _increment) private pure returns (uint256) {
        return (_value + _increment / 2) / _increment * _increment;
    }

    /// @notice Decimals of the underlying collateral token (mirrors the vault).
    function decimals() public view returns (uint8) {
        return IERC20Metadata(address(vault)).decimals();
    }
}
