//SPDX-License-Identifier: MIT
pragma solidity >0.8.10;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract USDCMock is ERC20 {
    uint8 private constant DECIMALS = 6;

    constructor() ERC20("USD Coin", "USDC") {
        _mint(msg.sender, 1_000_000 * 10 ** DECIMALS);
    }

    function decimals() public pure override returns (uint8) {
        return DECIMALS;
    }
}
