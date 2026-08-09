//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { StructuredLinkedList } from "solidity-linked-list/contracts/StructuredLinkedList.sol";
import { AggregatorV3Interface } from "./interfaces/AggregatorV3Interface.sol";
import { ICollateralVault } from "collateral-margin/contracts/contracts/interfaces/ICollateralVault.sol";
import { ILinearMarket } from "collateral-margin/contracts/contracts/interfaces/ILinearMarket.sol";
import { IPortfolioMarginEngine } from "collateral-margin/contracts/contracts/interfaces/IPortfolioMarginEngine.sol";
import { MathLib as M } from "./libs/MathLib.sol";
import { HashPowerPerpsDEXBase } from "./HashPowerPerpsDEXBase.sol";
import { HashPowerPerpsDEXAdmin } from "./HashPowerPerpsDEXAdmin.sol";

/// @title HashPower Perps DEX
/// @notice Perpetual trading contract with on-chain order book
/// @dev Positions are created between two users when orders match
/// @dev The permissionless surface: trading, liquidation and views. Storage and internal
///      helpers live in {HashPowerPerpsDEXBase}; the owner-only surface lives in
///      {HashPowerPerpsDEXAdmin}.
/// @dev TODO: when not enough reserve pool, the user should be able to get revenue
/// @dev on their collateral balance and withdraw later when collateral is added
contract HashPowerPerpsDEX is HashPowerPerpsDEXAdmin {
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using EnumerableSet for EnumerableSet.AddressSet;
    using StructuredLinkedList for StructuredLinkedList.List;

    /// @notice Implementation version, bumped on every deployed change.
    /// @dev Lives here rather than in {HashPowerPerpsDEXBase} so that a diff to
    ///      this file and the version it ships under stay in the same place,
    ///      mirroring {Futures}.
    string public constant VERSION = "2.15.0";

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(ICollateralVault _vault) HashPowerPerpsDEXBase(_vault) { }

    /// @notice Initialize the contract
    /// @param _priceOracle The Chainlink-style price oracle
    /// @param _vault Ignored — vault is now an immutable set in the constructor.
    ///        Kept for backwards compatibility with existing proxy deployments.
    function initialize(AggregatorV3Interface _priceOracle, ICollateralVault _vault) external initializer {
        __Ownable_init(_msgSender());
        __UUPSUpgradeable_init();

        setOracle(_priceOracle);
    }

    /// @notice One-shot post-upgrade migration to wire up the portfolio margin engine added in v2.
    /// @dev Intended to be invoked atomically via `upgradeToAndCall`:
    ///      `proxy.upgradeToAndCall(newImpl, abi.encodeCall(this.initializeV2, (vault, pm)))`.
    /// @param _vault Ignored — vault is now an immutable set in the constructor.
    ///        Kept for backwards compatibility.
    /// @param _pm The portfolio margin engine (may be `address(0)` to set later via `setPortfolioMargin`).
    /// @dev Deliberately unvalidated: the migration has to be able to run atomically with the
    ///      upgrade, before the engine on the other side is wired up. `setPortfolioMargin`
    ///      applies the checks.
    function initializeV2(ICollateralVault _vault, IPortfolioMarginEngine _pm) external reinitializer(2) onlyOwner {
        portfolioMargin = _pm;
    }

    /// @notice One-shot migration that clears the reused legacy flat-liquidation-fee slot.
    /// @dev Invoke atomically through `upgradeToAndCall` before any v2.15 fee path executes.
    function initializeV3() external reinitializer(3) onlyOwner {
        collectedFeesBalance = 0;
    }

    // ── Vault integration ───────────────────────────────────────────────────

    /// @notice Returns the user's collateral balance from the vault.
    function balanceOf(address account) public view returns (uint256) {
        return vault.balanceOf(account);
    }

    /// @notice Get current market price from oracle
    /// @return price The current price (scaled to collateral token decimals)
    function getMarketPrice() public view returns (uint256) {
        return _marketPrice();
    }

    /// @notice Create a limit order with explicit time-in-force (GTC / IOC / FOK).
    /// @param _price Limit price (must be multiple of minimumPriceIncrement)
    /// @param _quantity Order quantity (positive = long/buy, negative = short/sell)
    /// @param _tif Order lifetime / fill policy
    function createOrder(uint256 _price, int256 _quantity, TimeInForce _tif) external {
        address sender = _msgSender();
        _updateGlobalFunding();
        _settleFunding(sender);
        _validateOrderIntent(_price, _quantity, _tif);
        uint256 maxAllowedIm;
        if (_isLocallyReducing(sender, _quantity)) {
            maxAllowedIm = portfolioMargin.computePortfolioIM(sender);
        }
        _createOrder(sender, _price, _quantity, _tif);
        _ensureInitialMargin(sender, maxAllowedIm);
    }

    /// @notice Batched placement with per-leg time-in-force — IM check once at the end.
    /// @dev Unlike `createOrder`, batch placement does not use the below-IM,
    ///      portfolio-non-increasing exception. Any non-empty batch must leave
    ///      the account fully above portfolio IM. This avoids an additional
    ///      pre-batch PME traversal.
    ///      Empty input reverts so simulate-before-write callers do not submit
    ///      a no-op transaction.
    function createOrders(OrderIntent[] calldata _intents) external {
        uint256 len = _intents.length;
        if (len == 0) revert EmptyBatch();
        address sender = _msgSender();
        _updateGlobalFunding();
        _settleFunding(sender);
        for (uint256 i = 0; i < len; i++) {
            OrderIntent calldata intent = _intents[i];
            _validateOrderIntent(intent.price, intent.quantity, intent.timeInForce);
            _createOrder(sender, intent.price, intent.quantity, intent.timeInForce);
        }
        _ensureInitialMargin(sender, 0);
    }

    /// @notice Cancel, reduce-in-place, then place orders — IM check once at the end.
    /// @dev Cancels/reduces run first so freed margin is available to the creates.
    ///      Reduces keep FIFO queue position; creates always join the back.
    ///      Cancel/reduce-only batches skip PME because they cannot expand possible
    ///      post-fill exposures. Batches with creates use one strict final IM check;
    ///      the single-order below-IM exception does not apply.
    function updateOrders(
        bytes32[] calldata _cancelIds,
        ReduceIntent[] calldata _reduces,
        OrderIntent[] calldata _intents
    ) external {
        address sender = _msgSender();
        _updateGlobalFunding();
        uint256 createLen = _intents.length;
        if (createLen != 0) _settleFunding(sender);
        uint256 cancelLen = _cancelIds.length;
        for (uint256 i = 0; i < cancelLen; i++) {
            _cancelOrder(sender, _cancelIds[i]);
        }
        uint256 reduceLen = _reduces.length;
        for (uint256 r = 0; r < reduceLen; r++) {
            _reduceOrderSize(sender, _reduces[r].orderId, _reduces[r].newQuantity);
        }
        for (uint256 j = 0; j < createLen; j++) {
            OrderIntent calldata intent = _intents[j];
            _validateOrderIntent(intent.price, intent.quantity, intent.timeInForce);
            _createOrder(sender, intent.price, intent.quantity, intent.timeInForce);
        }
        if (createLen != 0) _ensureInitialMargin(sender, 0);
    }

    /// @notice Shrink a resting order owned by the caller without losing FIFO priority.
    /// @dev Rejects grow / sign flip / zero (use `cancelOrder` to remove entirely).
    function reduceOrderSize(bytes32 _orderId, int256 _newQuantity) external {
        _updateGlobalFunding();
        _reduceOrderSize(_msgSender(), _orderId, _newQuantity);
    }

    /// @notice Cancel an order
    /// @param _orderId Order ID to cancel
    function cancelOrder(bytes32 _orderId) external {
        _updateGlobalFunding();
        _cancelOrder(_msgSender(), _orderId);
    }

    /// @dev Validated per-leg body of `createOrder` / `createOrders` without the IM-check epilogue.
    ///      Caller has already updated global funding and settled the taker once for this tx.
    function _createOrder(address _participant, uint256 _price, int256 _quantity, TimeInForce _tif) internal {

        bool isBuy = _quantity > 0;
        bytes32 orderId = _nextOrderId();
        emit OrderCreated(orderId, _participant, _price, _quantity);

        int256 remainingQuantity = _matchWithOppositeOrders(_participant, _price, _quantity);
        bool partiallyOrFullyFilled = remainingQuantity != _quantity;

        if (_tif == TimeInForce.FOK && remainingQuantity != 0) revert TimeInForceNotFilled();
        // IOC with zero fill is a noop — revert rather than emit a closed empty order.
        if (_tif == TimeInForce.IOC && !partiallyOrFullyFilled) revert TimeInForceNotFilled();

        if (_tif == TimeInForce.GTC) {
            if (partiallyOrFullyFilled) {
                emit OrderUpdated(orderId, _participant, remainingQuantity);
            }

            if (remainingQuantity != 0) {
                // Validate minimum margin per resting order
                if (minimumMarginPerOrder > 0) {
                    uint256 restingValue = _calculateValue(_price, M.abs(remainingQuantity));
                    uint256 restingMargin = portfolioMargin.linearOrderMargin(restingValue);
                    if (restingMargin < minimumMarginPerOrder) {
                        revert OrderMarginTooLow();
                    }
                }

                // Validate max orders per participant
                EnumerableSet.Bytes32Set storage participantOrders = participantOrderIdsIndex[_participant];
                if (participantOrders.length() >= MAX_ORDERS_PER_PARTICIPANT) {
                    revert MaxOrdersPerParticipantReached();
                }

                // Create order with quantity that was not matched
                orders[orderId] = Order({ participant: _participant, price: _price, quantity: remainingQuantity });
                _addOrderAggregate(_participant, isBuy, _price, M.abs(remainingQuantity));
                participantOrders.add(orderId);
                StructuredLinkedList.List storage orderQueue = _priceOrderIds(_price, isBuy);
                bool newPriceLevel = orderQueue.sizeOf() == 0;
                orderQueue.pushBack(uint256(orderId));

                if (newPriceLevel) _addPriceLevel(_price, isBuy);
            }
        } else {
            // IOC (or FOK after a full fill): never rest; close the taker order id at 0.
            if (partiallyOrFullyFilled || _tif == TimeInForce.IOC) {
                emit OrderUpdated(orderId, _participant, 0);
            }
        }

    }

    /// @dev Shared cancel body for `cancelOrder` / `updateOrders`. Caller must
    ///      have already updated global funding for this tx when needed.
    function _cancelOrder(address _participant, bytes32 _orderId) internal {
        Order memory order = orders[_orderId];
        if (order.participant != _participant) {
            revert OrderNotBelongToSender();
        }

        bool isBid = order.quantity > 0;
        _subtractOrderAggregate(order.participant, isBid, order.price, M.abs(order.quantity), 0);
        _removeOrder(_orderId, order.participant, order.price, isBid);
        _removePriceLevelIfEmpty(_priceOrderIds(order.price, isBid), order.price, isBid);
        emit OrderCancelled(_orderId, order.participant);
    }

    /// @dev In-place size shrink. Keeps the order id in its price queue slot.
    function _reduceOrderSize(address _participant, bytes32 _orderId, int256 _newQuantity) internal {
        Order storage order = orders[_orderId];
        if (order.participant == address(0) || order.quantity == 0) revert OrderNotExists();
        if (order.participant != _participant) revert OrderNotBelongToSender();

        int256 oldQty = order.quantity;
        if (_newQuantity == 0 || (_newQuantity > 0) != (oldQty > 0)) revert InvalidReduceQuantity();
        uint256 oldAbs = M.abs(oldQty);
        uint256 newAbs = M.abs(_newQuantity);
        if (newAbs >= oldAbs) revert InvalidReduceQuantity();

        if (minimumMarginPerOrder > 0) {
            uint256 restingValue = _calculateValue(order.price, newAbs);
            uint256 restingMargin = portfolioMargin.linearOrderMargin(restingValue);
            if (restingMargin < minimumMarginPerOrder) revert OrderMarginTooLow();
        }

        bool isBid = oldQty > 0;
        _subtractOrderAggregate(order.participant, isBid, order.price, oldAbs, newAbs);
        order.quantity = _newQuantity;
        emit OrderUpdated(_orderId, order.participant, _newQuantity);
    }

    /// @notice Check if a user's position can be liquidated.
    /// @dev Returns true iff the user has a position AND is below MM. Note: this view does NOT
    ///      check the orders-must-be-clear rule enforced by `liquidatePosition`. Callers that
    ///      want the full preflight should also check `getUserOrders(user).length == 0`.
    function isLiquidatable(address _user) public view returns (bool) {
        return positions[_user].netQuantity != 0 && _underwater(_user);
    }

    /// @notice Force-close a single underwater user's position. Permissionless.
    /// @dev Strict orders-first invariant: reverts with `OrdersStillOpen` if the user has any
    ///      open orders anywhere in the portfolio, not merely on this book. The keeper must
    ///      clear them first through each venue's typed `liquidateOrders` method, then
    ///      re-snapshot portfolio health before closing the position. Orders on *other*
    ///      venues also gate this call, so keepers must drain every venue before retrying.
    /// @param _closeQty Absolute quantity (QUANTITY_DECIMALS) the keeper wants to close. Clamped to
    ///        `|netQuantity|`; pass `type(uint256).max` for a full close. Sizing the partial amount
    ///        so the account lands at/under IM is the keeper's off-chain responsibility — an
    ///        oversize partial reverts `OverLiquidation`.
    function liquidatePosition(address _user, uint256 _closeQty) external {
        _updateGlobalFunding();
        _settleFunding(_user);

        Position memory position = positions[_user];
        if (position.netQuantity == 0) revert NotLiquidatable();
        if (!_underwater(_user)) revert NotLiquidatable();
        // Portfolio-wide, not just this book: a position here can be the only thing
        // offsetting resting orders at another venue, and closing it would strand that
        // leg and raise the requirement. See `IPortfolioMarginEngine.hasRestingOrderDelta`.
        if (portfolioMargin.hasRestingOrderDelta(_user)) revert OrdersStillOpen();
        if (_closeQty == 0) revert InvalidSize();

        uint256 absNet = M.abs(position.netQuantity);
        uint256 closeAbs = _closeQty < absNet ? _closeQty : absNet;
        uint256 currentPrice = getMarketPrice();

        // Full close: delete the position and settle the whole PnL (bad-debt path). No IM buffer
        // guard — the keeper deliberately deleveraged the entire position (deep underwater).
        if (closeAbs == absNet) {
            _doLiquidatePosition(_user, currentPrice);
            return;
        }

        (int256 pnl, int256 signedClose) = _doPartialLiquidatePosition(_user, position, closeAbs, currentPrice);

        // Charge liquidation fee on the closed notional
        uint256 closedNotional = _calculateValue(currentPrice, closeAbs);
        uint256 liqFee = _chargeLiquidationFee(_user, closedNotional);

        // Over-liquidation guard: a position remains here, so if there is a real IM buffer
        // (`im > mm`) the leftover balance must sit at/under IM.
        (uint256 im, uint256 mm) = portfolioMargin.computePortfolioMargins(_user);
        if (im > mm && balanceOf(_user) > im) revert OverLiquidation();

        emit PositionLiquidated(_user, _msgSender(), signedClose, pnl, liqFee);
    }

    /// @notice Force-cancel a single resting order owned by an underwater user. Permissionless.
    function liquidateOrder(address _user, bytes32 _orderId) external {
        _updateGlobalFunding();

        if (!_underwater(_user)) revert NotLiquidatable();

        Order memory order = orders[_orderId];
        if (order.participant != _user) revert OrderNotBelongToUser();

        _doLiquidateOrder(_user, _orderId, order);
    }

    /// @notice Cancel keeper-chosen resting orders. Keeps prior cancels; skips raced/stale
    ///         ids; stops when the user is healthy.
    function liquidateOrders(address _user, bytes32[] calldata _orderIds) external {
        _updateGlobalFunding();

        uint256 cancelled = 0;
        uint256 len = _orderIds.length;
        for (uint256 i = 0; i < len; i++) {
            bytes32 orderId = _orderIds[i];
            Order memory order = orders[orderId];
            // Skip raced/stale ids before the expensive portfolio MM check.
            if (order.participant != _user || order.quantity == 0) continue;
            if (!_underwater(_user)) break;
            _doLiquidateOrder(_user, orderId, order);
            cancelled++;
        }
        if (cancelled == 0) revert NotLiquidatable();
    }

    /// @dev True iff the user is below the portfolio MM predicate. Used for permissionless
    ///      `liquidateOrder*` / `liquidatePosition` entry points (those don't need a position
    ///      to be present — orders alone can break MM).
    function _underwater(address _user) internal view returns (bool) {
        return vault.balanceOf(_user) < portfolioMargin.computePortfolioMM(_user);
    }

    /// @dev Cancels a single order on behalf of a (verified-underwater) user. Caller must have
    ///      already verified `_underwater(_user)` and that `_order.participant == _user`.
    ///      Charges a liquidation fee on the order's notional value.
    function _doLiquidateOrder(address _user, bytes32 _orderId, Order memory _order) internal {
        bool isBid = _order.quantity > 0;
        uint256 orderAbsQty = M.abs(_order.quantity);
        uint256 orderNotional = _calculateValue(_order.price, orderAbsQty);
        _subtractOrderAggregate(_user, isBid, _order.price, orderAbsQty, 0);
        _removeOrder(_orderId, _user, _order.price, isBid);
        _removePriceLevelIfEmpty(_priceOrderIds(_order.price, isBid), _order.price, isBid);

        uint256 liqFee = _chargeLiquidationFee(_user, orderNotional);

        emit OrderCancelled(_orderId, _user);
        emit OrderLiquidated(_orderId, _user, _msgSender(), liqFee);
        _notifyLiquidation(_msgSender(), liqFee);
    }

    /// @notice Get the best bid price (highest)
    function getBestBidPrice() public view returns (uint256) {
        return _bestBidPrice();
    }

    /// @notice Get the best ask price (lowest)
    function getBestAskPrice() public view returns (uint256) {
        return _bestAskPrice();
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

            StructuredLinkedList.List storage orderQueue = _priceOrderIds(currentPrice, !isBuy);
            (, uint256 orderIdUint) = orderQueue.getNextNode(0);

            while (orderIdUint != 0 && remaining != 0) {
                Order storage makerOrder = orders[bytes32(orderIdUint)];
                // STP: self-cross nets out, not a fill
                if (makerOrder.participant == _msgSender()) {
                    uint256 selfAmt = M.min(M.abs(makerOrder.quantity), M.abs(remaining));
                    remaining -= _toSignedQuantity(selfAmt, remaining);
                    (, orderIdUint) = orderQueue.getNextNode(orderIdUint);
                    continue;
                }
                uint256 matchAmt = M.min(M.abs(makerOrder.quantity), M.abs(remaining));
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

    // ──────────────────────────────────────────────
    // Funding
    // ──────────────────────────────────────────────

    /// @notice Trigger a funding-rate update (callable by anyone / keepers)
    /// @dev Useful during idle periods to keep the cumulative funding current.
    function updateFunding() external {
        _updateGlobalFunding();
    }

    /// @notice Get the pending (unsettled) funding for a user
    /// @param _user Address of the user
    /// @return pendingFunding Positive = user owes, negative = user receives (in collateral token units)
    function getPendingFunding(address _user) public view returns (int256) {
        return _pendingFunding(_user, 0);
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

    /// @notice Net linear delta of the user's position, signed and scaled to the
    ///         six-decimal collateral used by ILinearMarket.
    function getNetPositionDelta(address _user) external view returns (int256) {
        return positions[_user].netQuantity;
    }

    /// @notice ILinearMarket: all per-user margin inputs in a single call
    ///         (saves the portfolio margin engine external-call gas).
    /// @dev Resting orders are reported as raw per-side delta and instant fill loss, not as
    ///      a margin figure. The engine nets the deltas into portfolio net delta before
    ///      stressing, which is exact and cross-product — the former venue-local
    ///      "reducing" credit netted only against this venue's position, so an account
    ///      long perps and short futures had a perps sell order credited as risk-reducing
    ///      when filling it would take the portfolio genuinely short.
    function getRiskView(address _user) external view returns (ILinearMarket.RiskView memory view_) {
        Position memory position = positions[_user];
        OrderAggregate storage aggregate = userOrderAggregate[_user];
        uint256 buyQty = aggregate.buyQty;
        uint256 sellQty = aggregate.sellQty;
        if (position.netQuantity == 0 && buyQty == 0 && sellQty == 0) return view_;

        uint256 currentPrice = getMarketPrice();

        view_.netPositionDelta = position.netQuantity;
        if (position.netQuantity != 0) {
            // Mark PnL only. Funding travels in `pendingFunding`; netting it in here too
            // would have the engine charge the same debt twice (it adds both terms).
            // This deliberately differs from `getUnrealizedPnl`, which is a UX view.
            view_.unrealizedPnl = _calculatePositionPnl(position, currentPrice);
        }
        view_.pendingFunding = _pendingFunding(_user, currentPrice);

        view_.buyOrderDelta = buyQty;
        view_.sellOrderDelta = sellQty;

        // Instant mark-to-market loss if a whole side fills. Filling a bid above spot costs
        // the difference immediately and in full, which the old shock-scaled reservation
        // charged only a tenth of.
        //
        uint256 buyMark = _calculateValue(currentPrice, buyQty);
        uint256 buyVal = aggregate.buyValue;
        if (buyVal > buyMark) view_.buyOrderFillLoss = buyVal - buyMark;

        uint256 sellMark = _calculateValue(currentPrice, sellQty);
        uint256 sellVal = aggregate.sellValue;
        if (sellMark > sellVal) view_.sellOrderFillLoss = sellMark - sellVal;
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
        uint256 bidCount = M.min(activeBidPrices.sizeOf(), _maxLevels);
        uint256 askCount = M.min(activeAskPrices.sizeOf(), _maxLevels);

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
        StructuredLinkedList.List storage orderQueue = _priceOrderIds(_price, _isBid);

        (, uint256 orderId) = orderQueue.getNextNode(0);
        while (orderId != 0) {
            Order storage order = orders[bytes32(orderId)];
            totalQuantity += M.abs(order.quantity);
            (, orderId) = orderQueue.getNextNode(orderId);
        }

        return totalQuantity;
    }

    /// @notice Cached resting-order quantities and notionals per side for a user.
    function getOrderAggregate(address _user) external view returns (OrderAggregate memory) {
        return userOrderAggregate[_user];
    }

    /// @notice Whether the participant has margin-relevant resting-order delta.
    function hasRestingOrderDelta(address _user) external view returns (bool) {
        OrderAggregate storage aggregate = userOrderAggregate[_user];
        return aggregate.buyQty != 0 || aggregate.sellQty != 0;
    }
}
