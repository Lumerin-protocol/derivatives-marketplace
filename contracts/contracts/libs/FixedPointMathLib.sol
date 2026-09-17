// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.0;

/**
 * @title FixedPointMathLib
 * @notice Library for some useful fixed point math functions
 * With inspiration from: https://github.com/recmo/experiment-solexp/blob/main/src/FixedPointMathLib.sol
 */
library FixedPointMathLib {
    /// @dev Magic numbers for normal CDF
    uint256 private constant N0 = 4_062_099_735_652_764_000_328;
    uint256 private constant N1 = 4_080_670_594_171_652_639_712;
    uint256 private constant N2 = 2_067_498_006_223_917_203_771;
    uint256 private constant N3 = 625_581_961_353_917_287_603;
    uint256 private constant N4 = 117_578_849_504_046_139_487;
    uint256 private constant N5 = 12_919_787_143_353_136_591;
    uint256 private constant N6 = 650_478_250_178_244_362;
    uint256 private constant M0 = 8_124_199_471_305_528_000_657;
    uint256 private constant M1 = 14_643_514_515_380_871_948_050;
    uint256 private constant M2 = 11_756_730_424_506_726_822_413;
    uint256 private constant M3 = 5_470_644_798_650_576_484_341;
    uint256 private constant M4 = 1_600_821_957_476_871_612_085;
    uint256 private constant M5 = 296_331_772_558_254_578_451;
    uint256 private constant M6 = 32_386_342_837_845_824_709;
    uint256 private constant M7 = 1_630_477_228_166_597_028;
    uint256 private constant SQRT_TWOPI_BASE2 = 46_239_130_270_042_206_915;

    /// @dev Computes ln(x) for a 1e27 fixed point. Loses 9 last significant digits of precision.
    function lnPrecise(int256 x) internal pure returns (int256 r) {
        return ln(x / 1e9) * 1e9;
    }

    /// @dev Computes e ^ x for a 1e27 fixed point. Loses 9 last significant digits of precision.
    function expPrecise(int256 x) internal pure returns (uint256 r) {
        return exp(x / 1e9) * 1e9;
    }

    /// @dev Computes ln(x) in 1e18 fixed point. Reverts if x is negative or zero. Consumes 670 gas.
    function ln(int256 x) internal pure returns (int256 r) {
        unchecked {
            if (x < 1) {
                if (x < 0) {
                    revert LnNegativeUndefined();
                }
                revert Overflow();
            }

            // We want to convert x from 10**18 fixed point to 2**96 fixed point.
            // We do this by multiplying by 2**96 / 10**18.
            // But since ln(x * C) = ln(x) + ln(C), we can simply do nothing here
            // and add ln(2**96 / 10**18) at the end.

            // Reduce range of x to (1, 2) * 2**96
            // ln(2^k * x) = k * ln(2) + ln(x)
            // Note: inlining ilog2 saves 8 gas.
            int256 k = int256(ilog2(uint256(x))) - 96;
            x <<= uint256(159 - k);
            x = int256(uint256(x) >> 159);

            // Evaluate using a (8, 8)-term rational approximation
            // p is made monic, we will multiply by a scale factor later
            int256 p = x + 3_273_285_459_638_523_848_632_254_066_296;
            p = ((p * x) >> 96) + 24_828_157_081_833_163_892_658_089_445_524;
            p = ((p * x) >> 96) + 43_456_485_725_739_037_958_740_375_743_393;
            p = ((p * x) >> 96) - 11_111_509_109_440_967_052_023_855_526_967;
            p = ((p * x) >> 96) - 45_023_709_667_254_063_763_336_534_515_857;
            p = ((p * x) >> 96) - 14_706_773_417_378_608_786_704_636_184_526;
            p = p * x - (795_164_235_651_350_426_258_249_787_498 << 96);
            //emit log_named_int("p", p);
            // We leave p in 2**192 basis so we don't need to scale it back up for the division.
            // q is monic by convention
            int256 q = x + 5_573_035_233_440_673_466_300_451_813_936;
            q = ((q * x) >> 96) + 71_694_874_799_317_883_764_090_561_454_958;
            q = ((q * x) >> 96) + 283_447_036_172_924_575_727_196_451_306_956;
            q = ((q * x) >> 96) + 401_686_690_394_027_663_651_624_208_769_553;
            q = ((q * x) >> 96) + 204_048_457_590_392_012_362_485_061_816_622;
            q = ((q * x) >> 96) + 31_853_899_698_501_571_402_653_359_427_138;
            q = ((q * x) >> 96) + 909_429_971_244_387_300_277_376_558_375;
            assembly {
                // Div in assembly because solidity adds a zero check despite the `unchecked`.
                // The q polynomial is known not to have zeros in the domain. (All roots are complex)
                // No scaling required because p is already 2**96 too large.
                r := sdiv(p, q)
            }
            // r is in the range (0, 0.125) * 2**96

            // Finalization, we need to
            // * multiply by the scale factor s = 5.549…
            // * add ln(2**96 / 10**18)
            // * add k * ln(2)
            // * multiply by 10**18 / 2**96 = 5**18 >> 78
            // mul s * 5e18 * 2**96, base is now 5**18 * 2**192
            r *= 1_677_202_110_996_718_588_342_820_967_067_443_963_516_166;
            // add ln(2) * k * 5e18 * 2**192
            r += 16_597_577_552_685_614_221_487_285_958_193_947_469_193_820_559_219_878_177_908_093_499_208_371 * k;
            // add ln(2**96 / 10**18) * 5e18 * 2**192
            r += 600_920_179_829_731_861_736_702_779_321_621_459_595_472_258_049_074_101_567_377_883_020_018_308;
            // base conversion: mul 2**18 / 2**192
            r >>= 174;
        }
    }

    // Integer log2
    // @returns floor(log2(x)) if x is nonzero, otherwise 0. This is the same
    //          as the location of the highest set bit.
    // Consumes 232 gas. This could have been an 3 gas EVM opcode though.
    function ilog2(uint256 x) internal pure returns (uint256 r) {
        assembly {
            r := shl(7, lt(0xffffffffffffffffffffffffffffffff, x))
            r := or(r, shl(6, lt(0xffffffffffffffff, shr(r, x))))
            r := or(r, shl(5, lt(0xffffffff, shr(r, x))))
            r := or(r, shl(4, lt(0xffff, shr(r, x))))
            r := or(r, shl(3, lt(0xff, shr(r, x))))
            r := or(r, shl(2, lt(0xf, shr(r, x))))
            r := or(r, shl(1, lt(0x3, shr(r, x))))
            r := or(r, lt(0x1, shr(r, x)))
        }
    }

    // Computes e^x in 1e18 fixed point.
    // consumes 500 gas
    function exp(int256 x) internal pure returns (uint256 r) {
        unchecked {
            // Input x is in fixed point format, with scale factor 1/1e18.

            // When the result is < 0.5 we return zero. This happens when
            // x <= floor(log(0.5e18) * 1e18) ~ -42e18
            if (x <= -42_139_678_854_452_767_551) {
                return 0;
            }

            // When the result is > (2**255 - 1) / 1e18 we can not represent it
            // as an int256. This happens when x >= floor(log((2**255 -1) / 1e18) * 1e18) ~ 135.
            if (x >= 135_305_999_368_893_231_589) {
                revert ExpOverflow();
            }

            // x is now in the range (-42, 136) * 1e18. Convert to (-42, 136) * 2**96
            // for more intermediate precision and a binary basis. This base conversion
            // is a multiplication by 1e18 / 2**96 = 5**18 / 2**78.
            x = (x << 78) / 5 ** 18;

            // Reduce range of x to (-½ ln 2, ½ ln 2) * 2**96 by factoring out powers of two
            // such that exp(x) = exp(x') * 2**k, where k is an integer.
            // Solving this gives k = round(x / log(2)) and x' = x - k * log(2).
            int256 k = ((x << 96) / 54_916_777_467_707_473_351_141_471_128 + 2 ** 95) >> 96;
            x = x - k * 54_916_777_467_707_473_351_141_471_128;
            // k is in the range [-61, 195].

            // Evaluate using a (6, 7)-term rational approximation
            // p is made monic, we will multiply by a scale factor later
            int256 p = x + 2_772_001_395_605_857_295_435_445_496_992;
            p = ((p * x) >> 96) + 44_335_888_930_127_919_016_834_873_520_032;
            p = ((p * x) >> 96) + 398_888_492_587_501_845_352_592_340_339_721;
            p = ((p * x) >> 96) + 1_993_839_819_670_624_470_859_228_494_792_842;
            p = p * x + (4_385_272_521_454_847_904_632_057_985_693_276 << 96);
            // We leave p in 2**192 basis so we don't need to scale it back up for the division.
            // Evaluate using using Knuth's scheme from p. 491.
            int256 z = x + 750_530_180_792_738_023_273_180_420_736;
            z = ((z * x) >> 96) + 32_788_456_221_302_202_726_307_501_949_080;
            int256 w = x - 2_218_138_959_503_481_824_038_194_425_854;
            w = ((w * z) >> 96) + 892_943_633_302_991_980_437_332_862_907_700;
            int256 q = z + w - 78_174_809_823_045_304_726_920_794_422_040;
            q = ((q * w) >> 96) + 4_203_224_763_890_128_580_604_056_984_195_872;
            assembly {
                // Div in assembly because solidity adds a zero check despite the `unchecked`.
                // The q polynomial is known not to have zeros in the domain. (All roots are complex)
                // No scaling required because p is already 2**96 too large.
                r := sdiv(p, q)
            }
            // r should be in the range (0.09, 0.25) * 2**96.

            // We now need to multiply r by
            //  * the scale factor s = ~6.031367120...,
            //  * the 2**k factor from the range reduction, and
            //  * the 1e18 / 2**96 factor for base converison.
            // We do all of this at once, with an intermediate result in 2**213 basis
            // so the final right shift is always by a positive amount.
            r = (uint256(r) * 3_822_833_074_963_236_453_042_738_258_902_158_003_155_416_615_667) >> uint256(195 - k);
        }
    }

    /// @notice Calculates the square root of x, rounding down (borrowed from https://ethereum.stackexchange.com/a/97540)
    /// @dev Uses the Babylonian method https://en.wikipedia.org/wiki/Methods_of_computing_square_roots#Babylonian_method.
    /// @param x The uint256 number for which to calculate the square root.
    /// @return result The result as an uint256.
    function _sqrt(uint256 x) internal pure returns (uint256 result) {
        if (x == 0) {
            return 0;
        }

        // Calculate the square root of the perfect square of a power of two that is the closest to x.
        uint256 xAux = uint256(x);
        result = 1;
        if (xAux >= 0x100000000000000000000000000000000) {
            xAux >>= 128;
            result <<= 64;
        }
        if (xAux >= 0x10000000000000000) {
            xAux >>= 64;
            result <<= 32;
        }
        if (xAux >= 0x100000000) {
            xAux >>= 32;
            result <<= 16;
        }
        if (xAux >= 0x10000) {
            xAux >>= 16;
            result <<= 8;
        }
        if (xAux >= 0x100) {
            xAux >>= 8;
            result <<= 4;
        }
        if (xAux >= 0x10) {
            xAux >>= 4;
            result <<= 2;
        }
        if (xAux >= 0x4) {
            result <<= 1;
        }

        // The operations can never overflow because the result is max 2^127 when it enters this block.
        unchecked {
            result = (result + x / result) >> 1;
            result = (result + x / result) >> 1;
            result = (result + x / result) >> 1;
            result = (result + x / result) >> 1;
            result = (result + x / result) >> 1;
            result = (result + x / result) >> 1;
            result = (result + x / result) >> 1; // Seven iterations should be enough
            uint256 roundedDownResult = x / result;
            return result >= roundedDownResult ? roundedDownResult : result;
        }
    }

    /**
     * @dev Returns the square root of a value using Newton's method.
     */
    function sqrt(uint256 x) internal pure returns (uint256) {
        // Add in an extra unit factor for the square root to gobble;
        // otherwise, sqrt(x * UNIT) = sqrt(x) * sqrt(UNIT)
        return _sqrt(x * 1e18);
    }

    /**
     * @dev Compute the absolute value of `val`.
     *
     * @param val The number to absolute value.
     */
    function abs(int256 val) internal pure returns (uint256) {
        return uint256(val < 0 ? -val : val);
    }

    /**
     * @dev The standard normal distribution of the value.
     */
    function stdNormal(int256 x) internal pure returns (uint256) {
        int256 y = ((x >> 1) * x) / 1e18;
        return (exp(-y) * 1e18) / 2_506_628_274_631_000_502;
    }

    /**
     * @dev The standard normal cumulative distribution of the value.
     * borrowed from a C++ implementation https://stackoverflow.com/a/23119456
     * original paper: http://www.codeplanet.eu/files/download/accuratecumnorm.pdf
     * consumes 1800 gas
     */
    function stdNormalCDF(int256 x) internal pure returns (uint256) {
        unchecked {
            uint256 z = abs(x);
            uint256 c;
            if (z > 37 * 1e18) {
                return (x <= 0) ? c : uint256(1e18 - int256(c));
            } else {
                // z^2 cannot overflow in this "else" block
                uint256 e = exp(-int256(((z >> 1) * z) / 1e18));

                // convert to binary base with factor 1e18 / 2**64 = 5**18 / 2**46.
                // z cant overflow with z < 37 * 1e18 range we're in
                // e cant overflow since its at most 1.0 (at z=0)

                z = (z << 46) / 5 ** 18;
                e = (e << 46) / 5 ** 18;

                if (
                    z < 130_438_178_253_327_725_388 // 7071067811865470000 in decimal (7.07)
                ) {
                    // Hart's algorithm for x \in (-7.07, 7.07)
                    uint256 n;
                    uint256 d;

                    n = ((N6 * z) >> 64) + N5;
                    n = ((n * z) >> 64) + N4;
                    n = ((n * z) >> 64) + N3;
                    n = ((n * z) >> 64) + N2;
                    n = ((n * z) >> 64) + N1;
                    n = ((n * z) >> 64) + N0;

                    d = ((M7 * z) >> 64) + M6;
                    d = ((d * z) >> 64) + M5;
                    d = ((d * z) >> 64) + M4;
                    d = ((d * z) >> 64) + M3;
                    d = ((d * z) >> 64) + M2;
                    d = ((d * z) >> 64) + M1;
                    d = ((d * z) >> 64) + M0;

                    c = (n * e);
                    assembly {
                        // Div in assembly because solidity adds a zero check despite the `unchecked`
                        // denominator d is a polynomial with non-negative z and, all magic numbers are positive
                        // no need to scale since c = (n * e) is already 2^64 times larger
                        c := div(c, d)
                    }
                } else {
                    // continued fracton approximation for abs(x) \in (7.07, 37)
                    uint256 f;
                    f = 11_990_383_647_911_208_550; // 13/20 ratio in base 2^64
                    f = (4 << 128) / (z + f);
                    f = (3 << 128) / (z + f);
                    f = (2 << 128) / (z + f);
                    f = (1 << 128) / (z + f);
                    f += z;
                    f = (f * SQRT_TWOPI_BASE2) >> 64;
                    e = (e << 64);
                    assembly {
                        // Div in assembly because solidity adds a zero check despite the `unchecked`
                        // denominator f is a finite continued fraction that attains min value of 0.4978 at z=37.0
                        // so it cannot underflow into 0
                        // no need to scale since e is made 2^64 times larger on the line above
                        c := div(e, f)
                    }
                }
            }

            c = (c * (5 ** 18)) >> 46;
            c = (x <= 0) ? c : uint256(1e18 - int256(c));
            return c;
        }
    }

    /// @dev Calculates a^b
    function decPow(int256 a, int256 b) internal pure returns (uint256) {
        return exp(ln(a) * b / 1e18);
    }

    error Overflow();
    error ExpOverflow();
    error LnNegativeUndefined();
}
