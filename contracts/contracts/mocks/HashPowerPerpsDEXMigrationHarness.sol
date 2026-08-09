// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { MulticallUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/MulticallUpgradeable.sol";
import { ICollateralVault } from "collateral-margin/contracts/contracts/interfaces/ICollateralVault.sol";
import { HashPowerPerpsDEX } from "../HashPowerPerpsDEX.sol";

/// @dev Test-only harness for reproducing pre-v2.13 order-cache proxy state and
///      the legacy embedded-multicall inheritance removed in v2.14.
contract HashPowerPerpsDEXMigrationHarness is HashPowerPerpsDEX, MulticallUpgradeable {
    constructor(ICollateralVault _vault) HashPowerPerpsDEX(_vault) { }

    /// @dev Clears only the new aggregate while preserving canonical remaining orders.
    function clearOrderAggregateCache(address _user) external {
        delete userOrderAggregate[_user];
    }

    /// @dev Retained to reproduce the prior quantity-cache migration independently.
    function clearOrderQuantityCache(address _user) external {
        delete userBuyOrderQty[_user];
        delete userSellOrderQty[_user];
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

    function getLegacyOrderCache(address _user)
        external
        view
        returns (uint256 buyQty, uint256 sellQty, uint256 buyValue, uint256 sellValue)
    {
        return (userBuyOrderQty[_user], userSellOrderQty[_user], userBuyOrderValue[_user], userSellOrderValue[_user]);
    }
}
