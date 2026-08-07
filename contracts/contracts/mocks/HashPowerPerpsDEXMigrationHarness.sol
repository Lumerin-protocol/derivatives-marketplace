// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ICollateralVault } from "collateral-margin/contracts/contracts/interfaces/ICollateralVault.sol";
import { HashPowerPerpsDEX } from "../HashPowerPerpsDEX.sol";

/// @dev Test-only harness for reproducing pre-quantity-cache proxy state.
contract HashPowerPerpsDEXMigrationHarness is HashPowerPerpsDEX {
    constructor(ICollateralVault _vault) HashPowerPerpsDEX(_vault) { }

    function clearOrderQuantityCache(address _user) external {
        delete userBuyOrderQty[_user];
        delete userSellOrderQty[_user];
    }
}
