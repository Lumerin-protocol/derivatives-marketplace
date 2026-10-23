// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title MathLib — Pure math helpers shared by Perps and Futures
library MathLib {
    /// @notice Upper bound on a side's instant fill loss, `Σ q·max(0, p − m)` for bids or
    ///         `Σ q·max(0, m − p)` for asks, from that side's `Σq`, `Σp·q` and `Σp²·q`.
    /// @dev Scarf's bound: the worst case over every book with the same three sums, so a
    ///      far-off order can never offset a marketable one. Never below the true loss
    ///      (all roundings go up) and exact when the side has a single price level. Units are
    ///      the caller's unscaled `price · qty`.
    function fillLossBound(uint256 qty, uint256 pq, uint256 p2q, uint256 mark, bool isBuy)
        internal
        pure
        returns (uint256)
    {
        uint256 mq = mark * qty;
        // Σ q·(p − m)², exact in integers and never negative.
        uint256 pos = p2q + mark * mq;
        uint256 neg = 2 * mark * pq;
        uint256 spread;
        unchecked {
            spread = pos > neg ? pos - neg : 0;
        }
        // The venues cap order price and quantity so qty·spread always fits in uint256.
        uint256 root = Math.sqrt(qty * spread, Math.Rounding.Ceil);
        (uint256 up, uint256 down) = isBuy ? (pq, mq) : (mq, pq);
        // Each subtraction is guarded by the comparison before it; the additions cannot
        // overflow (root ≤ 2^128, and `up − down` is bounded by the order caps).
        unchecked {
            if (up >= down) return (root + (up - down) + 1) / 2;
            uint256 gap = down - up;
            return root > gap ? (root - gap + 1) / 2 : 0;
        }
    }

    /// @notice Absolute value of int256, safe for type(int256).min.
    function abs(int256 value) internal pure returns (uint256) {
        unchecked {
            return value >= 0 ? uint256(value) : uint256(-value);
        }
    }

    /// @notice True when both values have the same sign (both > 0 or both < 0).
    function isSameSign(int256 a, int256 b) internal pure returns (bool) {
        return (a > 0 && b > 0) || (a < 0 && b < 0);
    }

    /// @notice Round a value to the nearest multiple of an increment.
    function roundToNearest(uint256 value, uint256 increment) internal pure returns (uint256) {
        return (value + increment / 2) / increment * increment;
    }

    /// @notice Scale a value from one decimal precision to another.
    function scaleDecimals(uint256 value, uint8 fromDecimals, uint8 toDecimals) internal pure returns (uint256) {
        if (fromDecimals > toDecimals) {
            return value / (10 ** (fromDecimals - toDecimals));
        } else if (fromDecimals < toDecimals) {
            return value * (10 ** (toDecimals - fromDecimals));
        }
        return value;
    }

    /// @notice Clamp an int256 to uint256: returns the value if positive, 0 otherwise.
    function clamp(int256 value) internal pure returns (uint256) {
        if (value > 0) {
            return uint256(value);
        } else {
            return 0;
        }
    }

    /// @notice Minimum of two uint256 values.
    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// @notice Signed quantity from an absolute value and a direction flag.
    function toSigned(bool isPositive, uint256 absValue) internal pure returns (int256) {
        return isPositive ? int256(absValue) : -int256(absValue);
    }
}
