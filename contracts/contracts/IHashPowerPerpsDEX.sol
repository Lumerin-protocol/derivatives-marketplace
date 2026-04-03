// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IHashPowerPerpsDEX — Read interface for perps integration (Level 1)
/// @notice Exposes view functions from HashPowerPerpsDEX needed by the options
///         margin engine for shared collateral awareness. Level 1 is read-only:
///         the options system queries perp state but does NOT modify it.
///
///         Level 2 (deferred) would add cross-product portfolio margin where
///         hedged perp + option positions receive margin offsets.
interface IHashPowerPerpsDEX {
    struct Position {
        int256 netQuantity;
        uint256 aggregatedEntryPrice;
    }

    /// @notice User's net perp position.
    function getUserPosition(address user) external view returns (Position memory);

    /// @notice User's perp collateral balance (ERC20 balanceOf on the DEX contract).
    function balanceOf(address user) external view returns (uint256);

    /// @notice Unrealized PnL at current oracle price (includes pending funding).
    function getUnrealizedPnl(address user) external view returns (int256);

    /// @notice Initial margin required for the user's perp position + resting orders.
    function getInitialMargin(address user) external view returns (uint256);

    /// @notice Maintenance margin required for the user's perp position + resting orders.
    function getMaintenanceMargin(address user) external view returns (uint256);

    /// @notice Whether the user's perp account is liquidatable.
    function isLiquidatable(address user) external view returns (bool);

    /// @notice Perp quantity decimals (6).
    function QUANTITY_DECIMALS() external view returns (uint8);

    /// @notice Token decimals of the collateral token used by the DEX.
    function decimals() external view returns (uint8);
}
