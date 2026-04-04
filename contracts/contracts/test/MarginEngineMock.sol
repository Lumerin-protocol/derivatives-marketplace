// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MarginEngineMock — Minimal mock for CollateralVault withdrawal checks
contract MarginEngineMock {
    mapping(address => uint256) private _im;

    function setIM(address user, uint256 amount) external {
        _im[user] = amount;
    }

    function computePortfolioIM(address user) external view returns (uint256) {
        return _im[user];
    }
}
