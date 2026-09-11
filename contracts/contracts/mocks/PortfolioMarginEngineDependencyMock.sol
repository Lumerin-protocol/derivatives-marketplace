// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ICollateralVault } from "collateral-margin/contracts/contracts/interfaces/ICollateralVault.sol";

/// @dev Test dependency whose individual PME capability probes can be made to revert.
contract PortfolioMarginEngineDependencyMock {
    ICollateralVault private immutable pinnedVault;
    uint8 private immutable failingCapability;

    constructor(ICollateralVault _vault, uint8 _failingCapability) {
        pinnedVault = _vault;
        failingCapability = _failingCapability;
    }

    function vault() external view returns (ICollateralVault) {
        if (failingCapability == 1) revert();
        return pinnedVault;
    }

    function linearOrderMargin(uint256) external view returns (uint256) {
        if (failingCapability == 2) revert();
        return 0;
    }

    function imSpotShock() external view returns (uint256) {
        if (failingCapability == 3) revert();
        return 0;
    }

    function mmSpotShock() external view returns (uint256) {
        if (failingCapability == 4) revert();
        return 0;
    }
}
