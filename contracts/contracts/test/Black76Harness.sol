// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Black76Lib } from "../libs/Black76Lib.sol";

/// @dev Test harness exposing Black76Lib internals as external calls.
contract Black76Harness {
    function callPrice(uint256 F, uint256 K, uint256 sigma, uint256 tSec)
        external
        pure
        returns (uint256)
    {
        return Black76Lib.callPrice(F, K, sigma, tSec);
    }

    function putPrice(uint256 F, uint256 K, uint256 sigma, uint256 tSec)
        external
        pure
        returns (uint256)
    {
        return Black76Lib.putPrice(F, K, sigma, tSec);
    }

    function pricesAndDelta(uint256 F, uint256 K, uint256 sigma, uint256 tSec)
        external
        pure
        returns (uint256 call, uint256 put, uint256 cDelta)
    {
        return Black76Lib.pricesAndDelta(F, K, sigma, tSec);
    }

    function greeks(uint256 F, uint256 K, uint256 sigma, uint256 tSec, bool isCall)
        external
        pure
        returns (int256 delta, uint256 gamma, uint256 vega)
    {
        Black76Lib.Greeks memory g = Black76Lib.greeks(F, K, sigma, tSec, isCall);
        return (g.delta, g.gamma, g.vega);
    }

    function impliedVol(uint256 F, uint256 K, uint256 tSec, uint256 targetPremium, bool isCall)
        external
        pure
        returns (uint256)
    {
        return Black76Lib.impliedVol(F, K, tSec, targetPremium, isCall);
    }
}
