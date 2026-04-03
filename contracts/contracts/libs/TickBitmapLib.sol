// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title TickBitmapLib — Bitmap for tracking populated price levels
/// @notice Adapted from Uniswap v3 TickBitmap for uint64 price ticks.
///         Each bit represents a price level; set = has orders, unset = empty.
///         Enables O(1) lookup of the next populated level in a 256-tick window.
library TickBitmapLib {
    error TickBitmapEmpty();

    /// @dev Compute word position and bit position within that word.
    /// @param tick The price level (uint64 priceTicks)
    /// @return wordPos Index into the bitmap mapping
    /// @return bitPos Bit index within the word (0-255)
    function position(uint64 tick) internal pure returns (uint256 wordPos, uint8 bitPos) {
        wordPos = uint256(tick) >> 8;
        bitPos = uint8(uint256(tick) & 0xFF);
    }

    /// @notice Toggle the bit for a tick. Call when a price level becomes populated or empty.
    /// @param self The bitmap storage mapping
    /// @param tick The price level to flip
    function flipTick(mapping(uint256 => uint256) storage self, uint64 tick) internal {
        (uint256 wordPos, uint8 bitPos) = position(tick);
        self[wordPos] ^= (1 << bitPos);
    }

    /// @notice Check if a tick has its bit set (has orders).
    function isInitialized(mapping(uint256 => uint256) storage self, uint64 tick) internal view returns (bool) {
        (uint256 wordPos, uint8 bitPos) = position(tick);
        return (self[wordPos] & (1 << bitPos)) != 0;
    }

    /// @notice Find the next initialized tick less than or equal to `tick` within the same word.
    ///         Used for walking bids (descending order).
    /// @param self The bitmap storage mapping
    /// @param tick The starting tick (inclusive)
    /// @return next The next initialized tick, or 0 if none found
    /// @return found True if a tick was found within this word
    function nextInitializedTickLte(mapping(uint256 => uint256) storage self, uint64 tick)
        internal
        view
        returns (uint64 next, bool found)
    {
        (uint256 wordPos, uint8 bitPos) = position(tick);
        // Mask: all bits at bitPos and below
        uint256 mask = (1 << (uint256(bitPos) + 1)) - 1;
        uint256 masked = self[wordPos] & mask;

        if (masked != 0) {
            uint8 msb = _mostSignificantBit(masked);
            next = uint64((wordPos << 8) | msb);
            found = true;
        }
    }

    /// @notice Find the next initialized tick greater than or equal to `tick` within the same word.
    ///         Used for walking asks (ascending order).
    /// @param self The bitmap storage mapping
    /// @param tick The starting tick (inclusive)
    /// @return next The next initialized tick, or 0 if none found
    /// @return found True if a tick was found within this word
    function nextInitializedTickGte(mapping(uint256 => uint256) storage self, uint64 tick)
        internal
        view
        returns (uint64 next, bool found)
    {
        (uint256 wordPos, uint8 bitPos) = position(tick);
        // Mask: all bits at bitPos and above
        uint256 mask = ~((1 << uint256(bitPos)) - 1);
        uint256 masked = self[wordPos] & mask;

        if (masked != 0) {
            uint8 lsb = _leastSignificantBit(masked);
            next = uint64((wordPos << 8) | lsb);
            found = true;
        }
    }

    /// @notice Scan across word boundaries to find the next initialized tick <= tick.
    /// @param self The bitmap storage mapping
    /// @param tick Starting tick (inclusive)
    /// @param minTick Stop searching below this tick
    /// @return next The next initialized tick
    /// @return found True if found
    function nextBid(mapping(uint256 => uint256) storage self, uint64 tick, uint64 minTick)
        internal
        view
        returns (uint64 next, bool found)
    {
        // First check current word
        (next, found) = nextInitializedTickLte(self, tick);
        if (found && next >= minTick) return (next, true);

        // Walk previous words
        (uint256 wordPos,) = position(tick);
        (uint256 minWordPos,) = position(minTick);

        while (wordPos > minWordPos) {
            wordPos--;
            uint256 word = self[wordPos];
            if (word != 0) {
                uint8 msb = _mostSignificantBit(word);
                next = uint64((wordPos << 8) | msb);
                if (next >= minTick) return (next, true);
                return (0, false);
            }
        }

        return (0, false);
    }

    /// @notice Scan across word boundaries to find the next initialized tick >= tick.
    /// @param self The bitmap storage mapping
    /// @param tick Starting tick (inclusive)
    /// @param maxTick Stop searching above this tick
    /// @return next The next initialized tick
    /// @return found True if found
    function nextAsk(mapping(uint256 => uint256) storage self, uint64 tick, uint64 maxTick)
        internal
        view
        returns (uint64 next, bool found)
    {
        // First check current word
        (next, found) = nextInitializedTickGte(self, tick);
        if (found && next <= maxTick) return (next, true);

        // Walk next words
        (uint256 wordPos,) = position(tick);
        (uint256 maxWordPos,) = position(maxTick);

        while (wordPos < maxWordPos) {
            wordPos++;
            uint256 word = self[wordPos];
            if (word != 0) {
                uint8 lsb = _leastSignificantBit(word);
                next = uint64((wordPos << 8) | lsb);
                if (next <= maxTick) return (next, true);
                return (0, false);
            }
        }

        return (0, false);
    }

    // ── Bit scanning ────────────────────────────────────────────────────────

    /// @dev Find the index of the most significant set bit (0-255).
    function _mostSignificantBit(uint256 x) private pure returns (uint8 r) {
        assert(x > 0);
        assembly {
            let f := shl(7, gt(x, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF))
            r := f
            x := shr(f, x)
            f := shl(6, gt(x, 0xFFFFFFFFFFFFFFFF))
            r := or(r, f)
            x := shr(f, x)
            f := shl(5, gt(x, 0xFFFFFFFF))
            r := or(r, f)
            x := shr(f, x)
            f := shl(4, gt(x, 0xFFFF))
            r := or(r, f)
            x := shr(f, x)
            f := shl(3, gt(x, 0xFF))
            r := or(r, f)
            x := shr(f, x)
            f := shl(2, gt(x, 0xF))
            r := or(r, f)
            x := shr(f, x)
            f := shl(1, gt(x, 0x3))
            r := or(r, f)
            x := shr(f, x)
            r := or(r, gt(x, 1))
        }
    }

    /// @dev Find the index of the least significant set bit (0-255).
    function _leastSignificantBit(uint256 x) private pure returns (uint8 r) {
        assert(x > 0);
        assembly {
            // Isolate the lowest set bit
            x := and(x, sub(0, x))
        }
        // Now x is a power of 2; find its log2
        r = _mostSignificantBit(x);
    }
}
