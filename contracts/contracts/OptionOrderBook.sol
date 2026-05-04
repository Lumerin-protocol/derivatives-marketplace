// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { TickBitmapLib } from "./libs/TickBitmapLib.sol";
import { OrderQueueLib } from "./libs/OrderQueueLib.sol";
import { OptionMarketRegistry } from "./OptionMarketRegistry.sol";

/// @title OptionOrderBook — Per-series CLOB with tick bitmap + FIFO queues
/// @notice Stores bids and asks per option series. Write operations are restricted
///         to an authorized router that handles margin checks and premium transfers.
contract OptionOrderBook is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    using OrderQueueLib for OrderQueueLib.Queue;

    // ── Types ───────────────────────────────────────────────────────────────

    struct Order {
        address trader;
        uint64 seriesId;
        bool isBuy;
        bool postOnly;
        bool reduceOnly;
        uint128 size; // original quantity
        uint128 remaining; // unfilled quantity
        uint64 priceTicks; // premium in tick multiples
    }

    // ── Errors ──────────────────────────────────────────────────────────────

    error NotRouter();
    error OrderNotActive(uint64 orderId);
    error FillExceedsRemaining(uint64 orderId, uint128 fillSize, uint128 remaining);
    error InvalidPrice();
    error InvalidSize();

    // ── Events ──────────────────────────────────────────────────────────────

    event OrderPlaced(
        uint64 indexed orderId,
        uint64 indexed seriesId,
        address indexed trader,
        bool isBuy,
        uint64 priceTicks,
        uint128 size
    );
    event OrderCanceled(uint64 indexed orderId);
    event OrderFilled(uint64 indexed orderId, uint128 fillSize, uint128 remainingAfter);
    event RouterUpdated(address indexed oldRouter, address indexed newRouter);

    // ── Storage ─────────────────────────────────────────────────────────────

    OptionMarketRegistry public registry;
    address public router;

    mapping(uint64 => Order) private _orders;
    uint64 public nextOrderId;

    /// @dev seriesId → priceTick → FIFO queue of order IDs
    mapping(uint64 => mapping(uint64 => OrderQueueLib.Queue)) private bidQueues;
    mapping(uint64 => mapping(uint64 => OrderQueueLib.Queue)) private askQueues;

    /// @dev seriesId → tick bitmap (one for each side)
    mapping(uint64 => mapping(uint256 => uint256)) private bidBitmaps;
    mapping(uint64 => mapping(uint256 => uint256)) private askBitmaps;

    /// @dev Cached best prices per series (0 = no orders on that side)
    mapping(uint64 => uint64) private _bestBidTick;
    mapping(uint64 => uint64) private _bestAskTick;

    /// @dev Highest ask tick ever placed per series (bounds upward bitmap scan)
    mapping(uint64 => uint64) private _maxUsedAskTick;

    uint256[39] private __gap;

    // ── Modifiers ───────────────────────────────────────────────────────────

    modifier onlyRouter() {
        if (_msgSender() != router) revert NotRouter();
        _;
    }

    // ── Initializer ─────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _registry) external initializer {
        __Ownable_init(_msgSender());
        __UUPSUpgradeable_init();
        registry = OptionMarketRegistry(_registry);
        nextOrderId = 1; // 0 is reserved as sentinel
    }

    // ── Admin ───────────────────────────────────────────────────────────────

    /// @notice Set the authorized router address.
    function setRouter(address _router) external onlyOwner {
        emit RouterUpdated(router, _router);
        router = _router;
    }

    // ── Order placement ─────────────────────────────────────────────────────

    /// @notice Insert a new order into the book. Called by the router after
    ///         validation and margin checks.
    /// @return orderId The assigned order ID
    function placeOrder(
        uint64 seriesId,
        address trader,
        bool isBuy,
        uint64 priceTicks,
        uint128 size,
        bool postOnly,
        bool reduceOnly
    ) external onlyRouter returns (uint64 orderId) {
        if (priceTicks == 0) revert InvalidPrice();
        if (size == 0) revert InvalidSize();

        orderId = nextOrderId++;
        _orders[orderId] = Order({
            trader: trader,
            seriesId: seriesId,
            isBuy: isBuy,
            postOnly: postOnly,
            reduceOnly: reduceOnly,
            size: size,
            remaining: size,
            priceTicks: priceTicks
        });

        _addToBook(orderId, seriesId, isBuy, priceTicks);

        emit OrderPlaced(orderId, seriesId, trader, isBuy, priceTicks, size);
    }

    // ── Order cancellation ──────────────────────────────────────────────────

    /// @notice Remove an order from the book.
    /// @return order The cancelled order data (for margin release by router)
    function cancelOrder(uint64 orderId) external onlyRouter returns (Order memory order) {
        Order storage o = _orders[orderId];
        if (o.remaining == 0) revert OrderNotActive(orderId);

        order = o; // copy to memory before zeroing

        _removeFromBook(orderId, o.seriesId, o.isBuy, o.priceTicks);
        o.remaining = 0;

        emit OrderCanceled(orderId);
    }

    // ── Fill (partial or full) ──────────────────────────────────────────────

    /// @notice Reduce an order's remaining quantity. Called by router during matching.
    /// @param orderId The maker order being filled
    /// @param fillSize Number of contracts filled
    /// @return priceTicks The fill price (maker's limit)
    /// @return trader The maker's address
    function fillOrder(uint64 orderId, uint128 fillSize)
        external
        onlyRouter
        returns (uint64 priceTicks, address trader)
    {
        Order storage o = _orders[orderId];
        if (o.remaining == 0) revert OrderNotActive(orderId);
        if (fillSize > o.remaining) revert FillExceedsRemaining(orderId, fillSize, o.remaining);

        priceTicks = o.priceTicks;
        trader = o.trader;
        o.remaining -= fillSize;

        if (o.remaining == 0) {
            _removeFromBook(orderId, o.seriesId, o.isBuy, o.priceTicks);
        }

        emit OrderFilled(orderId, fillSize, o.remaining);
    }

    // ── Book queries ────────────────────────────────────────────────────────

    /// @notice Get the best (highest) bid for a series.
    /// @return orderId Head of the FIFO queue at the best bid tick (0 if empty)
    /// @return priceTicks The best bid tick (0 if no bids)
    function bestBid(uint64 seriesId) external view returns (uint64 orderId, uint64 priceTicks) {
        priceTicks = _bestBidTick[seriesId];
        if (priceTicks == 0) return (0, 0);
        orderId = bidQueues[seriesId][priceTicks].peek();
    }

    /// @notice Get the best (lowest) ask for a series.
    /// @return orderId Head of the FIFO queue at the best ask tick (0 if empty)
    /// @return priceTicks The best ask tick (0 if no asks)
    function bestAsk(uint64 seriesId) external view returns (uint64 orderId, uint64 priceTicks) {
        priceTicks = _bestAskTick[seriesId];
        if (priceTicks == 0) return (0, 0);
        orderId = askQueues[seriesId][priceTicks].peek();
    }

    /// @notice Read order data.
    function getOrder(uint64 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    /// @notice Check if an order is still resting on the book.
    function isOrderActive(uint64 orderId) external view returns (bool) {
        return _orders[orderId].remaining > 0;
    }

    /// @notice Get the number of orders at a given price level.
    function levelDepth(uint64 seriesId, bool isBuy, uint64 priceTicks) external view returns (uint256) {
        if (isBuy) {
            return bidQueues[seriesId][priceTicks].sizeOf();
        }
        return askQueues[seriesId][priceTicks].sizeOf();
    }

    /// @notice Get the next order in the queue after a given order (for iteration).
    function nextOrderInQueue(uint64 seriesId, bool isBuy, uint64 priceTicks, uint64 afterOrderId)
        external
        view
        returns (uint64)
    {
        if (isBuy) {
            return bidQueues[seriesId][priceTicks].getNext(afterOrderId);
        }
        return askQueues[seriesId][priceTicks].getNext(afterOrderId);
    }

    /// @notice Find the next populated price level after the best.
    ///         Useful for matching router to walk through levels.
    /// @param seriesId The series
    /// @param isBuy True to scan bids (descending), false to scan asks (ascending)
    /// @param afterTick Start searching after this tick (exclusive)
    /// @return nextTick The next populated tick (0 if none)
    /// @return found True if a level was found
    function nextLevel(uint64 seriesId, bool isBuy, uint64 afterTick)
        external
        view
        returns (uint64 nextTick, bool found)
    {
        if (isBuy) {
            if (afterTick == 0) return (0, false);
            return TickBitmapLib.nextBid(bidBitmaps[seriesId], afterTick - 1, 0);
        }
        uint64 scanCeil = _maxUsedAskTick[seriesId];
        if (afterTick >= scanCeil) return (0, false);
        return TickBitmapLib.nextAsk(askBitmaps[seriesId], afterTick + 1, scanCeil);
    }

    // ── Internal: book management ───────────────────────────────────────────

    function _addToBook(uint64 orderId, uint64 seriesId, bool isBuy, uint64 priceTicks) private {
        if (isBuy) {
            OrderQueueLib.Queue storage q = bidQueues[seriesId][priceTicks];
            bool wasEmpty = q.isEmpty();
            q.enqueue(orderId);

            if (wasEmpty) {
                TickBitmapLib.flipTick(bidBitmaps[seriesId], priceTicks);
            }

            if (priceTicks > _bestBidTick[seriesId]) {
                _bestBidTick[seriesId] = priceTicks;
            }
        } else {
            OrderQueueLib.Queue storage q = askQueues[seriesId][priceTicks];
            bool wasEmpty = q.isEmpty();
            q.enqueue(orderId);

            if (wasEmpty) {
                TickBitmapLib.flipTick(askBitmaps[seriesId], priceTicks);
            }

            uint64 currentBest = _bestAskTick[seriesId];
            if (currentBest == 0 || priceTicks < currentBest) {
                _bestAskTick[seriesId] = priceTicks;
            }
            if (priceTicks > _maxUsedAskTick[seriesId]) {
                _maxUsedAskTick[seriesId] = priceTicks;
            }
        }
    }

    function _removeFromBook(uint64 orderId, uint64 seriesId, bool isBuy, uint64 priceTicks) private {
        if (isBuy) {
            _removeFromSide(
                bidQueues[seriesId][priceTicks],
                bidBitmaps[seriesId],
                orderId,
                seriesId,
                priceTicks,
                true
            );
        } else {
            _removeFromSide(
                askQueues[seriesId][priceTicks],
                askBitmaps[seriesId],
                orderId,
                seriesId,
                priceTicks,
                false
            );
        }
    }

    function _removeFromSide(
        OrderQueueLib.Queue storage q,
        mapping(uint256 => uint256) storage bitmap,
        uint64 orderId,
        uint64 seriesId,
        uint64 priceTicks,
        bool isBid
    ) private {
        q.remove(orderId);

        if (q.isEmpty()) {
            TickBitmapLib.flipTick(bitmap, priceTicks);
            _updateBestAfterRemoval(bitmap, seriesId, priceTicks, isBid);
        }
    }

    function _updateBestAfterRemoval(
        mapping(uint256 => uint256) storage bitmap,
        uint64 seriesId,
        uint64 removedTick,
        bool isBid
    ) private {
        if (isBid && removedTick == _bestBidTick[seriesId]) {
            // Tick already flipped off, so searching from removedTick will skip it
            (uint64 next, bool found) = TickBitmapLib.nextBid(bitmap, removedTick, 0);
            _bestBidTick[seriesId] = found ? next : 0;
        } else if (!isBid && removedTick == _bestAskTick[seriesId]) {
            uint64 scanCeil = _maxUsedAskTick[seriesId];
            (uint64 next, bool found) = TickBitmapLib.nextAsk(bitmap, removedTick, scanCeil);
            _bestAskTick[seriesId] = found ? next : 0;
        }
    }

    // ── Upgrade ─────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
