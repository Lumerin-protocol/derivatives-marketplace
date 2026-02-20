// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title DLL — Gas-optimised doubly linked list
/// @notice Drop-in replacement for StructuredLinkedList with two key improvements:
///         1. Flat mappings (one keccak256 level) instead of nested mappings (two levels).
///         2. `removeFast` skips zeroing the removed node's pointers and the size decrement,
///            saving 3 SSTOREs per call. Safe when node keys are unique and never reused
///            (e.g. keccak256 order IDs). Use full `remove` when keys can be reinserted
///            (e.g. price levels).
/// @dev Sentinel: node 0 is HEAD. `next[0]` = first element, `prev[0]` = last element.
///      An empty list has `next[0] == 0`.
library DLL {
    struct List {
        uint256 size;
        mapping(uint256 => uint256) next;
        mapping(uint256 => uint256) prev;
    }

    // ── Mutating ─────────────────────────────────────────────────────────────

    /// @dev Append `node` to the tail of the list.
    function pushBack(List storage self, uint256 node) internal {
        uint256 tail = self.prev[0];
        self.next[tail] = node; // old tail → node (if tail==0 this also sets next[0]=node = head)
        self.prev[node] = tail;
        self.prev[0] = node; // sentinel's prev = new tail
        self.size++;
    }

    /// @dev Prepend `node` to the head of the list.
    function pushFront(List storage self, uint256 node) internal {
        uint256 currentHead = self.next[0];
        self.next[0] = node;
        self.next[node] = currentHead;
        if (currentHead != 0) {
            self.prev[currentHead] = node;
        } else {
            self.prev[0] = node; // list was empty; node is also the tail
        }
        self.size++;
    }

    /// @dev Insert `node` immediately before `existing`.
    function insertBefore(List storage self, uint256 existing, uint256 node) internal {
        uint256 prevNode = self.prev[existing];
        self.next[prevNode] = node;
        self.prev[node] = prevNode;
        self.next[node] = existing;
        self.prev[existing] = node;
        self.size++;
    }

    /// @dev Insert `node` immediately after `existing`.
    function insertAfter(List storage self, uint256 existing, uint256 node) internal {
        uint256 nextNode = self.next[existing];
        self.next[existing] = node;
        self.prev[node] = existing;
        self.next[node] = nextNode;
        if (nextNode != 0) {
            self.prev[nextNode] = node;
        } else {
            self.prev[0] = node; // node is the new tail
        }
        self.size++;
    }

    /// @dev Full remove: zeros the node's pointers and decrements size.
    ///      Required when node keys may be reinserted later (e.g. price levels).
    function remove(List storage self, uint256 node) internal {
        uint256 prevNode = self.prev[node];
        uint256 nextNode = self.next[node];
        self.next[prevNode] = nextNode;
        if (nextNode != 0) {
            self.prev[nextNode] = prevNode;
        } else {
            self.prev[0] = prevNode; // node was tail; update tail
        }
        delete self.next[node];
        delete self.prev[node];
        self.size--;
    }

    /// @dev Fast remove: skips zeroing and size decrement — saves 3 SSTOREs.
    ///      Safe only when node keys are guaranteed unique (e.g. keccak256 hashes)
    ///      and `nodeExists` is never called on removed nodes.
    function removeFast(List storage self, uint256 node) internal {
        uint256 prevNode = self.prev[node];
        uint256 nextNode = self.next[node];
        self.next[prevNode] = nextNode;
        if (nextNode != 0) {
            self.prev[nextNode] = prevNode;
        } else {
            self.prev[0] = prevNode; // node was tail; update tail
        }
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    /// @dev Returns the node after `node`, or 0 if at tail / list empty.
    function getNext(List storage self, uint256 node) internal view returns (uint256) {
        return self.next[node];
    }

    /// @dev Returns the number of elements in the list.
    function sizeOf(List storage self) internal view returns (uint256) {
        return self.size;
    }

    /// @dev Returns true if `node` is currently in the list.
    ///      Only valid when nodes were removed via `remove` (which zeros pointers).
    ///      Do not use after `removeFast`.
    function nodeExists(List storage self, uint256 node) internal view returns (bool) {
        if (node == 0) return false;
        if (self.prev[node] != 0 || self.next[node] != 0) return true;
        return self.next[0] == node; // sole element: both pointers are 0
    }
}
