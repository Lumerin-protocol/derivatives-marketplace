//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { AggregatorV3Interface } from "./interfaces/AggregatorV3Interface.sol";
import { ICollateralVault } from "collateral-margin/contracts/contracts/interfaces/ICollateralVault.sol";
import { IPortfolioMarginEngine } from "collateral-margin/contracts/contracts/interfaces/IPortfolioMarginEngine.sol";
import { HashPowerPerpsDEXBase } from "./HashPowerPerpsDEXBase.sol";
import { HashPowerPerpsDEXAdminModule } from "./HashPowerPerpsDEXAdminModule.sol";

/// @title HashPowerPerpsDEXAdmin — owner-only governance surface for {HashPowerPerpsDEX}
/// @notice Every entry point here is `onlyOwner`, plus the UUPS upgrade authorization
///         hook. Splitting them out keeps {HashPowerPerpsDEX} to the permissionless
///         surface — trading, liquidation and views — so a reader can tell at a glance
///         which calls a counterparty can make and which only governance can.
///         Apart from `setOracle` (which `initialize` calls) the bodies live in
///         {HashPowerPerpsDEXAdminModule}, so the implementation fits EIP-170: each entry
///         point here forwards its calldata there by delegatecall, in the proxy's storage,
///         and the module checks `onlyOwner`.
/// @dev `initialize` stays in {HashPowerPerpsDEX} as deployment lifecycle rather than
///      ongoing governance.
/// @dev Declares **no storage**. It sits between {HashPowerPerpsDEXBase} and
///      {HashPowerPerpsDEX} purely to partition the function surface, and a stateless
///      layer cannot move a slot: state is laid out in linearization order and every
///      variable is declared in {HashPowerPerpsDEXBase}. That property is load-bearing —
///      this contract is deployed behind a UUPS proxy, so any reordering here would
///      corrupt live storage on upgrade. Keep it stateless. If admin-only state is ever
///      needed, declare it in {HashPowerPerpsDEXBase} at the end alongside the existing
///      gap slots.
abstract contract HashPowerPerpsDEXAdmin is HashPowerPerpsDEXBase {
    /// @dev Created with this implementation and the same vault, so its immutables match.
    ///      Bytecode, not storage: the layout is unchanged.
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    address private immutable adminModule;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(ICollateralVault _vault) {
        adminModule = address(new HashPowerPerpsDEXAdminModule(_vault));
    }

    /// @notice Authorize upgrade (only owner)
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner { }

    // ── Dependencies ──────────────────────────────────────────────────────────

    /// @notice See {HashPowerPerpsDEXAdminModule-setPortfolioMargin}.
    function setPortfolioMargin(IPortfolioMarginEngine _pm) external {
        _pm;
        _delegateToAdminModule();
    }

    /// @notice See {HashPowerPerpsDEXAdminModule-setHook}.
    function setHook(address _hook) external {
        _hook;
        _delegateToAdminModule();
    }

    /// @notice See {HashPowerPerpsDEXAdminModule-setOracle}. `initialize` reaches it through
    ///      `_delegateCallAdminModule`, since a stub forwards the transaction's own calldata.
    function setOracle(AggregatorV3Interface _oracle) external {
        _oracle;
        _delegateToAdminModule();
    }

    // ── Fees ──────────────────────────────────────────────────────────────────

    /// @notice See {HashPowerPerpsDEXAdminModule-setMakerFeeBps}.
    function setMakerFeeBps(int16 _makerFeeBps) external {
        _makerFeeBps;
        _delegateToAdminModule();
    }

    /// @notice See {HashPowerPerpsDEXAdminModule-setTakerFeeBps}.
    function setTakerFeeBps(int16 _takerFeeBps) external {
        _takerFeeBps;
        _delegateToAdminModule();
    }

    /// @notice See {HashPowerPerpsDEXAdminModule-withdrawCollectedFees}.
    function withdrawCollectedFees() external {
        _delegateToAdminModule();
    }

    /// @notice See {HashPowerPerpsDEXAdminModule-setLiquidationFeeBps}.
    function setLiquidationFeeBps(uint16 _bps) external {
        _bps;
        _delegateToAdminModule();
    }

    /// @notice See {HashPowerPerpsDEXAdminModule-setLiquidatorShareBps}.
    function setLiquidatorShareBps(uint16 _bps) external {
        _bps;
        _delegateToAdminModule();
    }

    // ── Risk parameters ───────────────────────────────────────────────────────

    /// @notice See {HashPowerPerpsDEXAdminModule-setMinimumMarginPerOrder}.
    function setMinimumMarginPerOrder(uint256 _minimumMarginPerOrder) external {
        _minimumMarginPerOrder;
        _delegateToAdminModule();
    }

    /// @notice See {HashPowerPerpsDEXAdminModule-setFundingParameters}.
    function setFundingParameters(uint256 _fundingRateMaxBps, uint256 _fundingPeriod) external {
        (_fundingRateMaxBps, _fundingPeriod);
        _delegateToAdminModule();
    }

    // ── Escape hatch ──────────────────────────────────────────────────────────

    /// @notice See {HashPowerPerpsDEXAdminModule-forceClosePositions}.
    function forceClosePositions(address[] calldata _users) external {
        _users;
        _delegateToAdminModule();
    }

    /// @notice See {HashPowerPerpsDEXAdminModule-forceCancelOrders}.
    function forceCancelOrders(address[] calldata _users) external {
        _users;
        _delegateToAdminModule();
    }

    /// @dev Run this call's calldata in the admin module, in this contract's storage, and
    ///      return or revert with its result. The stubs keep their parameter names for the ABI
    ///      and name them once only so the compiler does not report them unused; the module
    ///      decodes the calldata itself.
    function _delegateToAdminModule() private {
        address module = adminModule;
        assembly ("memory-safe") {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), module, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }

    /// @dev `_delegateToAdminModule` for a call made from inside this contract, whose calldata
    ///      is not the transaction's: runs `data` in the admin module and reverts with its error.
    function _delegateCallAdminModule(bytes memory data) internal {
        (bool ok, bytes memory result) = adminModule.delegatecall(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(result, 32), mload(result))
            }
        }
    }
}
