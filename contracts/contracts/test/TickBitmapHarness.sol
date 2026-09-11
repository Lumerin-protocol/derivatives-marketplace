// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { TickBitmapLib } from "../libs/TickBitmapLib.sol";

/// @dev Test harness that wraps TickBitmapLib with storage.
contract TickBitmapHarness {
    mapping(uint256 => uint256) private bitmap;

    function flipTick(uint64 tick) external {
        TickBitmapLib.flipTick(bitmap, tick);
    }

    function isInitialized(uint64 tick) external view returns (bool) {
        return TickBitmapLib.isInitialized(bitmap, tick);
    }

    function nextInitializedTickLte(uint64 tick) external view returns (uint64 next, bool found) {
        return TickBitmapLib.nextInitializedTickLte(bitmap, tick);
    }

    function nextInitializedTickGte(uint64 tick) external view returns (uint64 next, bool found) {
        return TickBitmapLib.nextInitializedTickGte(bitmap, tick);
    }

    function nextBid(uint64 tick, uint64 minTick) external view returns (uint64 next, bool found) {
        return TickBitmapLib.nextBid(bitmap, tick, minTick);
    }

    function nextAsk(uint64 tick, uint64 maxTick) external view returns (uint64 next, bool found) {
        return TickBitmapLib.nextAsk(bitmap, tick, maxTick);
    }
}
