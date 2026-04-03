// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import { AggregatorV3Interface } from "./AggregatorV3Interface.sol";
import { OptionMarketRegistry } from "./OptionMarketRegistry.sol";
import { OptionMarginEngine } from "./OptionMarginEngine.sol";

/// @title OptionSettlement — TWAP settlement + cash settlement claims
/// @notice Manages the settlement lifecycle: initiate a TWAP observation window
///         after expiry, record oracle observations, finalize with the TWAP price,
///         and allow users to claim their option payoffs.
contract OptionSettlement is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    // ── Types ───────────────────────────────────────────────────────────────

    struct SettlementWindow {
        uint64 initiatedAt;
        uint64 windowEnd;
        uint256 cumulativePrice; // sum of oracle observations (1e8)
        uint32 observationCount;
        bool finalized;
    }

    // ── Errors ──────────────────────────────────────────────────────────────

    error ExpiryNotReached(uint64 seriesId);
    error AlreadyInitiated(uint64 seriesId);
    error NotInitiated(uint64 seriesId);
    error AlreadyFinalized(uint64 seriesId);
    error WindowClosed(uint64 seriesId);
    error WindowNotElapsed(uint64 seriesId);
    error InsufficientObservations(uint64 seriesId, uint32 have, uint32 need);
    error SeriesNotSettled(uint64 seriesId);
    error NoPosition(uint64 seriesId, address user);
    error InvalidOracle();
    error InvalidWindow();

    // ── Events ──────────────────────────────────────────────────────────────

    event SettlementInitiated(uint64 indexed seriesId, uint64 windowEnd);
    event ObservationRecorded(uint64 indexed seriesId, uint256 price, uint32 count);
    event SettlementFinalized(uint64 indexed seriesId, uint256 twapPrice);
    event SettlementClaimed(uint64 indexed seriesId, address indexed user, int256 pnlWad);

    // ── Storage ─────────────────────────────────────────────────────────────

    OptionMarketRegistry public registry;
    OptionMarginEngine public engine;
    AggregatorV3Interface public oracle;

    uint64 public settlementWindowDuration; // seconds (e.g., 1800 = 30 min)
    uint32 public minObservations;

    mapping(uint64 => SettlementWindow) private _windows;

    uint256[40] private __gap;

    // ── Initializer ─────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _registry,
        address _engine,
        address _oracle,
        uint64 _windowDuration,
        uint32 _minObservations
    ) external initializer {
        __Ownable_init(_msgSender());
        __UUPSUpgradeable_init();

        registry = OptionMarketRegistry(_registry);
        engine = OptionMarginEngine(_engine);
        oracle = AggregatorV3Interface(_oracle);
        settlementWindowDuration = _windowDuration;
        minObservations = _minObservations;
    }

    // ── Admin ───────────────────────────────────────────────────────────────

    function setSettlementWindowDuration(uint64 _duration) external onlyOwner {
        if (_duration == 0) revert InvalidWindow();
        settlementWindowDuration = _duration;
    }

    function setMinObservations(uint32 _min) external onlyOwner {
        minObservations = _min;
    }

    // ── Settlement lifecycle ────────────────────────────────────────────────

    /// @notice Start the TWAP observation window for a series. Callable after expiry.
    ///         Records the first oracle observation immediately.
    function initiateSettlement(uint64 seriesId) external {
        OptionMarketRegistry.OptionSeries memory s = registry.getSeries(seriesId);
        if (block.timestamp < s.expiryTs) revert ExpiryNotReached(seriesId);

        SettlementWindow storage w = _windows[seriesId];
        if (w.initiatedAt != 0) revert AlreadyInitiated(seriesId);

        uint256 price = _readOraclePrice();

        w.initiatedAt = uint64(block.timestamp);
        w.windowEnd = uint64(block.timestamp) + settlementWindowDuration;
        w.cumulativePrice = price;
        w.observationCount = 1;

        emit SettlementInitiated(seriesId, w.windowEnd);
        emit ObservationRecorded(seriesId, price, 1);
    }

    /// @notice Record an oracle price observation during the settlement window.
    function recordObservation(uint64 seriesId) external {
        SettlementWindow storage w = _windows[seriesId];
        if (w.initiatedAt == 0) revert NotInitiated(seriesId);
        if (w.finalized) revert AlreadyFinalized(seriesId);
        if (block.timestamp > w.windowEnd) revert WindowClosed(seriesId);

        uint256 price = _readOraclePrice();
        w.cumulativePrice += price;
        w.observationCount += 1;

        emit ObservationRecorded(seriesId, price, w.observationCount);
    }

    /// @notice Finalize settlement: compute TWAP, mark series as Settled in registry.
    function finalizeSettlement(uint64 seriesId) external {
        SettlementWindow storage w = _windows[seriesId];
        if (w.initiatedAt == 0) revert NotInitiated(seriesId);
        if (w.finalized) revert AlreadyFinalized(seriesId);
        if (block.timestamp < w.windowEnd) revert WindowNotElapsed(seriesId);
        if (w.observationCount < minObservations) {
            revert InsufficientObservations(seriesId, w.observationCount, minObservations);
        }

        uint256 twapPrice = w.cumulativePrice / uint256(w.observationCount);
        w.finalized = true;

        registry.settleSeries(seriesId, twapPrice);

        emit SettlementFinalized(seriesId, twapPrice);
    }

    // ── Claim ───────────────────────────────────────────────────────────────

    /// @notice Claim settlement payoff for the caller's position in a settled series.
    ///         Long holders receive intrinsic value; short holders pay it.
    function claimSettlement(uint64 seriesId) external {
        OptionMarketRegistry.OptionSeries memory s = registry.getSeries(seriesId);
        if (s.status != OptionMarketRegistry.Status.Settled) revert SeriesNotSettled(seriesId);

        int128 position = engine.getPosition(_msgSender(), seriesId);
        if (position == 0) revert NoPosition(seriesId, _msgSender());

        int256 pnlWad = _computePayoff(s, position);

        engine.settlePosition(_msgSender(), seriesId, pnlWad);

        emit SettlementClaimed(seriesId, _msgSender(), pnlWad);
    }

    // ── Views ───────────────────────────────────────────────────────────────

    function getSettlementWindow(uint64 seriesId) external view returns (SettlementWindow memory) {
        return _windows[seriesId];
    }

    /// @notice Preview the payoff for a user's position (view-only).
    function previewPayoff(uint64 seriesId, address user) external view returns (int256 pnlWad) {
        OptionMarketRegistry.OptionSeries memory s = registry.getSeries(seriesId);
        int128 position = engine.getPosition(user, seriesId);
        if (position == 0) return 0;
        return _computePayoff(s, position);
    }

    // ── Internal ────────────────────────────────────────────────────────────

    /// @dev Compute the WAD-denominated payoff for a position given settlement data.
    ///      Call payoff = max(0, settlement - strike). Put payoff = max(0, strike - settlement).
    ///      Long positions receive, short positions pay.
    function _computePayoff(OptionMarketRegistry.OptionSeries memory s, int128 position)
        private
        pure
        returns (int256)
    {
        int256 intrinsicE8;
        if (s.isCall) {
            intrinsicE8 = int256(s.settlementPrice) - int256(uint256(s.strikeE8));
        } else {
            intrinsicE8 = int256(uint256(s.strikeE8)) - int256(s.settlementPrice);
        }
        if (intrinsicE8 < 0) intrinsicE8 = 0;

        // intrinsicE8 → WAD: multiply by 1e10
        // payoff per contract = intrinsicWad * |position| / lotSize
        uint256 intrinsicWad = uint256(intrinsicE8) * 1e10;
        uint256 lotSize = uint256(s.lotSize);

        if (position > 0) {
            return int256(intrinsicWad * uint256(uint128(position)) / lotSize);
        } else {
            return -int256(intrinsicWad * uint256(uint128(-position)) / lotSize);
        }
    }

    function _readOraclePrice() private view returns (uint256) {
        (, int256 answer,,,) = oracle.latestRoundData();
        if (answer <= 0) revert InvalidOracle();
        return uint256(answer);
    }

    // ── Upgrade ─────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
