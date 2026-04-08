// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ICollateralVault — Interface for the unified collateral vault
/// @notice Both the perps DEX and options engine use this interface to
///         read balances and perform authorized transfers/credits/debits.
interface ICollateralVault {
    /// @notice User's collateral balance in token decimals.
    function getBalance(address user) external view returns (uint256);

    /// @notice Transfer balance between two accounts. Authorized callers only.
    function transfer(address from, address to, uint256 amount) external;

    /// @notice Credit (increase) a user's balance. Authorized callers only.
    function credit(address user, uint256 amount) external;

    /// @notice Debit (decrease) a user's balance. Authorized callers only.
    function debit(address user, uint256 amount) external;

    /// @notice Pull collateral from `source`, credit `account`'s balance.
    ///         `source` must have approved this vault. Authorized callers only.
    function depositFor(address source, address account, uint256 amount) external;

    /// @notice Debit `account`'s balance and send collateral to `recipient`.
    ///         Authorized callers only.
    function withdrawTo(address account, address recipient, uint256 amount) external;
}
