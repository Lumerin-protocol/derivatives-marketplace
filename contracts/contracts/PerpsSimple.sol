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
import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import { AggregatorV3Interface } from "./AggregatorV3Interface.sol";

/// @title PerpsSimple
/// @notice Simple perpetual trading contract with on-chain order book
/// @dev Positions are created between two users when orders match
/// @dev TODO: Add support for partial liquidation
contract PerpsSimple is Initializable, UUPSUpgradeable, OwnableUpgradeable, ERC20Upgradeable {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using EnumerableSet for EnumerableSet.AddressSet;
    using StructuredLinkedList for StructuredLinkedList.List;

    // Constants
    uint256 private constant MAX_ORACLE_STALENESS = 3600; // 1 hour
    uint8 public constant MAX_ORDERS_PER_PARTICIPANT = 100;
    uint8 public constant QUANTITY_DECIMALS = 6;
    uint256 public immutable minimumPriceIncrement; // Minimum price increment for orders

    // State variables
    IERC20 public collateralToken;
    AggregatorV3Interface public priceOracle;
    uint8 public marginPercent; // Initial margin requirement as percentage (e.g., 10 = 10%)
    uint8 public maintenanceMarginPercent; // Maintenance margin percentage (e.g., 5 = 5%)
    uint256 public liquidationFee; // Liquidation fee in collateral token units
    uint8 private tokenDecimals;
    uint8 private oracleDecimals;
    uint256 public orderFee; // Fee for creating an order
    uint256 private nonce = 0; // Nonce for order IDs

    // Order book mappings
    mapping(bytes32 => Order) private orders;
    mapping(uint256 => StructuredLinkedList.List) private priceOrdersLongQueue; // FIFO queue of long orders by price
    mapping(uint256 => StructuredLinkedList.List) private priceOrdersShortQueue; // FIFO queue of short orders by price
    mapping(address => EnumerableSet.Bytes32Set) private participantOrderIdsIndex; // Orders by participant
    mapping(address => mapping(uint256 => EnumerableSet.Bytes32Set)) private participantPriceOrderIdsIndex; // Orders by participant and price
    mapping(address => uint256) private userTotalOrderValue; // Cached total order value per user

    // Price level tracking for limit order matching
    StructuredLinkedList.List private activeBidPrices; // Sorted bid prices (highest first)
    StructuredLinkedList.List private activeAskPrices; // Sorted ask prices (lowest first)

    // Position mappings - net position per user
    mapping(address => Position) private positions; // Net position per user
    EnumerableSet.AddressSet private usersWithPositions; // Users with active positions

    // Reserve and fees
    uint256 public reservePoolBalance;
    uint256 public collectedFeesBalance;

    /// @notice Represents an order in the order book
    struct Order {
        address participant;
        uint256 price; // Order price
        int256 quantity; // Order quantity (positive = long/buy, negative = short/sell)
        uint256 createdAt;
    }

    /// @notice Represents a user's net position
    struct Position {
        int256 netQuantity; // Net position quantity (positive = long, negative = short)
        uint256 aggregatedEntryPrice; // Weighted average entry price
    }

    // Events
    event OrderCreated(bytes32 indexed orderId, address indexed participant, uint256 price, int256 quantity);
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
        uint256 aggregatedEntryPriceAfter
    );
    event PositionClosed(address indexed user, int256 quantityClosed, int256 pnl);
    event CollateralAdded(address indexed user, uint256 amount);
    event CollateralRemoved(address indexed user, uint256 amount);
    event OrderFeeUpdated(uint256 newFee);
    event MarginPercentUpdated(uint8 newMarginPercent);
    event MaintenanceMarginPercentUpdated(uint8 newMaintenanceMarginPercent);
    event LiquidationFeeUpdated(uint256 newLiquidationFee);
    event PositionLiquidated(
        address indexed user, address indexed liquidator, int256 positionSize, int256 pnl, uint256 liquidatorFee
    );

    // Errors
    error InvalidPrice();
    error InvalidSize();
    error InsufficientMargin();
    error InsufficientCollateral();
    error OracleStale();
    error NoPosition();
    error InvalidOracle();
    error InvalidMarginPercent();
    error OrderNotBelongToSender();
    error MaxOrdersPerParticipantReached();
    error NotLiquidatable();
    error InsufficientReservePool();

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

    /// @notice Create an order (buy or sell) with limit price matching
    /// @param _price Limit price (must be multiple of minimumPriceIncrement)
    /// @param _quantity Order quantity (positive = long/buy, negative = short/sell)
    /// @dev Buy orders match with asks at or below the limit price
    /// @dev Sell orders match with bids at or above the limit price
    function createOrder(uint256 _price, int256 _quantity) external {
        _validateQuantity(_quantity);
        _validatePrice(_price);

        bool isBuy = _quantity > 0;

        // Track remaining quantity to be placed/matched
        int256 remainingQuantity = _quantity;

        // First, offset user's own opposite orders that would match
        remainingQuantity = _offsetUserOppositeOrders(_msgSender(), _price, remainingQuantity, isBuy);

        // Match with opposite orders using limit price logic
        remainingQuantity = _matchWithOppositeOrders(_msgSender(), _price, remainingQuantity, isBuy);

        // If there's remaining quantity, add order to book
        if (remainingQuantity != 0) {
            EnumerableSet.Bytes32Set storage participantOrders = participantOrderIdsIndex[_msgSender()];
            if (participantOrders.length() >= MAX_ORDERS_PER_PARTICIPANT) {
                revert MaxOrdersPerParticipantReached();
            }

            StructuredLinkedList.List storage orderQueue = _priceOrderIds(_price, isBuy);
            EnumerableSet.Bytes32Set storage userOrderIdsAtPrice = participantPriceOrderIdsIndex[_msgSender()][_price];

            bytes32 orderId = _createOrder(_msgSender(), _price, remainingQuantity);
            orderQueue.pushBack(uint256(orderId));
            participantOrders.add(orderId);
            userOrderIdsAtPrice.add(orderId);

            // Add price level to sorted list
            _addPriceLevel(_price, isBuy);
        }

        // Pay order fee
        _payOrderFee(_msgSender());

        // Check margin requirement
        _ensureSufficientMargin(_msgSender());
    }

    /// @notice Offset user's own opposite orders that would match at limit price
    /// @return remainingQuantity The remaining quantity after offsetting
    function _offsetUserOppositeOrders(address _user, uint256 _limitPrice, int256 _quantity, bool _isBuy)
        private
        returns (int256 remainingQuantity)
    {
        remainingQuantity = _quantity;

        StructuredLinkedList.List storage oppositePrices = _isBuy ? activeAskPrices : activeBidPrices;
        if (oppositePrices.sizeOf() == 0) return remainingQuantity;

        (, uint256 currentPrice) = oppositePrices.getNextNode(0);

        while (currentPrice != 0 && remainingQuantity != 0) {
            if (_isBuy && currentPrice > _limitPrice) break;
            if (!_isBuy && currentPrice < _limitPrice) break;

            remainingQuantity = _offsetOrdersAtPrice(_user, currentPrice, remainingQuantity);
            (, currentPrice) = oppositePrices.getNextNode(currentPrice);
        }

        return remainingQuantity;
    }

    /// @notice Offset user's orders at a specific price level
    function _offsetOrdersAtPrice(address _user, uint256 _price, int256 _remainingQty) private returns (int256) {
        EnumerableSet.Bytes32Set storage userOrdersAtPrice = participantPriceOrderIdsIndex[_user][_price];

        for (uint256 i = userOrdersAtPrice.length(); i > 0 && _remainingQty != 0; i--) {
            bytes32 orderId = userOrdersAtPrice.at(i - 1);
            Order storage order = orders[orderId];

            if (_isOppositeSign(order.quantity, _remainingQty)) {
                uint256 offsetAmt = _min(_abs(order.quantity), _abs(_remainingQty));

                // Update cached order value
                userTotalOrderValue[_user] -= _calculateValue(order.price, offsetAmt);

                order.quantity = _reduceQuantity(order.quantity, offsetAmt);
                _remainingQty = _reduceQuantity(_remainingQty, offsetAmt);

                if (order.quantity == 0) {
                    _removeOrder(orderId, order);
                    emit OrderFilled(orderId, _user);
                } else {
                    emit OrderUpdated(orderId, _user, order.quantity);
                }
            }
        }

        return _remainingQty;
    }

    /// @notice Match incoming order with opposite orders using limit price logic
    /// @return remainingQuantity The remaining quantity after matching
    function _matchWithOppositeOrders(address _taker, uint256 _limitPrice, int256 _quantity, bool _isBuy)
        private
        returns (int256 remainingQuantity)
    {
        remainingQuantity = _quantity;

        StructuredLinkedList.List storage oppositePrices = _isBuy ? activeAskPrices : activeBidPrices;
        if (oppositePrices.sizeOf() == 0) return remainingQuantity;

        (, uint256 currentPrice) = oppositePrices.getNextNode(0);

        while (currentPrice != 0 && remainingQuantity != 0) {
            if (_isBuy && currentPrice > _limitPrice) break;
            if (!_isBuy && currentPrice < _limitPrice) break;

            remainingQuantity = _matchOrdersAtPrice(_taker, currentPrice, remainingQuantity, _isBuy);
            (, currentPrice) = oppositePrices.getNextNode(currentPrice);
        }

        return remainingQuantity;
    }

    /// @notice Match orders at a specific price level
    function _matchOrdersAtPrice(address _taker, uint256 _price, int256 _remainingQty, bool _isBuy)
        private
        returns (int256)
    {
        StructuredLinkedList.List storage orderQueue =
            _isBuy ? priceOrdersShortQueue[_price] : priceOrdersLongQueue[_price];

        while (_remainingQty != 0 && orderQueue.sizeOf() > 0) {
            (, uint256 orderIdUint) = orderQueue.getNextNode(0);
            bytes32 orderId = bytes32(orderIdUint);
            Order storage order = orders[orderId];

            // Skip own orders (already handled in offset)
            if (order.participant == _taker) {
                (, uint256 nextId) = orderQueue.getNextNode(orderIdUint);
                if (nextId == 0) break;
                continue;
            }

            _remainingQty = _executeMatch(_taker, orderId, order, _remainingQty);
        }

        return _remainingQty;
    }

    /// @notice Execute a single order match
    function _executeMatch(address _taker, bytes32 _orderId, Order storage _order, int256 _remainingQty)
        private
        returns (int256)
    {
        uint256 matchAmt = _min(_abs(_order.quantity), _abs(_remainingQty));
        int256 matchQty = _toSignedQuantity(matchAmt, _remainingQty);

        // Execute at maker's price (price improvement for taker)
        Order memory orderCopy = _order;
        _createPosition(_orderId, orderCopy, _taker, _order.price, matchQty);

        // Update cached order value
        userTotalOrderValue[_order.participant] -= _calculateValue(_order.price, matchAmt);

        _order.quantity = _reduceQuantity(_order.quantity, matchAmt);

        if (_order.quantity == 0) {
            _removeOrder(_orderId, _order);
            emit OrderFilled(_orderId, _order.participant);
        } else {
            emit OrderUpdated(_orderId, _order.participant, _order.quantity);
        }

        return _remainingQty - matchQty;
    }

    /// @notice Get absolute value of int256
    function _abs(int256 _value) private pure returns (uint256) {
        return _value > 0 ? uint256(_value) : uint256(-_value);
    }

    /// @notice Check if two quantities have opposite signs
    function _isOppositeSign(int256 _a, int256 _b) private pure returns (bool) {
        return (_a > 0 && _b < 0) || (_a < 0 && _b > 0);
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
        Order memory order = orders[_orderId];
        if (order.participant != _msgSender()) {
            revert OrderNotBelongToSender();
        }

        _removeOrder(_orderId, order);
        emit OrderCancelled(_orderId, order.participant);
    }

    /// @notice Remove an order from the book (internal)
    function _removeOrder(bytes32 _orderId, Order memory order) private {
        bool isBid = order.quantity > 0;
        StructuredLinkedList.List storage orderQueue = _priceOrderIds(order.price, isBid);
        orderQueue.remove(uint256(_orderId));

        participantOrderIdsIndex[order.participant].remove(_orderId);
        participantPriceOrderIdsIndex[order.participant][order.price].remove(_orderId);

        // Calculate and subtract order value from cached total
        uint256 orderValue = _calculateValue(order.price, _abs(order.quantity));
        userTotalOrderValue[order.participant] -= orderValue;

        delete orders[_orderId];

        // Remove price level if no more orders at this price
        _removePriceLevelIfEmpty(order.price, isBid);
    }

    /// @notice Create a new order
    function _createOrder(address _participant, uint256 _price, int256 _quantity) private returns (bytes32) {
        bytes32 orderId = keccak256(abi.encode(_participant, _price, _quantity, block.timestamp, nonce++));
        orders[orderId] =
            Order({ participant: _participant, price: _price, quantity: _quantity, createdAt: block.timestamp });

        // Update cached total order value for user
        userTotalOrderValue[_participant] += _calculateValue(_price, _abs(_quantity));

        emit OrderCreated(orderId, _participant, _price, _quantity);
        return orderId;
    }

    /// @notice Update net positions when orders match
    function _createPosition(
        bytes32 matchedOrderId,
        Order memory matchedOrder,
        address _otherParticipant,
        uint256 _price,
        int256 _quantity
    ) private {
        // Determine buyer and seller based on quantity sign
        // Positive quantity = taker is buying, negative = taker is selling
        (address buyer, address seller) = _quantity > 0
            ? (_otherParticipant, matchedOrder.participant)
            : (matchedOrder.participant, _otherParticipant);

        // Use absolute quantity for position updates
        // Buyer always gets positive (long), seller always gets negative (short)
        int256 absQty = int256(_abs(_quantity));

        // Update buyer's position (long: positive quantity)
        _updateUserPosition(buyer, absQty, _price);

        // Update seller's position (short: negative quantity)
        _updateUserPosition(seller, -absQty, _price);

        emit OrderMatched(matchedOrderId, buyer, seller, _price, uint256(absQty));
    }

    /// @notice Update a user's net position with aggregated entry price
    function _updateUserPosition(address _user, int256 _quantity, uint256 _tradePrice) private {
        Position storage position = positions[_user];
        int256 newNetQuantity = position.netQuantity + _quantity;
        uint256 absQuantity = _abs(_quantity);

        // If no existing position, initialize it
        if (position.netQuantity == 0) {
            position.netQuantity = _quantity;
            position.aggregatedEntryPrice = _tradePrice;
            usersWithPositions.add(_user);

            emit PositionTrade(_user, _tradePrice, _quantity, newNetQuantity, _tradePrice);
            return;
        }

        uint256 oldAbsQuantity = _abs(position.netQuantity);
        int256 priceDiff = int256(_tradePrice) - int256(position.aggregatedEntryPrice);

        if (_isSameSign(position.netQuantity, _quantity)) {
            // Same direction - add to position with weighted average entry price
            uint256 newAbsQuantity = _abs(newNetQuantity);

            // Weighted average: (oldQty * oldPrice + newQty * newPrice) / totalQty
            uint256 oldValue = oldAbsQuantity * position.aggregatedEntryPrice;
            uint256 newValue = absQuantity * _tradePrice;
            position.aggregatedEntryPrice = (oldValue + newValue) / newAbsQuantity;
            position.netQuantity = newNetQuantity;

            emit PositionTrade(_user, _tradePrice, _quantity, newNetQuantity, position.aggregatedEntryPrice);
        } else {
            // Opposite direction - offset position and settle reduced amount
            if (absQuantity >= oldAbsQuantity) {
                // Fully offset or flip - settle the full original position
                int256 settledQuantity = _toSignedQuantity(oldAbsQuantity, position.netQuantity);
                int256 pnl = _settleReducedPosition(_user, priceDiff, settledQuantity);

                uint256 remaining = absQuantity - oldAbsQuantity;
                if (remaining > 0) {
                    // Flip position - create new position in opposite direction
                    position.netQuantity = _toSignedQuantity(remaining, _quantity);
                    position.aggregatedEntryPrice = _tradePrice;

                    emit PositionTrade(_user, _tradePrice, _quantity, position.netQuantity, _tradePrice);
                } else {
                    // Fully offset - close position
                    delete positions[_user];
                    usersWithPositions.remove(_user);

                    emit PositionClosed(_user, settledQuantity, pnl);
                }
            } else {
                // Partially offset - settle only the reduced amount
                int256 reducedQuantity = _toSignedQuantity(absQuantity, position.netQuantity);
                int256 pnl = _settleReducedPosition(_user, priceDiff, reducedQuantity);

                position.netQuantity = newNetQuantity;

                emit PositionTrade(_user, _tradePrice, _quantity, newNetQuantity, position.aggregatedEntryPrice);
                emit PositionClosed(_user, reducedQuantity, pnl);
            }
        }
    }

    /// @notice Add collateral to account
    /// @param _amount Amount of collateral to add
    function addCollateral(uint256 _amount) external {
        if (_amount == 0) {
            revert InvalidSize();
        }

        collateralToken.safeTransferFrom(_msgSender(), address(this), _amount);
        _mint(_msgSender(), _amount);

        emit CollateralAdded(_msgSender(), _amount);
    }

    /// @notice Remove collateral from account
    /// @param _amount Amount of collateral to remove
    function removeCollateral(uint256 _amount) external {
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
    function liquidate(address _user) external {
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
                reservePoolBalance += transferAmount;
            }
        } else if (pnl > 0) {
            // User has profits despite being underwater (shouldn't happen often)
            uint256 profit = uint256(pnl);
            if (reservePoolBalance >= profit) {
                reservePoolBalance -= profit;
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
            if (reservePoolBalance < profit) {
                revert InsufficientReservePool();
            }

            reservePoolBalance -= profit;
            _transfer(address(this), _user, profit);
        } else if (pnl < 0) {
            // User loses - transfer from user to reserve pool
            uint256 loss = uint256(-pnl);
            if (balanceOf(_user) >= loss) {
                _transfer(_user, address(this), loss);
                reservePoolBalance += loss;
            } else {
                // Not enough balance - transfer what's available
                uint256 available = balanceOf(_user);
                if (available > 0) {
                    _transfer(_user, address(this), available);
                    reservePoolBalance += available;
                }
                // Remaining loss is absorbed (user doesn't have enough collateral)
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

        // Find insertion point for sorted order
        // Bids: highest first (descending), Asks: lowest first (ascending)
        if (priceList.sizeOf() == 0) {
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

    /// @notice Pay order fee
    function _payOrderFee(address _participant) private {
        if (orderFee > 0) {
            _transfer(_participant, address(this), orderFee);
            collectedFeesBalance += orderFee;
        }
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

    /// @notice Get total unrealized PnL for a user
    function getUnrealizedPnl(address _user) external view returns (int256) {
        Position memory position = positions[_user];
        if (position.netQuantity == 0) return 0;
        return _calculatePositionPnl(position, getMarketPrice());
    }

    /// @notice Get user's net position size
    /// @return netQuantity Net position quantity (positive = long, negative = short)
    function getNetPositionSize(address _user) external view returns (int256 netQuantity) {
        return positions[_user].netQuantity;
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

    /// @notice Set the order fee
    function setOrderFee(uint256 _orderFee) external onlyOwner {
        orderFee = _orderFee;
        emit OrderFeeUpdated(_orderFee);
    }

    /// @notice Withdraw collected fees
    function withdrawFees() external onlyOwner {
        uint256 amount = collectedFeesBalance;
        collectedFeesBalance = 0;
        _burn(address(this), amount);
        collateralToken.safeTransfer(owner(), amount);
    }

    /// @notice Deposit to reserve pool
    function depositReservePool(uint256 _amount) external {
        collateralToken.safeTransferFrom(_msgSender(), address(this), _amount);
        reservePoolBalance += _amount;
        // Mint ERC20 tokens to contract so it can transfer them when users profit
        _mint(address(this), _amount);
    }

    /// @notice Withdraw from reserve pool
    function withdrawReservePool(uint256 _amount) external onlyOwner {
        if (_amount > reservePoolBalance) {
            revert InsufficientCollateral();
        }
        reservePoolBalance -= _amount;
        // Burn ERC20 tokens from contract before withdrawing collateral
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
