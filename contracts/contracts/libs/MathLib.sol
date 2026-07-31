// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MathLib — Pure math helpers shared by Perps and Futures
library MathLib {
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
