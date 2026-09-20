// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { OrderQueueLib } from "../libs/OrderQueueLib.sol";

/// @dev Test harness that wraps OrderQueueLib with storage.
contract OrderQueueHarness {
    using OrderQueueLib for OrderQueueLib.Queue;

    OrderQueueLib.Queue private queue;

    function enqueue(uint64 orderId) external {
        queue.enqueue(orderId);
    }

    function dequeue() external returns (uint64) {
        return queue.dequeue();
    }

    function peek() external view returns (uint64) {
        return queue.peek();
    }

    function remove(uint64 orderId) external {
        queue.remove(orderId);
    }

    function getNext(uint64 orderId) external view returns (uint64) {
        return queue.getNext(orderId);
    }

    function isEmpty() external view returns (bool) {
        return queue.isEmpty();
    }

    function sizeOf() external view returns (uint256) {
        return queue.sizeOf();
    }

    function exists(uint64 orderId) external view returns (bool) {
        return queue.exists(orderId);
    }
}
