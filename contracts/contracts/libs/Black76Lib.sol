// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { FixedPointMathLib } from "./FixedPointMathLib.sol";

/// @title Black76Lib — Black-76 pricing, Greeks, and IV solver
/// @notice All inputs/outputs in WAD (1e18). Discount factor D = 1 (stablecoin collateral).
/// @dev Core pricing adapted from Derive/Lyra Black76.sol (GPL-3.0).
///      Uses moneyness normalization: price a "standard" option (F=1, D=1),
///      then scale by F. Numerically stable and overflow-safe for uint128 F, K.
///      Additions over Derive: gamma, vega, full Greeks struct, Newton-Raphson IV solver.
library Black76Lib {
    using FixedPointMathLib for uint256;
    using FixedPointMathLib for int256;

    uint256 private constant WAD = 1e18;
    uint256 private constant SECONDS_PER_YEAR = 365 days;

    /// @dev Above this totalVol (sigma*sqrt(T)), standard call ≈ 1.0 and put ≈ moneyness - 1.
    ///      See Derive's proof: at totalVol=24, N(d1)→1, moneyness*N(d2)→0.
    uint256 private constant MAX_TOTAL_VOL = 24e18;

    uint256 private constant MIN_VOL = 0.01e18; // 1%
    uint256 private constant MAX_VOL = 5e18; // 500%
    uint8 private constant MAX_NR_ITERATIONS = 8;
    uint256 private constant NR_PRECISION = 1e8;

    error IVSolverPremiumBelowIntrinsic();
    error InvalidInputs();

    struct Greeks {
        int256 delta; // WAD, signed (+call / -put)
        uint256 gamma; // WAD
        uint256 vega; // WAD
    }

    // ── Pricing ─────────────────────────────────────────────────────────────

    /// @notice Black-76 call and put prices + call delta in one pass.
    /// @param F Forward (perp mark) price, WAD
    /// @param K Strike price, WAD
    /// @param sigma Implied volatility, WAD (e.g. 0.5e18 = 50%)
    /// @param tSec Time to expiry in seconds
    function pricesAndDelta(uint256 F, uint256 K, uint256 sigma, uint256 tSec)
        internal
        pure
        returns (uint256 call, uint256 put, uint256 cDelta)
    {
        unchecked {
            if (K == 0) return (F, 0, WAD);
            if (F == 0) return (0, K, 0);

            uint256 tAnn = _annualise(tSec);
            uint256 totalVol = sigma * FixedPointMathLib.sqrt(tAnn) / WAD;
            uint256 moneyness = K * WAD / F;

            (uint256 stdCall, uint256 stdPut, uint256 stdDelta) = _standardPrices(moneyness, totalVol);

            call = stdCall * F / WAD;
            put = stdPut * F / WAD;
            cDelta = stdDelta;

            // Cap to resolve rounding at extremes
            if (call > F) call = F;
            if (put > K) put = K;
        }
    }

    /// @notice Black-76 call price.
    function callPrice(uint256 F, uint256 K, uint256 sigma, uint256 tSec) internal pure returns (uint256) {
        (uint256 c,,) = pricesAndDelta(F, K, sigma, tSec);
        return c;
    }

    /// @notice Black-76 put price.
    function putPrice(uint256 F, uint256 K, uint256 sigma, uint256 tSec) internal pure returns (uint256) {
        (, uint256 p,) = pricesAndDelta(F, K, sigma, tSec);
        return p;
    }

    // ── Greeks ───────────────────────────────────────────────────────────────

    /// @notice Compute delta, gamma, vega for a single option leg.
    function greeks(uint256 F, uint256 K, uint256 sigma, uint256 tSec, bool isCall)
        internal
        pure
        returns (Greeks memory g)
    {
        if (F == 0 || K == 0 || sigma == 0) revert InvalidInputs();

        (int256 d1, uint256 totalVol, uint256 sqrtT) = _d1Components(F, K, sigma, tSec);

        uint256 nd1 = FixedPointMathLib.stdNormalCDF(d1);
        g.delta = isCall ? int256(nd1) : int256(nd1) - int256(WAD);

        uint256 nPrime = FixedPointMathLib.stdNormal(d1);

        uint256 denom = F * totalVol / WAD;
        g.gamma = denom > 0 ? nPrime * WAD / denom : 0;
        g.vega = F * nPrime / WAD * sqrtT / WAD;
    }

    /// @dev Compute d1, totalVol, and sqrtT — factored out to reduce stack depth.
    function _d1Components(uint256 F, uint256 K, uint256 sigma, uint256 tSec)
        private
        pure
        returns (int256 d1, uint256 totalVol, uint256 sqrtT)
    {
        uint256 tAnn = _annualise(tSec);
        sqrtT = FixedPointMathLib.sqrt(tAnn);
        totalVol = sigma * sqrtT / WAD;
        if (totalVol == 0) totalVol = 1;

        uint256 moneyness = K * WAD / F;
        int256 k = int256(moneyness).ln();
        int256 halfV2t = int256((totalVol >> 1) * totalVol / WAD);
        d1 = (halfV2t - k) * int256(WAD) / int256(totalVol);
    }

    /// @notice Call delta only.
    function callDelta(uint256 F, uint256 K, uint256 sigma, uint256 tSec) internal pure returns (uint256) {
        (,, uint256 d) = pricesAndDelta(F, K, sigma, tSec);
        return d;
    }

    // ── Newton-Raphson IV Solver ────────────────────────────────────────────

    /// @notice Solve for implied volatility given a target premium.
    /// @param F Forward price, WAD
    /// @param K Strike price, WAD
    /// @param tSec Time to expiry in seconds
    /// @param targetPremium Target option premium, WAD
    /// @param isCall True for call, false for put
    /// @return sigma Implied volatility, WAD
    function impliedVol(uint256 F, uint256 K, uint256 tSec, uint256 targetPremium, bool isCall)
        internal
        pure
        returns (uint256 sigma)
    {
        uint256 intrinsic = isCall ? (F > K ? F - K : 0) : (K > F ? K - F : 0);
        if (targetPremium < intrinsic) revert IVSolverPremiumBelowIntrinsic();

        sigma = 0.5e18;
        uint256 lo = MIN_VOL;
        uint256 hi = MAX_VOL;

        for (uint8 i = 0; i < MAX_NR_ITERATIONS; ++i) {
            uint256 modelPrice = isCall ? callPrice(F, K, sigma, tSec) : putPrice(F, K, sigma, tSec);
            int256 diff = int256(modelPrice) - int256(targetPremium);

            if (_abs(diff) < NR_PRECISION) return _clampVol(sigma);

            Greeks memory g = greeks(F, K, sigma, tSec, isCall);
            if (g.vega < NR_PRECISION) {
                // Vega too small for NR — bisect
                if (diff > 0) hi = sigma;
                else lo = sigma;
                sigma = (lo + hi) / 2;
                continue;
            }

            int256 step = diff * int256(WAD) / int256(g.vega);
            int256 newSigma = int256(sigma) - step;

            if (newSigma <= int256(MIN_VOL) || newSigma >= int256(MAX_VOL)) {
                if (diff > 0) hi = sigma;
                else lo = sigma;
                sigma = (lo + hi) / 2;
            } else {
                if (diff > 0) hi = uint256(newSigma);
                else lo = uint256(newSigma);
                sigma = uint256(newSigma);
            }
        }

        return _clampVol(sigma);
    }

    // ── Internal: standard pricing ──────────────────────────────────────────

    /// @dev Standard call price with F=1, D=1. Returns (stdCall, stdDelta).
    ///      stdCall = N(d1) - moneyness * N(d2)
    function _standardCall(uint256 moneyness, uint256 totalVol)
        private
        pure
        returns (uint256 stdCallPrice, uint256 stdCallDelta)
    {
        unchecked {
            if (totalVol >= MAX_TOTAL_VOL) return (WAD, WAD);
            totalVol = totalVol == 0 ? 1 : totalVol;
            moneyness = moneyness == 0 ? 1 : moneyness;

            int256 k = int256(moneyness).ln();
            int256 halfV2t = int256((totalVol >> 1) * totalVol / WAD);
            int256 d1 = (halfV2t - k) * int256(WAD) / int256(totalVol);
            int256 d2 = d1 - int256(totalVol);

            uint256 nd1 = FixedPointMathLib.stdNormalCDF(d1);
            uint256 mNd2 = moneyness * FixedPointMathLib.stdNormalCDF(d2) / WAD;
            return (nd1 >= mNd2 ? nd1 - mNd2 : 0, nd1);
        }
    }

    /// @dev Standard put from call via put-call parity: put = call + K/F - 1.
    function _standardPutFromCall(uint256 moneyness, uint256 stdCallPrice) private pure returns (uint256 stdPutPrice) {
        unchecked {
            uint256 sum = stdCallPrice + moneyness;
            return sum >= WAD ? sum - WAD : 0;
        }
    }

    /// @dev Standard call and put prices + delta.
    function _standardPrices(uint256 moneyness, uint256 totalVol)
        private
        pure
        returns (uint256 stdCall, uint256 stdPut, uint256 stdDelta)
    {
        unchecked {
            (stdCall, stdDelta) = _standardCall(moneyness, totalVol);
            stdPut = _standardPutFromCall(moneyness, stdCall);
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    function _annualise(uint256 secs) private pure returns (uint256) {
        unchecked {
            return secs * WAD / SECONDS_PER_YEAR;
        }
    }

    function _abs(int256 x) private pure returns (uint256) {
        return uint256(x < 0 ? -x : x);
    }

    function _clampVol(uint256 sigma) private pure returns (uint256) {
        if (sigma < MIN_VOL) return MIN_VOL;
        if (sigma > MAX_VOL) return MAX_VOL;
        return sigma;
    }
}
