//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { StructuredLinkedList } from "solidity-linked-list/contracts/StructuredLinkedList.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import { AggregatorV3Interface } from "./AggregatorV3Interface.sol";
// import { console } from "hardhat/console.sol";

/// @title PerpsSimple
/// @notice Simple perpetual trading contract with on-chain order book
/// @dev Positions are created between two users when orders match
/// @dev TODO: Add support for partial liquidation
/// @dev TODO: when not enough reserve pool, the user should be able to get revenue
/// @dev on their collateral balance and withdraw later when collateral is added
contract PerpsSimple is Initializable, UUPSUpgradeable, OwnableUpgradeable, ERC20Upgradeable {
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

    // State variables
    IERC20 public collateralToken;
    AggregatorV3Interface public priceOracle;
    uint8 public marginPercent; // Initial margin requirement as percentage (e.g., 10 = 10%)
    uint8 public maintenanceMarginPercent; // Maintenance margin percentage (e.g., 5 = 5%)
    uint256 public liquidationFee; // Liquidation fee in collateral token units
    uint8 private tokenDecimals;
    uint8 private oracleDecimals;
    uint256 private nonce; // Nonce for order IDs

    // Order book mappings
    mapping(bytes32 => Order) private orders;
    mapping(uint256 => StructuredLinkedList.List) private priceOrdersLongQueue; // FIFO queue of long orders by price
    mapping(uint256 => StructuredLinkedList.List) private priceOrdersShortQueue; // FIFO queue of short orders by price
    mapping(address => EnumerableSet.Bytes32Set) private participantOrderIdsIndex; // Orders by participant
    mapping(address => uint256) private userTotalOrderValue; // Cached total order value per user

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
    // TODO: expose average fill price for the order or connect it with the trade event
    event OrderFilled(bytes32 indexed orderId, address indexed participant);
    event OrderCancelled(bytes32 indexed orderId, address indexed participant);
    event OrderUpdated(bytes32 indexed orderId, address indexed participant, int256 newQuantity);
    event OrderMatched(
        bytes32 indexed makerOrderId, address indexed buyer, address indexed seller, uint256 price, uint256 quantity
    );
    event PositionTrade(
        address indexed user,
        uint256 tradePrice,
        int256 quantity,
        int256 netQuantityAfter,
        uint256 aggregatedEntryPriceAfter,
        int256 realizedPnl
    );
    event CollateralAdded(address indexed user, uint256 amount);
    event CollateralRemoved(address indexed user, uint256 amount);
    event MatchFeeUpdated(int16 newTakerFeeBps, int16 newMakerFeeBps);
    event MarginPercentUpdated(uint8 newMarginPercent);
    event MaintenanceMarginPercentUpdated(uint8 newMaintenanceMarginPercent);
    event LiquidationFeeUpdated(uint256 newLiquidationFee);
    event PositionLiquidated(
        address indexed user, address indexed liquidator, int256 positionSize, int256 pnl, uint256 liquidatorFee
    );
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
    error InsufficientReservePool(); // The reserve pool does not have enough collateral to cover user profit
    error InvalidFundingParameters();
    error OrderMarginTooLow(); // Order margin is below minimumMarginPerOrder
    error MaxPriceLevelsReached(); // Too many active price levels on one side of the book

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(uint256 _minimumPriceIncrement) {
        _disableInitializers();
        if (_minimumPriceIncrement == 0) {
            revert InvalidPrice();
        }
        minimumPriceIncrement = _minimumPriceIncrement;
    }

    /// @notice Initialize the contract
    /// @param _collateralToken The ERC20 token used for collateral
    /// @param _priceOracle The Chainlink-style price oracle
    /// @param _marginPercent Initial margin requirement percentage (e.g., 10 = 10%)
    /// @param _maintenanceMarginPercent Maintenance margin percentage (e.g., 5 = 5%), must be < marginPercent
    function initialize(
        IERC20Metadata _collateralToken,
        AggregatorV3Interface _priceOracle,
        uint8 _marginPercent,
        uint8 _maintenanceMarginPercent
    ) external initializer {
        if (address(_priceOracle) == address(0)) {
            revert InvalidOracle();
        }
        if (_marginPercent == 0 || _marginPercent > 100) {
            revert InvalidMarginPercent();
        }
        if (_maintenanceMarginPercent == 0 || _maintenanceMarginPercent >= _marginPercent) {
            revert InvalidMarginPercent();
        }

        __ERC20_init(
            string.concat("PerpsSimple ", _collateralToken.symbol()), string.concat("p", _collateralToken.symbol())
        );
        __Ownable_init(_msgSender());
        __UUPSUpgradeable_init();

        collateralToken = _collateralToken;
        priceOracle = _priceOracle;
        tokenDecimals = _collateralToken.decimals();
        oracleDecimals = _priceOracle.decimals();
        marginPercent = _marginPercent;
        maintenanceMarginPercent = _maintenanceMarginPercent;
    }

    /// @notice Authorize upgrade (only owner)
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner { }

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
        _updateGlobalFunding();
        _validateQuantity(_quantity);
        _validatePrice(_price);

        // Settle taker's funding once before matching so per-match _updateUserPosition
        // calls can skip it (cumulativeFundingPerUnit is constant within this tx).
        _settleFunding(_msgSender());

        bool isBuy = _quantity > 0;
        int256 remainingQuantity = _quantity;

        remainingQuantity = _matchWithOppositeOrders(_msgSender(), _price, remainingQuantity);

        if (remainingQuantity != 0) {
            // Validate minimum margin per resting order
            if (minimumMarginPerOrder > 0) {
                uint256 restingValue = _calculateValue(_price, _abs(remainingQuantity));
                uint256 restingMargin = (restingValue * marginPercent) / 100;
                if (restingMargin < minimumMarginPerOrder) {
                    revert OrderMarginTooLow();
                }
            }

            EnumerableSet.Bytes32Set storage participantOrders = participantOrderIdsIndex[_msgSender()];
            if (participantOrders.length() >= MAX_ORDERS_PER_PARTICIPANT) {
                revert MaxOrdersPerParticipantReached();
            }

            StructuredLinkedList.List storage orderQueue = _priceOrderIds(_price, isBuy);

            bytes32 orderId = _createOrder(_msgSender(), _price, remainingQuantity);
            orderQueue.pushBack(uint256(orderId));
            participantOrders.add(orderId);

            // Add price level to sorted list
            _addPriceLevel(_price, isBuy);
        }

        // Check margin requirement
        _ensureSufficientMargin(_msgSender());
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
        uint256 matchAmt = _min(_abs(_makerOrder.quantity), _abs(_remainingQty));
        int256 matchQty = _toSignedQuantity(matchAmt, _remainingQty);
        uint256 notionalValue = _calculateValue(makerPrice, matchAmt);

        _createPosition(_makerOrderId, makerParticipant, _taker, makerPrice, matchQty, _taker);

        // Charge fees at match time
        _chargeMatchFee(_taker, notionalValue, true); // taker fee
        _chargeMatchFee(makerParticipant, notionalValue, false); // maker fee

        // Update cached order value
        userTotalOrderValue[makerParticipant] -= notionalValue;
        _makerOrder.quantity = _reduceQuantity(_makerOrder.quantity, matchAmt);

        if (_makerOrder.quantity == 0) {
            emit OrderFilled(_makerOrderId, makerParticipant);
            // Maker is a bid when the taker is selling (_remainingQty < 0).
            _removeOrder(_makerOrderId, makerParticipant, makerPrice, _remainingQty < 0);
        } else {
            emit OrderUpdated(_makerOrderId, makerParticipant, _makerOrder.quantity);
        }

        return _remainingQty - matchQty;
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
        userTotalOrderValue[order.participant] -= _calculateValue(order.price, _abs(order.quantity));
        _removeOrder(_orderId, order.participant, order.price, isBid);
        _removePriceLevelIfEmpty(order.price, isBid);
        emit OrderCancelled(_orderId, order.participant);
    }

    /// @notice Remove an order from the book (internal)
    /// @dev Callers are responsible for updating userTotalOrderValue before this call.
    function _removeOrder(bytes32 _orderId, address _participant, uint256 _price, bool _isBid) private {
        _priceOrderIds(_price, _isBid).remove(uint256(_orderId));
        participantOrderIdsIndex[_participant].remove(_orderId);
        delete orders[_orderId];
    }

    /// @notice Create a new order
    function _createOrder(address _participant, uint256 _price, int256 _quantity) private returns (bytes32) {
        bytes32 orderId = keccak256(abi.encode(_participant, _price, _quantity, block.timestamp, nonce++));
        orders[orderId] = Order({ participant: _participant, price: _price, quantity: _quantity });

        // Update cached total order value for user
        userTotalOrderValue[_participant] += _calculateValue(_price, _abs(_quantity));

        emit OrderCreated(orderId, _participant, _price, _quantity);
        return orderId;
    }

    /// @notice Update net positions when orders match
    /// @param _taker Address of the taker whose funding was already settled before the matching loop
    function _createPosition(
        bytes32 matchedOrderId,
        address makerParticipant,
        address _otherParticipant,
        uint256 _price,
        int256 _quantity,
        address _taker
    ) private {
        // Determine buyer and seller based on quantity sign
        // Positive quantity = taker is buying, negative = taker is selling
        (address buyer, address seller) = _quantity > 0
            ? (_otherParticipant, makerParticipant)
            : (makerParticipant, _otherParticipant);

        // Use absolute quantity for position updates
        // Buyer always gets positive (long), seller always gets negative (short)
        int256 absQty = int256(_abs(_quantity));

        emit OrderMatched(matchedOrderId, buyer, seller, _price, uint256(absQty));

        // Skip funding settlement for the taker — already settled once before the loop.
        if (buyer != _taker) _settleFunding(buyer);
        _updateUserPosition(buyer, absQty, _price);

        if (seller != _taker) _settleFunding(seller);
        _updateUserPosition(seller, -absQty, _price);
    }

    /// @notice Update a user's net position with aggregated entry price
    function _updateUserPosition(address _user, int256 _quantity, uint256 _tradePrice) private {
        // Settle any pending funding at the old position size before changing it.

        Position storage position = positions[_user];
        int256 newNetQuantity = position.netQuantity + _quantity;
        uint256 absQuantity = _abs(_quantity);

        // If no existing position, initialize it
        if (position.netQuantity == 0) {
            position.netQuantity = _quantity;
            position.aggregatedEntryPrice = _tradePrice;
            usersWithPositions.add(_user);
            // Sync funding snapshot for the new position
            userFundingSnapshot[_user] = cumulativeFundingPerUnit;

            emit PositionTrade(_user, _tradePrice, _quantity, newNetQuantity, position.aggregatedEntryPrice, 0);
            return;
        }

        uint256 oldAbsQuantity = _abs(position.netQuantity);
        int256 priceDiff = int256(_tradePrice) - int256(position.aggregatedEntryPrice);

        // Same direction - add to position with weighted average entry price
        if (_isSameSign(position.netQuantity, _quantity)) {
            uint256 newAbsQuantity = _abs(newNetQuantity);

            // Weighted average: (oldQty * oldPrice + newQty * newPrice) / totalQty
            uint256 oldValue = oldAbsQuantity * position.aggregatedEntryPrice;
            uint256 newValue = absQuantity * _tradePrice;
            position.aggregatedEntryPrice = (oldValue + newValue) / newAbsQuantity;
            position.netQuantity = newNetQuantity;

            emit PositionTrade(_user, _tradePrice, _quantity, newNetQuantity, position.aggregatedEntryPrice, 0);
            return;
        }

        // Opposite direction: settle the reduced part, then open remainder (if any) in opposite side
        uint256 settledAbs = absQuantity < oldAbsQuantity ? absQuantity : oldAbsQuantity;
        int256 settledQuantity = _toSignedQuantity(settledAbs, position.netQuantity);
        int256 pnl = _settleReducedPosition(_user, priceDiff, settledQuantity);
        uint256 remainingAbs = absQuantity - settledAbs;

        if (remainingAbs > 0) {
            // Flip: emit close then open opposite
            uint256 entryPriceBefore = position.aggregatedEntryPrice;
            position.netQuantity = _toSignedQuantity(remainingAbs, _quantity);
            position.aggregatedEntryPrice = _tradePrice;
            userFundingSnapshot[_user] = cumulativeFundingPerUnit;
            emit PositionTrade(_user, _tradePrice, settledQuantity, 0, entryPriceBefore, pnl);
            emit PositionTrade(_user, _tradePrice, position.netQuantity, position.netQuantity, _tradePrice, 0);
        } else if (newNetQuantity == 0) {
            emit PositionTrade(_user, _tradePrice, settledQuantity, 0, position.aggregatedEntryPrice, pnl);
            delete positions[_user];
            usersWithPositions.remove(_user);
        } else {
            position.netQuantity = newNetQuantity;
            emit PositionTrade(_user, _tradePrice, _quantity, newNetQuantity, position.aggregatedEntryPrice, pnl);
        }
    }

    /// @notice Add collateral to account
    /// @param _amount Amount of collateral to add
    function addCollateral(uint256 _amount) public {
        _updateGlobalFunding();
        if (_amount == 0) {
            revert InvalidSize();
        }

        collateralToken.safeTransferFrom(_msgSender(), address(this), _amount);
        _mint(_msgSender(), _amount);

        emit CollateralAdded(_msgSender(), _amount);
    }

    /// @notice Add collateral to account using ERC-2612 permit (approve + deposit in one tx)
    /// @param _amount Amount of collateral to add
    /// @param _deadline Permit signature deadline
    /// @param _v Permit signature v
    /// @param _r Permit signature r
    /// @param _s Permit signature s
    function addCollateralWithPermit(uint256 _amount, uint256 _deadline, uint8 _v, bytes32 _r, bytes32 _s) external {
        IERC20Permit(address(collateralToken)).permit(_msgSender(), address(this), _amount, _deadline, _v, _r, _s);
        addCollateral(_amount);
    }

    /// @notice Remove collateral from account
    /// @param _amount Amount of collateral to remove
    function removeCollateral(uint256 _amount) external {
        _updateGlobalFunding();
        if (_amount == 0) {
            revert InvalidSize();
        }

        if (balanceOf(_msgSender()) < _amount) {
            revert InsufficientCollateral();
        }

        // Check margin requirement
        uint256 requiredMargin = getRequiredMargin(_msgSender());
        uint256 remainingCollateral = balanceOf(_msgSender()) - _amount;
        if (remainingCollateral < requiredMargin) {
            revert InsufficientMargin();
        }

        _burn(_msgSender(), _amount);
        collateralToken.safeTransfer(_msgSender(), _amount);

        emit CollateralRemoved(_msgSender(), _amount);
    }

    /// @notice Get maintenance margin requirement for a user
    /// @param _user Address of the user
    /// @return Required maintenance margin amount
    function getMaintenanceMargin(address _user) public view returns (uint256) {
        // Margin for open orders (use initial margin for orders)
        uint256 totalMargin = (userTotalOrderValue[_user] * marginPercent) / 100;

        // Maintenance margin for net position
        Position memory position = positions[_user];
        if (position.netQuantity != 0) {
            uint256 currentPrice = getMarketPrice();
            uint256 positionValue = _calculateValue(currentPrice, _abs(position.netQuantity));
            uint256 requiredMarginForPosition = (positionValue * maintenanceMarginPercent) / 100;

            // Add unrealized loss to margin requirement
            int256 unrealizedPnl = _calculatePositionPnl(position, currentPrice);
            if (unrealizedPnl < 0) {
                requiredMarginForPosition += uint256(-unrealizedPnl);
            }

            // Add pending funding owed to margin requirement
            int256 pendingFunding = getPendingFunding(_user);
            if (pendingFunding > 0) {
                requiredMarginForPosition += uint256(pendingFunding);
            }

            totalMargin += requiredMarginForPosition;
        }

        return totalMargin;
    }

    /// @notice Check if a user's position can be liquidated
    /// @param _user Address of the user
    /// @return True if the user can be liquidated
    function isLiquidatable(address _user) public view returns (bool) {
        Position memory position = positions[_user];
        if (position.netQuantity == 0) return false;

        uint256 maintenanceMargin = getMaintenanceMargin(_user);
        return balanceOf(_user) < maintenanceMargin;
    }

    /// @notice Liquidate an underwater position
    /// @param _user Address of the user to liquidate
    /// @dev TODO: make partial liquidation
    function liquidate(address _user) external {
        // Update global funding and settle user's pending funding before liquidation
        _updateGlobalFunding();
        _settleFunding(_user);

        if (!isLiquidatable(_user)) {
            revert NotLiquidatable();
        }

        Position memory position = positions[_user];
        uint256 currentPrice = getMarketPrice();

        // Calculate PnL at current market price
        int256 pnl = _calculatePositionPnl(position, currentPrice);

        // Liquidator fee in collateral token units
        uint256 liquidatorFee = liquidationFee;

        // Settle PnL
        if (pnl < 0) {
            // User has losses - transfer from user to reserve pool
            uint256 loss = uint256(-pnl);
            uint256 userBalance = balanceOf(_user);
            uint256 transferAmount = loss < userBalance ? loss : userBalance;
            if (transferAmount > 0) {
                _transfer(_user, address(this), transferAmount);
            }
            if (transferAmount < loss) {
                emit BadDebt(_user, loss - transferAmount);
            }
        } else if (pnl > 0) {
            // User has profits despite being underwater (shouldn't happen often)
            uint256 profit = uint256(pnl);
            if (balanceOf(address(this)) >= profit) {
                _transfer(address(this), _user, profit);
            }
        }

        // Pay liquidator fee from user's remaining balance or reserve pool
        if (liquidatorFee > 0) {
            uint256 userBalance = balanceOf(_user);
            if (userBalance >= liquidatorFee) {
                _transfer(_user, _msgSender(), liquidatorFee);
            } else {
                // Pay what user has, rest from reserve if available
                if (userBalance > 0) {
                    _transfer(_user, _msgSender(), userBalance);
                    liquidatorFee = userBalance;
                } else {
                    liquidatorFee = 0;
                }
            }
        }

        // Clear the position
        int256 closedQuantity = position.netQuantity;
        delete positions[_user];
        usersWithPositions.remove(_user);

        emit PositionLiquidated(_user, _msgSender(), closedQuantity, pnl, liquidatorFee);
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
            // User profits - transfer from reserve pool to user
            uint256 profit = uint256(pnl);

            // Ensure reserve pool has enough to cover the profit
            if (balanceOf(address(this)) < profit) {
                revert InsufficientReservePool();
            }

            _transfer(address(this), _user, profit);
        } else if (pnl < 0) {
            // User loses - transfer from user to reserve pool
            uint256 loss = uint256(-pnl);
            if (balanceOf(_user) >= loss) {
                _transfer(_user, address(this), loss);
            } else {
                // Not enough balance - transfer what's available
                uint256 available = balanceOf(_user);
                if (available > 0) {
                    _transfer(_user, address(this), available);
                }
                // Remaining loss is absorbed (user doesn't have enough collateral)
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

    /// @notice Get required margin for a user
    /// @param _user Address of the user
    /// @return Required margin amount
    function getRequiredMargin(address _user) public view returns (uint256) {
        // Margin for open orders
        uint256 totalMargin = (userTotalOrderValue[_user] * marginPercent) / 100;

        // Margin for net position
        Position memory position = positions[_user];
        if (position.netQuantity != 0) {
            uint256 currentPrice = getMarketPrice();
            uint256 positionValue = _calculateValue(currentPrice, _abs(position.netQuantity));
            uint256 requiredMarginForPosition = (positionValue * marginPercent) / 100;

            // Add unrealized loss to margin requirement
            int256 unrealizedPnl = _calculatePositionPnl(position, currentPrice);
            if (unrealizedPnl < 0) {
                requiredMarginForPosition += uint256(-unrealizedPnl);
            }

            // Add pending funding owed to margin requirement
            int256 pendingFunding = getPendingFunding(_user);
            if (pendingFunding > 0) {
                requiredMarginForPosition += uint256(pendingFunding);
            }

            totalMargin += requiredMarginForPosition;
        }

        return totalMargin;
    }

    /// @notice Ensure user has sufficient margin
    function _ensureSufficientMargin(address _user) private view {
        uint256 requiredMargin = getRequiredMargin(_user);
        if (balanceOf(_user) < requiredMargin) {
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

    /// @notice Charge match fee to a participant (maker or taker)
    /// @dev Fee is max(notional * feeBps / 10000, liquidationFee) — the liquidation fee
    ///      acts as a floor to ensure every trade covers potential liquidation costs
    /// @param _participant Address of the participant
    /// @param _notionalValue Notional value of the matched trade
    /// @param _isTaker Whether the participant is the taker
    function _chargeMatchFee(address _participant, uint256 _notionalValue, bool _isTaker) private {
        int16 feeBps = _isTaker ? takerFeeBps : makerFeeBps;
        int256 fee = (int256(_notionalValue) * int256(feeBps)) / 10_000;

        // Use liquidationFee as minimum fee for taker so every trade covers
        // potential liquidation cost of one party
        if (_isTaker && fee < int256(liquidationFee)) {
            fee = int256(liquidationFee);
        }

        if (fee > 0) {
            _transfer(_participant, address(this), uint256(fee));
        } else if (fee < 0) {
            _transfer(address(this), _participant, uint256(-fee));
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
            // User owes funding – transfer from user to reserve pool
            uint256 owed = uint256(pendingFunding);
            uint256 userBalance = balanceOf(_user);
            if (userBalance >= owed) {
                _transfer(_user, address(this), owed);
            } else {
                // Pay what the user has; remainder becomes implicit bad debt
                // (user will likely be liquidated soon)
                if (userBalance > 0) {
                    _transfer(_user, address(this), userBalance);
                }
                emit BadDebt(_user, owed - userBalance);
            }
        } else {
            // User receives funding – transfer from reserve pool to user
            uint256 owed = uint256(-pendingFunding);
            uint256 reserveBalance = balanceOf(address(this));
            uint256 payout = owed < reserveBalance ? owed : reserveBalance;
            if (payout > 0) {
                _transfer(address(this), _user, payout);
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

    // Admin functions

    /// @notice Set the price oracle
    function setOracle(AggregatorV3Interface _oracle) external onlyOwner {
        if (address(_oracle) == address(0)) {
            revert InvalidOracle();
        }
        priceOracle = _oracle;
        oracleDecimals = _oracle.decimals();
    }

    /// @notice Set the margin requirement percentage
    function setMarginPercent(uint8 _marginPercent) external onlyOwner {
        if (_marginPercent == 0 || _marginPercent > 100) {
            revert InvalidMarginPercent();
        }
        if (_marginPercent <= maintenanceMarginPercent) {
            revert InvalidMarginPercent();
        }
        marginPercent = _marginPercent;
        emit MarginPercentUpdated(_marginPercent);
    }

    /// @notice Set the maintenance margin requirement percentage
    function setMaintenanceMarginPercent(uint8 _maintenanceMarginPercent) external onlyOwner {
        if (_maintenanceMarginPercent == 0 || _maintenanceMarginPercent >= marginPercent) {
            revert InvalidMarginPercent();
        }
        maintenanceMarginPercent = _maintenanceMarginPercent;
        emit MaintenanceMarginPercentUpdated(_maintenanceMarginPercent);
    }

    /// @notice Set the liquidation fee (in collateral token units)
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

    /// @notice Deposit to reserve pool
    function depositReservePool(uint256 _amount) external {
        _mint(address(this), _amount);
        collateralToken.safeTransferFrom(_msgSender(), address(this), _amount);
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
        nonce = 0;
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
            userTotalOrderValue[participant] = 0;
            delete orders[orderId];
            queue.remove(orderIdUint);
            orderIdUint = nextOrderIdUint;
        }
    }

    /// @notice Withdraw from reserve pool
    function withdrawReservePool(uint256 _amount) external onlyOwner {
        if (_amount > balanceOf(address(this))) {
            revert InsufficientReservePool();
        }
        _burn(address(this), _amount);
        collateralToken.safeTransfer(_msgSender(), _amount);
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

    /// @notice Get ERC20 decimals
    function decimals() public view override returns (uint8) {
        return tokenDecimals;
    }
}
