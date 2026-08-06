//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { StructuredLinkedList } from "solidity-linked-list/contracts/StructuredLinkedList.sol";
import { AggregatorV3Interface } from "./interfaces/AggregatorV3Interface.sol";
import { ICollateralVault } from "collateral-margin/contracts/contracts/interfaces/ICollateralVault.sol";
import { IPortfolioMarginEngine } from "collateral-margin/contracts/contracts/interfaces/IPortfolioMarginEngine.sol";
import { IPointsHook } from "collateral-margin/contracts/contracts/interfaces/IPointsHook.sol";
import { HashPowerPerpsDEXBase } from "./HashPowerPerpsDEXBase.sol";

/// @title HashPowerPerpsDEXAdmin — owner-only governance surface for {HashPowerPerpsDEX}
/// @notice Every entry point here is `onlyOwner`, plus the UUPS upgrade authorization
///         hook. Splitting them out keeps {HashPowerPerpsDEX} to the permissionless
///         surface — trading, liquidation and views — so a reader can tell at a glance
///         which calls a counterparty can make and which only governance can.
/// @dev The initializers stay in {HashPowerPerpsDEX}: `initializeV2` is `onlyOwner` too,
///      but it belongs with `initialize` as deployment/upgrade lifecycle rather than
///      ongoing governance, and splitting the two apart would read worse than either.
/// @dev Declares **no storage**. It sits between {HashPowerPerpsDEXBase} and
///      {HashPowerPerpsDEX} purely to partition the function surface, and a stateless
///      layer cannot move a slot: state is laid out in linearization order and every
///      variable is declared in {HashPowerPerpsDEXBase}. That property is load-bearing —
///      this contract is deployed behind a UUPS proxy, so any reordering here would
///      corrupt live storage on upgrade. Keep it stateless. If admin-only state is ever
///      needed, declare it in {HashPowerPerpsDEXBase} at the end alongside the existing
///      gap slots.
abstract contract HashPowerPerpsDEXAdmin is HashPowerPerpsDEXBase {
    using EnumerableSet for EnumerableSet.AddressSet;
    using StructuredLinkedList for StructuredLinkedList.List;

    /// @notice Authorize upgrade (only owner)
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner { }

    // ── Dependencies ──────────────────────────────────────────────────────────

    /// @notice Set the portfolio margin engine for cross-product margin checks.
    /// @dev Every order and every liquidation routes through the engine, and the venue
    ///      never null-checks it, so a wrong address here bricks the book. The engine must
    ///      also aggregate this venue's own vault.
    function setPortfolioMargin(IPortfolioMarginEngine _pm) external onlyOwner {
        address pm = address(_pm);
        if (pm == address(0)) revert ZeroAddress();
        _requireContract(pm);

        // Probe the order-margin read rather than `computePortfolioIM`: it is what every
        // order placement calls, and unlike the IM path it needs no oracle, so wiring a
        // venue must not depend on the engine's feed being set yet.
        try _pm.linearOrderMargin(0) returns (uint256) { }
        catch {
            revert InvalidDependency();
        }

        try _pm.vault() returns (ICollateralVault pinned) {
            if (address(pinned) != address(vault)) revert VaultMismatch();
        } catch {
            revert InvalidDependency();
        }

        portfolioMargin = _pm;
        emit PortfolioMarginUpdated(pm);
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

    /// @notice Set the price oracle.
    /// @dev Smoke-tests the feed before adopting it. Requires it to already serve a
    ///      positive, initialized round: a feed that never answers reads as price 0,
    ///      which would mark every position at zero.
    /// @dev `public` rather than `external` because `initialize` wires the first feed
    ///      through here — it runs after `__Ownable_init`, so `onlyOwner` is satisfied.
    function setOracle(AggregatorV3Interface _oracle) public onlyOwner {
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
        if (answer <= 0 || updatedAt == 0) revert InvalidOracle();

        uint8 dec;
        try _oracle.decimals() returns (uint8 _dec) {
            dec = _dec;
        } catch {
            revert InvalidDependency();
        }

        priceOracle = _oracle;
        oracleDecimals = dec;
        emit OracleUpdated(oracle);
    }

    // ── Fees ──────────────────────────────────────────────────────────────────

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

    /// @notice Set the liquidation fee in basis points on the liquidated notional.
    /// @param _bps Fee in bps (e.g., 50 = 0.5% of the closed position or cancelled order value).
    function setLiquidationFeeBps(uint16 _bps) external onlyOwner {
        liquidationFeeBps = _bps;
        emit LiquidationFeeBpsUpdated(_bps);
    }

    /// @notice Set the liquidator's share of the liquidation fee in basis points.
    /// @param _bps Share in bps (e.g., 5000 = 50% to liquidator, remainder to insurance fund).
    function setLiquidatorShareBps(uint16 _bps) external onlyOwner {
        if (_bps > BPS) revert InvalidMarginPercent();
        liquidatorShareBps = _bps;
        emit LiquidatorShareBpsUpdated(_bps);
    }

    // ── Risk parameters ───────────────────────────────────────────────────────

    /// @notice Set minimum margin per resting order (in collateral token units)
    /// @param _minimumMarginPerOrder Minimum margin locked per resting order (0 = no minimum)
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

    // ── Testnet maintenance ───────────────────────────────────────────────────

    /// @notice Reset all trading state (orders, positions, funding, nonce)
    /// @dev Intended for testnet use to wipe state without redeploying. ERC20 balances are not touched.
    function resetState() external onlyOwner {
        // Clear all bid orders and price levels
        (, uint256 price) = activeBidPrices.getNextNode(0);
        while (price != 0) {
            (, uint256 nextPrice) = activeBidPrices.getNextNode(price);
            _clearPriceLevelOrders(price, true);
            activeBidPrices.remove(price);
            price = nextPrice;
        }

        // Clear all ask orders and price levels
        (, price) = activeAskPrices.getNextNode(0);
        while (price != 0) {
            (, uint256 nextPrice) = activeAskPrices.getNextNode(price);
            _clearPriceLevelOrders(price, false);
            activeAskPrices.remove(price);
            price = nextPrice;
        }

        // Clear all positions and per-user funding snapshots
        address[] memory users = usersWithPositions.values();
        for (uint256 i = 0; i < users.length; i++) {
            delete userFundingSnapshot[users[i]];
            delete positions[users[i]];
            usersWithPositions.remove(users[i]);
        }

        cumulativeFundingPerUnit = 0;
        lastFundingUpdateTime = 0;
        // nonce = 0;
        emit LiquidationFeeBpsUpdated(liquidationFeeBps);
        emit LiquidatorShareBpsUpdated(liquidatorShareBps);
        emit MatchFeeUpdated(takerFeeBps, makerFeeBps);
        emit MinimumMarginPerOrderUpdated(minimumMarginPerOrder);
        emit FundingParametersUpdated(fundingRateMaxBps, fundingPeriod);
    }
}
