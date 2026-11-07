//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { AggregatorV3Interface } from "./interfaces/AggregatorV3Interface.sol";
import { ICollateralVault } from "collateral-margin/contracts/contracts/interfaces/ICollateralVault.sol";
import { IPortfolioMarginEngine } from "collateral-margin/contracts/contracts/interfaces/IPortfolioMarginEngine.sol";
import { IPointsHook } from "collateral-margin/contracts/contracts/interfaces/IPointsHook.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { HashPowerPerpsDEXBase } from "./HashPowerPerpsDEXBase.sol";

/// @title HashPowerPerpsDEXAdminModule — the bodies of {HashPowerPerpsDEXAdmin}'s owner-only calls
/// @notice Holds the owner-only functions so {HashPowerPerpsDEX} fits EIP-170. Created by the
///         implementation's constructor with the same vault, and run only by delegatecall from
///         the implementation, in the proxy's storage.
/// @dev Same storage layout as the implementation by inheriting {HashPowerPerpsDEXBase}, and
///      declares none of its own. Called directly it has no owner (its initializers are
///      disabled), so every function reverts.
contract HashPowerPerpsDEXAdminModule is HashPowerPerpsDEXBase {
    using EnumerableSet for EnumerableSet.Bytes32Set;

    /// @notice {HashPowerPerpsDEX.VERSION} of the implementation that creates this module.
    string public constant VERSION = "6.17.0";

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(ICollateralVault _vault) HashPowerPerpsDEXBase(_vault) { }

    /// @dev Upgrades go through the implementation, never the module.
    function _authorizeUpgrade(address) internal view override onlyOwner { }

    /// @notice Set the portfolio margin engine for cross-product margin checks.
    /// @dev Every order and every liquidation routes through the engine, and the venue
    ///      never null-checks it, so a wrong address here bricks the book. The engine must
    ///      also aggregate this venue's own vault and answer every risk-parameter read used
    ///      by the venue.
    function setPortfolioMargin(IPortfolioMarginEngine _pm) external onlyOwner {
        if (address(_pm) == address(0)) revert ZeroAddress();
        _setPortfolioMargin(_pm);
    }

    /// @notice Set (or clear) the points/rewards hook. Pass `address(0)` to disable points.
    /// @dev The venue proxy must hold `HOOK_CALLER_ROLE` on the hook BEFORE it is plugged in:
    ///      hook calls are not try/catch-isolated, so a hook that reverts (e.g. missing role,
    ///      or after the POINTS token is finalized) would block fills and liquidations. Clear
    ///      the hook with `address(0)` to disable points instantly.
    function setHook(address _hook) external onlyOwner {
        // Only a code check: `IPointsHook` exposes nothing readable, and both of its entry
        // points mutate state, so a setter has nothing it can safely probe.
        if (_hook != address(0)) _requireContract(_hook);

        hook = IPointsHook(_hook);
        emit HookUpdated(_hook);
    }

    /// @notice Set maker fee in basis points
    /// @param _makerFeeBps Maker fee (e.g., 0 = 0%). Bounded by {_validateFees}.
    function setMakerFeeBps(int16 _makerFeeBps) external onlyOwner {
        _validateFees(_makerFeeBps, takerFeeBps);
        makerFeeBps = _makerFeeBps;
        emit MakerFeeBpsUpdated(_makerFeeBps);
    }

    /// @notice Set taker fee in basis points
    /// @param _takerFeeBps Taker fee (e.g., 5 = 0.05%). Bounded by {_validateFees}.
    function setTakerFeeBps(int16 _takerFeeBps) external onlyOwner {
        _validateFees(makerFeeBps, _takerFeeBps);
        takerFeeBps = _takerFeeBps;
        emit TakerFeeBpsUpdated(_takerFeeBps);
    }

    /// @notice Withdraw accrued trading and liquidation revenue to the venue owner.
    /// @dev Drains the venue's vault account (the fee pot). No separate accumulator.
    function withdrawCollectedFees() external onlyOwner {
        vault.withdrawTo(owner(), _vaultBalance(address(this)));
    }

    /// @notice Set the liquidation fee in basis points on the liquidated notional.
    /// @param _bps Fee in bps (e.g., 50 = 0.5% of the closed position or cancelled order value).
    ///         Capped at `BPS` (100% of notional); same bound as {setLiquidatorShareBps}.
    function setLiquidationFeeBps(uint16 _bps) external onlyOwner {
        _validateBPS(_bps);
        liquidationFeeBps = _bps;
        emit LiquidationFeeBpsUpdated(_bps);
    }

    /// @notice Set the liquidator's share of the liquidation fee in basis points.
    /// @param _bps Share in bps (e.g., 5000 = 50% to liquidator, remainder to venue revenue).
    function setLiquidatorShareBps(uint16 _bps) external onlyOwner {
        _validateBPS(_bps);
        liquidatorShareBps = _bps;
        emit LiquidatorShareBpsUpdated(_bps);
    }

    /// @notice Set the deprecated minimum-margin compatibility value.
    /// @dev Retained with its event for ABI and storage compatibility. Order placement and
    ///      reduction do not enforce this value; portfolio IM is the canonical requirement.
    /// @param _minimumMarginPerOrder Compatibility value reported by the legacy getter.
    function setMinimumMarginPerOrder(uint256 _minimumMarginPerOrder) external onlyOwner {
        minimumMarginPerOrder = _minimumMarginPerOrder;
        emit MinimumMarginPerOrderUpdated(_minimumMarginPerOrder);
    }

    /// @notice Set funding rate parameters
    /// @param _fundingRateMaxBps Max absolute funding rate per period in basis points (e.g., 100 = 1%)
    /// @param _fundingPeriod Time period for max funding rate in seconds (e.g., 86400 = 24 hours)
    function setFundingParameters(uint256 _fundingRateMaxBps, uint256 _fundingPeriod) external onlyOwner {
        if (_fundingPeriod == 0) {
            revert InvalidFundingParameters();
        }

        // Settle any accrued funding before changing parameters
        _updateGlobalFunding();

        fundingRateMaxBps = _fundingRateMaxBps;
        fundingPeriod = _fundingPeriod;

        // Initialize timestamp on first call to prevent retroactive accrual
        if (lastFundingUpdateTime == 0) {
            lastFundingUpdateTime = block.timestamp;
        }

        emit FundingParametersUpdated(_fundingRateMaxBps, _fundingPeriod);
    }

    /// @notice Close the given users' positions at the current mark with no fee, handing each to
    ///         the backstop like a liquidation, so positions keep summing to zero: closing a
    ///         one-sided set moves its net onto the backstop, closing every user leaves it flat.
    ///         Emits `BackstopAssigned` and `PositionLiquidated` so indexers need nothing new.
    /// @dev Only while the vault is halted, so no fill can land between users. Funding is settled
    ///      per user first. Flat users are skipped. Listing the backstop itself only re-marks its
    ///      position (realized against the fund, size unchanged). Resting orders are left alone; they carry no
    ///      exposure until they fill, and {forceCancelOrders} removes them.
    function forceClosePositions(address[] calldata _users) external onlyOwner {
        if (!vault.halted()) revert NotHalted();
        _updateGlobalFunding();
        uint256 mark = _marketPrice();
        for (uint256 i = 0; i < _users.length; i++) {
            address user = _users[i];
            _settleFunding(user);
            int256 netQty = positions[user].netQuantity;
            if (netQty == 0) continue;
            int256 pnl = _closeToBackstop(user, netQty, mark);
            emit PositionLiquidated(user, _msgSender(), netQty, pnl, 0);
        }
    }

    /// @notice Cancel every resting order of the given users, emitting `OrderCancelled` per order
    ///         like a user's own cancel. Realizes nothing, so it runs with or without a halt;
    ///         pair it with `forceClosePositions` to unwind users fully.
    /// @dev Clears each user's aggregate wholesale instead of subtracting per order, so it also
    ///      removes orders placed before 6.10, which the aggregate never counted. Run it as the
    ///      call of any upgrade from before 6.10, for every user with resting orders.
    function forceCancelOrders(address[] calldata _users) external onlyOwner {
        // Funding accrues off the book mid, so checkpoint it before the book changes.
        _updateGlobalFunding();
        for (uint256 i = 0; i < _users.length; i++) {
            address user = _users[i];
            bytes32[] memory orderIds = participantOrderIdsIndex[user].values();
            for (uint256 j = 0; j < orderIds.length; j++) {
                _dropRestingOrder(orderIds[j], false);
            }
            delete userRestingOrderAggregate[user];
        }
    }

    /// @notice Set the price oracle.
    /// @dev Smoke-tests the feed before adopting it. Requires it to already serve a
    ///      positive, initialized round: a feed that never answers reads as price 0,
    ///      which would mark every position at zero.
    function setOracle(AggregatorV3Interface _oracle) external onlyOwner {
        address oracle = address(_oracle);
        if (oracle == address(0)) revert InvalidOracle();
        _requireContract(oracle);

        int256 answer;
        uint256 updatedAt;
        try _oracle.latestRoundData() returns (uint80, int256 _answer, uint256, uint256 _updatedAt, uint80) {
            answer = _answer;
            updatedAt = _updatedAt;
        } catch {
            revert InvalidDependency();
        }
        _validateOracleRound(answer, updatedAt);

        uint8 dec;
        try _oracle.decimals() returns (uint8 _dec) {
            dec = _dec;
        } catch {
            revert InvalidDependency();
        }

        _updateDrift();
        priceOracle = _oracle;
        oracleDecimals = dec;
        _marketPrice();
        _resetDrift(_oracle);
        emit OracleUpdated(oracle);
    }
}
