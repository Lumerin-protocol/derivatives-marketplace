// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/// @title OptionMarketRegistry — Series lifecycle and metadata
/// @notice Manages option series (strike, expiry, type), tick/lot sizes,
///         and lifecycle transitions (active → frozen → settled).
contract OptionMarketRegistry is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    // ── Types ───────────────────────────────────────────────────────────────

    enum Status {
        Inactive, // 0 — default / not yet created
        Active, //   1 — open for trading
        Frozen, //   2 — paused, no new orders
        Settled //   3 — expired and settled
    }

    struct OptionSeries {
        uint64 strikeE8; // 1e8 precision (Chainlink-style)
        uint64 expiryTs; // Unix timestamp
        bool isCall;
        uint32 tickSizeE8; // premium tick size (1e8)
        uint32 lotSize; // minimum contract quantity
        Status status;
        uint256 initialIV; // bootstrap IV (1e18 WAD)
        uint256 settlementPrice; // set once at settlement (1e8)
    }

    // ── Errors ──────────────────────────────────────────────────────────────

    error SeriesNotFound(uint64 seriesId);
    error SeriesNotActive(uint64 seriesId);
    error SeriesNotActiveOrFrozen(uint64 seriesId);
    error SeriesAlreadySettled(uint64 seriesId);
    error InvalidStrike();
    error InvalidExpiry();
    error InvalidTickSize();
    error InvalidLotSize();
    error InvalidIV();
    error NotAuthorized();
    error ExpiryNotReached(uint64 seriesId);

    // ── Events ──────────────────────────────────────────────────────────────

    event SeriesCreated(
        uint64 indexed seriesId,
        uint64 strikeE8,
        uint64 expiryTs,
        bool isCall,
        uint32 tickSizeE8,
        uint32 lotSize,
        uint256 initialIV
    );
    event SeriesFrozen(uint64 indexed seriesId);
    event SeriesUnfrozen(uint64 indexed seriesId);
    event SeriesSettled(uint64 indexed seriesId, uint256 settlementPrice);
    event AuthorizedContractSet(address indexed addr, bool authorized);

    // ── Storage ─────────────────────────────────────────────────────────────

    mapping(uint64 => OptionSeries) private _series;
    uint64 public nextSeriesId;

    /// @notice Contracts authorized to call settleSeries (e.g., OptionSettlement).
    mapping(address => bool) public authorizedContracts;

    uint256[47] private __gap;

    // ── Initializer ─────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize() external initializer {
        __Ownable_init(_msgSender());
        __UUPSUpgradeable_init();
        nextSeriesId = 1; // 0 is reserved as "no series"
    }

    // ── Admin ───────────────────────────────────────────────────────────────

    /// @notice Create a new option series.
    /// @return seriesId The newly assigned series ID
    function createSeries(
        uint64 strikeE8,
        uint64 expiryTs,
        bool isCall,
        uint32 tickSizeE8,
        uint32 lotSize,
        uint256 initialIV
    ) external onlyOwner returns (uint64 seriesId) {
        if (strikeE8 == 0) revert InvalidStrike();
        if (expiryTs <= block.timestamp) revert InvalidExpiry();
        if (tickSizeE8 == 0) revert InvalidTickSize();
        if (lotSize == 0) revert InvalidLotSize();
        if (initialIV == 0 || initialIV > 5e18) revert InvalidIV();

        seriesId = nextSeriesId++;

        _series[seriesId] = OptionSeries({
            strikeE8: strikeE8,
            expiryTs: expiryTs,
            isCall: isCall,
            tickSizeE8: tickSizeE8,
            lotSize: lotSize,
            status: Status.Active,
            initialIV: initialIV,
            settlementPrice: 0
        });

        emit SeriesCreated(seriesId, strikeE8, expiryTs, isCall, tickSizeE8, lotSize, initialIV);
    }

    /// @notice Freeze a series — blocks new orders but existing positions remain.
    function freezeSeries(uint64 seriesId) external onlyOwner {
        OptionSeries storage s = _requireSeries(seriesId);
        if (s.status != Status.Active) revert SeriesNotActive(seriesId);
        s.status = Status.Frozen;
        emit SeriesFrozen(seriesId);
    }

    /// @notice Re-activate a frozen series.
    function unfreezeSeries(uint64 seriesId) external onlyOwner {
        OptionSeries storage s = _requireSeries(seriesId);
        if (s.status != Status.Frozen) revert SeriesNotActiveOrFrozen(seriesId);
        s.status = Status.Active;
        emit SeriesUnfrozen(seriesId);
    }

    /// @notice Grant or revoke authorization for a contract (e.g., settlement).
    function setAuthorizedContract(address addr, bool authorized) external onlyOwner {
        authorizedContracts[addr] = authorized;
        emit AuthorizedContractSet(addr, authorized);
    }

    // ── Settlement ──────────────────────────────────────────────────────────

    /// @notice Settle a series. Called by the settlement contract after expiry.
    /// @param seriesId The series to settle
    /// @param settlementPrice TWAP reference price (1e8)
    function settleSeries(uint64 seriesId, uint256 settlementPrice) external {
        if (!authorizedContracts[_msgSender()]) revert NotAuthorized();

        OptionSeries storage s = _requireSeries(seriesId);
        if (s.status == Status.Settled) revert SeriesAlreadySettled(seriesId);
        if (s.status == Status.Inactive) revert SeriesNotFound(seriesId);
        if (block.timestamp < s.expiryTs) revert ExpiryNotReached(seriesId);

        s.status = Status.Settled;
        s.settlementPrice = settlementPrice;
        emit SeriesSettled(seriesId, settlementPrice);
    }

    // ── Views ───────────────────────────────────────────────────────────────

    function getSeries(uint64 seriesId) external view returns (OptionSeries memory) {
        return _series[seriesId];
    }

    function isActive(uint64 seriesId) external view returns (bool) {
        return _series[seriesId].status == Status.Active;
    }

    function isSettled(uint64 seriesId) external view returns (bool) {
        return _series[seriesId].status == Status.Settled;
    }

    function getStatus(uint64 seriesId) external view returns (Status) {
        return _series[seriesId].status;
    }

    // ── Internal ────────────────────────────────────────────────────────────

    function _requireSeries(uint64 seriesId) private view returns (OptionSeries storage s) {
        s = _series[seriesId];
        if (s.status == Status.Inactive) revert SeriesNotFound(seriesId);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
