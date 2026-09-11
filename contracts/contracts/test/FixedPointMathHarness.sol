// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { FixedPointMathLib } from "../libs/FixedPointMathLib.sol";

/// @dev Test harness exposing FixedPointMathLib internals as external calls.
contract FixedPointMathHarness {
    function exp(int256 x) external pure returns (uint256) {
        return FixedPointMathLib.exp(x);
    }

    function ln(int256 x) external pure returns (int256) {
        return FixedPointMathLib.ln(x);
    }

    function lnPrecise(int256 x) external pure returns (int256) {
        return FixedPointMathLib.lnPrecise(x);
    }

    function expPrecise(int256 x) external pure returns (uint256) {
        return FixedPointMathLib.expPrecise(x);
    }

    function sqrt(uint256 x) external pure returns (uint256) {
        return FixedPointMathLib.sqrt(x);
    }

    function abs(int256 x) external pure returns (uint256) {
        return FixedPointMathLib.abs(x);
    }

    function stdNormalCDF(int256 x) external pure returns (uint256) {
        return FixedPointMathLib.stdNormalCDF(x);
    }

    function stdNormal(int256 x) external pure returns (uint256) {
        return FixedPointMathLib.stdNormal(x);
    }

    function decPow(int256 a, int256 b) external pure returns (uint256) {
        return FixedPointMathLib.decPow(a, b);
    }
}
