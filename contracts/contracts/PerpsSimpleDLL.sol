//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { DLL } from "./DLL.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import { AggregatorV3Interface } from "./AggregatorV3Interface.sol";

/// @title Alternative implementation of PerpsSimple using DLL for linked list (untested)
/// @dev Do not update this contract, it's just a reference
contract PerpsSimpleDLL is Initializable, UUPSUpgradeable, OwnableUpgradeable, ERC20Upgradeable {
    using DLL for DLL.List;

    // Couldn't clearly extend the PerpsSimple contract
    // So just swap variables below in the contract
    DLL.List private activeBidPrices;
    DLL.List private activeAskPrices;

    constructor() {
        _disableInitializers();
    }

    /// @notice Authorize upgrade (only owner)
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner { }
}
