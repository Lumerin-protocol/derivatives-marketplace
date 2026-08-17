// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Decimal-configurable collateral used to test the Perps constructor boundary.
contract CollateralTokenMock is ERC20 {
    uint8 private immutable _tokenDecimals;

    constructor(uint8 decimals_) ERC20("Collateral Mock", "COLL") {
        _tokenDecimals = decimals_;
        _mint(msg.sender, 1_000_000 * 10 ** decimals_);
    }

    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
    }
}
