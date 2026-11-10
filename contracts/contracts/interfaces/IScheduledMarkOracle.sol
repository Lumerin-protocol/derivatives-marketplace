// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice A mark feed whose answer follows the index times a known schedule (`HashpriceGlideUSD`).
interface IScheduledMarkOracle {
    /// @notice The feed's `latestRoundData()` answer and `updatedAt` with its schedule, from one read.
    /// @return mark `latestRoundData()`'s answer
    /// @return updatedAt `latestRoundData()`'s `updatedAt`
    /// @return factor The share of the index the mark keeps (WAD)
    /// @return endFactor The factor the current segment of the schedule ends at (WAD)
    /// @return epoch Changes when the factor resets to 1, in the block the index steps down by
    ///         the previous segment's `endFactor`
    /// @return factorFixedUntil A time before which the factor cannot change (0 when it may change
    ///         any block), so the venue may skip reading it until then
    function latestMarkAndSchedule()
        external
        view
        returns (
            int256 mark,
            uint256 updatedAt,
            uint256 factor,
            uint256 endFactor,
            uint256 epoch,
            uint256 factorFixedUntil
        );
}
