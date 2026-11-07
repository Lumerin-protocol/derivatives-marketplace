// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice A mark feed whose answer follows the index times a known schedule (`HashpriceGlideUSD`).
interface IScheduledMarkOracle {
    /// @return factor The share of the index the mark keeps (WAD)
    /// @return endFactor The factor the current segment of the schedule ends at (WAD)
    /// @return epoch Changes when the factor resets to 1, in the block the index steps down by
    ///         the previous segment's `endFactor`
    function latestSchedule() external view returns (uint256 factor, uint256 endFactor, uint256 epoch);
}
