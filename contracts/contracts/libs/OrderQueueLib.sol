// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title OrderQueueLib — FIFO queue for orders at a single price level
/// @notice Doubly-linked list keyed by uint64 order IDs.
///         Sentinel node 0: next[0] = head, prev[0] = tail.
///         Follows the same pattern as DLL.sol but with uint64 keys
///         and FIFO-specific operations (enqueue/dequeue/peek).
library OrderQueueLib {
    struct Queue {
        uint256 size;
        mapping(uint64 => uint64) next;
        mapping(uint64 => uint64) prev;
    }

    error EmptyQueue();

    /// @notice Add an order to the tail of the queue (FIFO enqueue).
    function enqueue(Queue storage self, uint64 orderId) internal {
        uint64 tail = self.prev[0];
        self.next[tail] = orderId;
        self.prev[orderId] = tail;
        self.prev[0] = orderId;
        self.size++;
    }

    /// @notice Remove and return the head order (FIFO dequeue).
    function dequeue(Queue storage self) internal returns (uint64 orderId) {
        orderId = self.next[0];
        if (orderId == 0) revert EmptyQueue();

        uint64 newHead = self.next[orderId];
        self.next[0] = newHead;
        if (newHead != 0) {
            self.prev[newHead] = 0;
        } else {
            self.prev[0] = 0; // queue is now empty
        }

        delete self.next[orderId];
        delete self.prev[orderId];
        self.size--;
    }

    /// @notice View the head order without removing it.
    function peek(Queue storage self) internal view returns (uint64) {
        return self.next[0];
    }

    /// @notice Remove an arbitrary order from the queue (for cancellations).
    function remove(Queue storage self, uint64 orderId) internal {
        uint64 prevNode = self.prev[orderId];
        uint64 nextNode = self.next[orderId];

        self.next[prevNode] = nextNode;
        if (nextNode != 0) {
            self.prev[nextNode] = prevNode;
        } else {
            self.prev[0] = prevNode; // removed the tail
        }

        delete self.next[orderId];
        delete self.prev[orderId];
        self.size--;
    }

    /// @notice Get the next order after a given order (for iteration).
    function getNext(Queue storage self, uint64 orderId) internal view returns (uint64) {
        return self.next[orderId];
    }

    /// @notice Check if the queue is empty.
    function isEmpty(Queue storage self) internal view returns (bool) {
        return self.next[0] == 0;
    }

    /// @notice Get the number of orders in the queue.
    function sizeOf(Queue storage self) internal view returns (uint256) {
        return self.size;
    }

    /// @notice Check if an order is currently in the queue.
    ///         Only valid for orders removed via `remove` or `dequeue` (which zero pointers).
    function exists(Queue storage self, uint64 orderId) internal view returns (bool) {
        if (orderId == 0) return false;
        if (self.prev[orderId] != 0 || self.next[orderId] != 0) return true;
        return self.next[0] == orderId; // sole element: both pointers are 0
    }
}
