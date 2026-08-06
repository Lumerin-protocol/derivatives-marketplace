// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { StructuredLinkedList } from "solidity-linked-list/contracts/StructuredLinkedList.sol";

using StructuredLinkedList for StructuredLinkedList.List;

/// @title PriceLadderLib — Sorted price ladder insertion + removal + shared math
/// @notice Shared by Perps and Futures. Callers resolve the correct list
///         (global or per-expiration) before calling.
library PriceLadderLib {
    error MaxPriceLevelsReached();

    /// @notice Insert a price into a sorted list of price levels.
    /// @param priceList The sorted linked list (bids: descending, asks: ascending).
    /// @param price The price to insert.
    /// @param isBid True for bid ladder (highest first), false for ask (lowest first).
    /// @param maxLevels Maximum number of price levels allowed. Reverts if exceeded.
    function insertPrice(
        StructuredLinkedList.List storage priceList,
        uint256 price,
        bool isBid,
        uint256 maxLevels
    ) internal {
        if (priceList.nodeExists(price)) return;

        uint256 size = priceList.sizeOf();
        if (size >= maxLevels) revert MaxPriceLevelsReached();

        if (size == 0) {
            priceList.pushFront(price);
            return;
        }

        (, uint256 current) = priceList.getNextNode(0);
        uint256 prev = 0;

        while (current != 0) {
            if (isBid) {
                // Bids: descending — insert before first smaller price
                if (current < price) {
                    priceList.insertBefore(current, price);
                    return;
                }
            } else {
                // Asks: ascending — insert before first larger price
                if (current > price) {
                    priceList.insertBefore(current, price);
                    return;
                }
            }
            prev = current;
            (, current) = priceList.getNextNode(current);
        }

        // Insert at tail (after the last element)
        priceList.insertAfter(prev, price);
    }

    /// @notice Remove a price from the ladder if its order queue is empty.
    /// @param orderQueue The FIFO queue of orders at this price level.
    /// @param priceList The sorted price ladder.
    /// @param price The price to potentially remove.
    function removeIfEmpty(
        StructuredLinkedList.List storage orderQueue,
        StructuredLinkedList.List storage priceList,
        uint256 price
    ) internal {
        if (orderQueue.sizeOf() == 0 && priceList.nodeExists(price)) {
            priceList.remove(price);
        }
    }
}
