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

    /// @dev Recreates the legacy `(int256 netQuantity, uint256 aggregatedEntryPrice)`
    ///      bytes in the canonical position slots before an atomic upgrade-and-reset.
    function setLegacyPosition(address _user, int256 _netQuantity, uint256 _legacyAverage) external {
        Position storage position = positions[_user];
        position.netQuantity = _netQuantity;
        assembly {
            sstore(add(position.slot, 1), _legacyAverage)
        }
    }

    function setFundingSnapshot(address _user, int256 _snapshot) external {
        userFundingSnapshot[_user] = _snapshot;
    }

}
