// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ICollateralVault } from "collateral-margin/contracts/contracts/interfaces/ICollateralVault.sol";
import { HashPowerPerpsDEX } from "../HashPowerPerpsDEX.sol";

/// @dev Test-only harness for reproducing pre-v2.13 order-cache proxy state.
///      The removed MulticallUpgradeable base was stateless, so it is omitted here
///      to keep the test implementation deployable without changing storage layout;
///      Hardhat also compiles this test-only implementation with a low-runs optimizer.
contract HashPowerPerpsDEXMigrationHarness is HashPowerPerpsDEX {
    constructor(ICollateralVault _vault) HashPowerPerpsDEX(_vault) { }

    /// @dev Clears only the new aggregate while preserving canonical remaining orders.
    function clearOrderAggregateCache(address _user) external {
        delete userOrderAggregate[_user];
    }

    /// @dev Simulates a non-zero legacy flat-liquidation-fee value in the reused slot.
    function setLegacyRevenueSlot(uint256 _value) external {
        collectedFeesBalance = _value;
    }

    function setLegacyOrderCache(
        address _user,
        uint256 _buyQty,
        uint256 _sellQty,
        uint256 _buyValue,
        uint256 _sellValue
    ) external {
        userBuyOrderQty[_user] = _buyQty;
        userSellOrderQty[_user] = _sellQty;
        userBuyOrderValue[_user] = _buyValue;
        userSellOrderValue[_user] = _sellValue;
    }
}
