//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { MathLib } from "../libs/MathLib.sol";

/// @title MathLibHarness
/// @notice Test-only: exposes the internal `MathLib` helpers the venue relies on.
contract MathLibHarness {
    function fillLossBound(uint256 qty, uint256 pq, uint256 p2q, uint256 mark, bool isBuy)
        external
        pure
        returns (uint256)
    {
        return MathLib.fillLossBound(qty, pq, p2q, mark, isBuy);
    }
}
