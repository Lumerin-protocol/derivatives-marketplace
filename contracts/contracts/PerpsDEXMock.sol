// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IHashPowerPerpsDEX } from "./IHashPowerPerpsDEX.sol";

/// @title PerpsDEXMock — Minimal mock of HashPowerPerpsDEX for options integration tests
contract PerpsDEXMock is IHashPowerPerpsDEX {
    uint8 public constant QUANTITY_DECIMALS = 6;

    mapping(address => Position) private _positions;
    mapping(address => uint256) private _balances;
    mapping(address => int256) private _unrealizedPnl;
    mapping(address => uint256) private _initialMargin;
    mapping(address => uint256) private _maintenanceMargin;

    function decimals() external pure returns (uint8) {
        return 6; // USDC
    }

    function setUserPosition(address user, int256 qty, uint256 entryPrice) external {
        _positions[user] = Position(qty, entryPrice);
    }

    function setBalance(address user, uint256 bal) external {
        _balances[user] = bal;
    }

    function setUnrealizedPnl(address user, int256 pnl) external {
        _unrealizedPnl[user] = pnl;
    }

    function setMargins(address user, uint256 im, uint256 mm) external {
        _initialMargin[user] = im;
        _maintenanceMargin[user] = mm;
    }

    function getUserPosition(address user) external view returns (Position memory) {
        return _positions[user];
    }

    function balanceOf(address user) external view returns (uint256) {
        return _balances[user];
    }

    function getUnrealizedPnl(address user) external view returns (int256) {
        return _unrealizedPnl[user];
    }

    function getInitialMargin(address user) external view returns (uint256) {
        return _initialMargin[user];
    }

    function getMaintenanceMargin(address user) external view returns (uint256) {
        return _maintenanceMargin[user];
    }

    function isLiquidatable(address user) external view returns (bool) {
        if (_positions[user].netQuantity == 0) return false;
        return _balances[user] < _maintenanceMargin[user];
    }
}
