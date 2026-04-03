// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import { AggregatorV3Interface } from "./AggregatorV3Interface.sol";
import { OptionMarketRegistry } from "./OptionMarketRegistry.sol";
import { Black76Lib } from "./libs/Black76Lib.sol";
import { FixedPointMathLib } from "./libs/FixedPointMathLib.sol";

/// @title OptionMarginEngine — Collateral, positions, IV, and margin
/// @notice Holds user collateral, tracks option positions per series,
///         maintains EWMA IV, computes stress-scenario IM/MM margins,
///         and provides health checks for liquidation readiness.
contract OptionMarginEngine is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.UintSet;

    // ── Constants ───────────────────────────────────────────────────────────

    uint256 private constant WAD = 1e18;
    uint256 private constant MAX_ORACLE_STALENESS = 1 hours;

    // ── Types ───────────────────────────────────────────────────────────────

    struct OptionPosition {
        int128 netQuantity; // +long / -short (raw units, lotSize = 1 contract)
    }

    struct IVState {
        uint128 ewmaIV; // WAD (1e18)
        uint64 lastTradeBlock;
    }

    struct MarginConfig {
        uint16 imSpotShockBps; // e.g., 1500 = 15%
        uint16 mmSpotShockBps; // e.g., 1000 = 10%
        uint128 imVolShock; // WAD, e.g., 0.10e18 = 10 vol points
        uint128 mmVolShock; // WAD, e.g., 0.05e18 = 5 vol points
    }

    // ── Errors ──────────────────────────────────────────────────────────────

    error NotRouter();
    error InsufficientCollateral();
    error WithdrawalWouldBreachMargin();
    error MaxSeriesExceeded(address user);
    error OracleStale();
    error InvalidOracle();
    error ZeroAmount();
    error SeriesNotInitialized(uint64 seriesId);
    error IVNotInitialized(uint64 seriesId);

    // ── Events ──────────────────────────────────────────────────────────────

    event CollateralDeposited(address indexed user, uint256 amount, uint256 newBalance);
    event CollateralWithdrawn(address indexed user, uint256 amount, uint256 newBalance);
    event PositionUpdated(address indexed user, uint64 indexed seriesId, int128 newNetQuantity);
    event ImpliedVolUpdated(uint64 indexed seriesId, uint256 newIV, uint256 tradeIV);
    event MarginReserved(address indexed user, uint256 amount, uint256 totalReserved);
    event MarginReleased(address indexed user, uint256 amount, uint256 totalReserved);
    event MarginConfigUpdated(uint16 imSpotBps, uint16 mmSpotBps, uint128 imVolShock, uint128 mmVolShock);
    event RouterUpdated(address indexed newRouter);

    // ── Storage ─────────────────────────────────────────────────────────────

    IERC20 public collateralToken;
    AggregatorV3Interface public oracle;
    OptionMarketRegistry public registry;
    address public router;

    uint8 public tokenDecimals;
    uint8 public oracleDecimals;
    uint8 public maxSeriesPerUser;

    uint128 public ewmaAlpha; // WAD, e.g., 0.2e18
    uint16 public maxIVChangeBps; // per-update cap, e.g., 500 = 5%

    MarginConfig public marginConfig;

    /// @dev User collateral balances in WAD (1e18) for precision
    mapping(address => uint256) private _collateral;
    /// @dev Margin reserved for resting sell orders, WAD
    mapping(address => uint256) private _reservedMargin;
    /// @dev Per-user, per-series option positions
    mapping(address => mapping(uint64 => OptionPosition)) private _positions;
    /// @dev Series IDs where user has open positions (bounded)
    mapping(address => EnumerableSet.UintSet) private _userActiveSeries;
    /// @dev EWMA-smoothed IV per series
    mapping(uint64 => IVState) private _ivStates;

    uint256[35] private __gap;

    // ── Modifiers ───────────────────────────────────────────────────────────

    modifier onlyRouter() {
        if (_msgSender() != router) revert NotRouter();
        _;
    }

    // ── Initializer ─────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _registry,
        address _collateralToken,
        address _oracle
    ) external initializer {
        __Ownable_init(_msgSender());
        __UUPSUpgradeable_init();

        registry = OptionMarketRegistry(_registry);
        collateralToken = IERC20(_collateralToken);
        oracle = AggregatorV3Interface(_oracle);

        tokenDecimals = IERC20Metadata(_collateralToken).decimals();
        oracleDecimals = oracle.decimals();
        maxSeriesPerUser = 20;

        ewmaAlpha = 0.2e18; // 20%
        maxIVChangeBps = 500; // 5%

        marginConfig = MarginConfig({
            imSpotShockBps: 1500, // 15%
            mmSpotShockBps: 1000, // 10%
            imVolShock: 0.10e18, // 10 vol points
            mmVolShock: 0.05e18 // 5 vol points
        });
    }

    // ── Admin ───────────────────────────────────────────────────────────────

    function setRouter(address _router) external onlyOwner {
        router = _router;
        emit RouterUpdated(_router);
    }

    function setMarginConfig(
        uint16 imSpotBps,
        uint16 mmSpotBps,
        uint128 imVolShock,
        uint128 mmVolShock
    ) external onlyOwner {
        marginConfig = MarginConfig(imSpotBps, mmSpotBps, imVolShock, mmVolShock);
        emit MarginConfigUpdated(imSpotBps, mmSpotBps, imVolShock, mmVolShock);
    }

    function setEWMAParams(uint128 _alpha, uint16 _maxChangeBps) external onlyOwner {
        ewmaAlpha = _alpha;
        maxIVChangeBps = _maxChangeBps;
    }

    function setMaxSeriesPerUser(uint8 _max) external onlyOwner {
        maxSeriesPerUser = _max;
    }

    // ── Collateral ──────────────────────────────────────────────────────────

    /// @notice Deposit collateral. Caller must have approved this contract.
    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        collateralToken.safeTransferFrom(_msgSender(), address(this), amount);
        uint256 wadAmount = _toWad(amount);
        _collateral[_msgSender()] += wadAmount;
        emit CollateralDeposited(_msgSender(), amount, _collateral[_msgSender()]);
    }

    /// @notice Withdraw collateral. Reverts if withdrawal would breach IM + reserved.
    function withdraw(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 wadAmount = _toWad(amount);
        if (_collateral[_msgSender()] < wadAmount) revert InsufficientCollateral();

        uint256 newBalance = _collateral[_msgSender()] - wadAmount;
        uint256 required = computeAccountIM(_msgSender()) + _reservedMargin[_msgSender()];
        if (newBalance < required) revert WithdrawalWouldBreachMargin();

        _collateral[_msgSender()] = newBalance;
        collateralToken.safeTransfer(_msgSender(), amount);
        emit CollateralWithdrawn(_msgSender(), amount, newBalance);
    }

    // ── Position updates (called by router on fill) ─────────────────────────

    /// @notice Update a user's position after a fill.
    function updatePosition(address user, uint64 seriesId, int128 deltaQty) external onlyRouter {
        OptionPosition storage pos = _positions[user][seriesId];
        int128 oldQty = pos.netQuantity;
        int128 newQty = oldQty + deltaQty;
        pos.netQuantity = newQty;

        if (oldQty == 0 && newQty != 0) {
            if (_userActiveSeries[user].length() >= maxSeriesPerUser) {
                revert MaxSeriesExceeded(user);
            }
            _userActiveSeries[user].add(uint256(seriesId));
        } else if (oldQty != 0 && newQty == 0) {
            _userActiveSeries[user].remove(uint256(seriesId));
        }

        emit PositionUpdated(user, seriesId, newQty);
    }

    // ── Reserved margin for resting sell orders ─────────────────────────────

    /// @notice Reserve margin for a resting sell order.
    function reserveMargin(address user, uint256 amount) external onlyRouter {
        _reservedMargin[user] += amount;
        emit MarginReserved(user, amount, _reservedMargin[user]);
    }

    /// @notice Release margin when a sell order is cancelled or filled.
    function releaseMargin(address user, uint256 amount) external onlyRouter {
        uint256 current = _reservedMargin[user];
        _reservedMargin[user] = amount > current ? 0 : current - amount;
        emit MarginReleased(user, amount, _reservedMargin[user]);
    }

    /// @notice Transfer premium between accounts (buyer pays seller).
    function transferPremium(address from, address to, uint256 wadAmount) external onlyRouter {
        if (_collateral[from] < wadAmount) revert InsufficientCollateral();
        _collateral[from] -= wadAmount;
        _collateral[to] += wadAmount;
    }

    // ── IV management ───────────────────────────────────────────────────────

    /// @notice Initialize IV for a series (called once, typically at first trade).
    function initializeIV(uint64 seriesId) external {
        if (_ivStates[seriesId].ewmaIV != 0) return; // already initialized
        OptionMarketRegistry.OptionSeries memory s = registry.getSeries(seriesId);
        _ivStates[seriesId] = IVState({
            ewmaIV: uint128(s.initialIV),
            lastTradeBlock: uint64(block.number)
        });
    }

    /// @notice Update EWMA IV after a fill. Router passes the traded premium.
    /// @param seriesId The series
    /// @param tradePremium The premium of the fill (WAD, price per contract)
    /// @param isCall True if this is a call series
    function updateIV(uint64 seriesId, uint256 tradePremium, bool isCall) external onlyRouter {
        IVState storage state = _ivStates[seriesId];
        if (state.ewmaIV == 0) revert IVNotInitialized(seriesId);

        OptionMarketRegistry.OptionSeries memory s = registry.getSeries(seriesId);
        uint256 F = _getForwardPriceWad();
        uint256 K = uint256(s.strikeE8) * _oracleToWadFactor();
        uint256 tSec = s.expiryTs > block.timestamp ? s.expiryTs - block.timestamp : 1;

        uint256 tradeIV = Black76Lib.impliedVol(F, K, tSec, tradePremium, isCall);

        uint256 oldIV = state.ewmaIV;
        uint256 rawNew = (uint256(ewmaAlpha) * tradeIV + (WAD - ewmaAlpha) * oldIV) / WAD;

        // Per-update clamp
        uint256 maxChange = oldIV * maxIVChangeBps / 10000;
        if (rawNew > oldIV + maxChange) rawNew = oldIV + maxChange;
        if (rawNew + maxChange < oldIV) rawNew = oldIV - maxChange;

        // Global bounds
        if (rawNew < 0.01e18) rawNew = 0.01e18;
        if (rawNew > 5e18) rawNew = 5e18;

        state.ewmaIV = uint128(rawNew);
        state.lastTradeBlock = uint64(block.number);

        emit ImpliedVolUpdated(seriesId, rawNew, tradeIV);
    }

    // ── Margin computation ──────────────────────────────────────────────────

    /// @notice Compute total IM for all filled short positions of a user.
    function computeAccountIM(address user) public view returns (uint256 totalIM) {
        return _computeAccountMargin(user, true);
    }

    /// @notice Compute total MM for all filled short positions of a user.
    function computeAccountMM(address user) public view returns (uint256 totalMM) {
        return _computeAccountMargin(user, false);
    }

    /// @notice Compute standalone IM for a hypothetical sell order.
    /// @param seriesId The series
    /// @param size Order size in raw units
    /// @return margin IM amount in WAD
    function computeOrderIM(uint64 seriesId, uint128 size) external view returns (uint256 margin) {
        return _computeSeriesMargin(seriesId, size, true);
    }

    /// @notice Check if account is healthy (collateral >= MM + reserved).
    function isHealthy(address user) external view returns (bool) {
        uint256 mm = computeAccountMM(user);
        return _collateral[user] >= mm + _reservedMargin[user];
    }

    /// @notice Check if a user can place an order requiring additionalIM.
    function canPlaceOrder(address user, uint256 additionalIM) external view returns (bool) {
        uint256 im = computeAccountIM(user);
        return _collateral[user] >= im + _reservedMargin[user] + additionalIM;
    }

    // ── Views ───────────────────────────────────────────────────────────────

    function getCollateral(address user) external view returns (uint256) {
        return _collateral[user];
    }

    function getReservedMargin(address user) external view returns (uint256) {
        return _reservedMargin[user];
    }

    function getPosition(address user, uint64 seriesId) external view returns (int128) {
        return _positions[user][seriesId].netQuantity;
    }

    function getIVState(uint64 seriesId) external view returns (uint128 ewmaIV, uint64 lastTradeBlock) {
        IVState memory s = _ivStates[seriesId];
        return (s.ewmaIV, s.lastTradeBlock);
    }

    function getUserActiveSeriesCount(address user) external view returns (uint256) {
        return _userActiveSeries[user].length();
    }

    function getUserActiveSeriesAt(address user, uint256 index) external view returns (uint64) {
        return uint64(_userActiveSeries[user].at(index));
    }

    function getForwardPrice() external view returns (uint256) {
        return _getForwardPriceWad();
    }

    // ── Internal: margin computation ────────────────────────────────────────

    function _computeAccountMargin(address user, bool isIM) private view returns (uint256 total) {
        uint256 count = _userActiveSeries[user].length();
        if (count == 0) return 0;

        uint256 F = _getForwardPriceWad();

        for (uint256 i = 0; i < count; i++) {
            uint64 seriesId = uint64(_userActiveSeries[user].at(i));
            int128 qty = _positions[user][seriesId].netQuantity;

            if (qty >= 0) continue; // longs need no ongoing margin

            uint128 absQty = uint128(-qty);
            total += _computeSeriesMarginWithF(seriesId, absQty, isIM, F);
        }
    }

    function _computeSeriesMargin(uint64 seriesId, uint128 absQty, bool isIM)
        private
        view
        returns (uint256)
    {
        uint256 F = _getForwardPriceWad();
        return _computeSeriesMarginWithF(seriesId, absQty, isIM, F);
    }

    function _computeSeriesMarginWithF(uint64 seriesId, uint128 absQty, bool isIM, uint256 F)
        private
        view
        returns (uint256)
    {
        IVState memory iv = _ivStates[seriesId];
        if (iv.ewmaIV == 0) return 0;

        uint256 marginPerContract = _stressMargin(seriesId, isIM, F, iv.ewmaIV);
        OptionMarketRegistry.OptionSeries memory s = registry.getSeries(seriesId);
        return marginPerContract * uint256(absQty) / uint256(s.lotSize);
    }

    /// @dev Compute per-contract stress margin for a series.
    function _stressMargin(uint64 seriesId, bool isIM, uint256 F, uint256 sigma)
        private
        view
        returns (uint256)
    {
        (uint256 K, uint256 tSec, bool isCall) = _seriesParams(seriesId);
        Black76Lib.Greeks memory g = Black76Lib.greeks(F, K, sigma, tSec, isCall);
        return _applyShocks(g, F, isIM);
    }

    /// @dev Load series params, converting strike to WAD.
    function _seriesParams(uint64 seriesId)
        private
        view
        returns (uint256 K, uint256 tSec, bool isCall)
    {
        OptionMarketRegistry.OptionSeries memory s = registry.getSeries(seriesId);
        K = uint256(s.strikeE8) * _oracleToWadFactor();
        tSec = s.expiryTs > block.timestamp ? s.expiryTs - block.timestamp : 1;
        isCall = s.isCall;
    }

    /// @dev Apply spot+vol shocks to greeks to get per-contract margin.
    function _applyShocks(Black76Lib.Greeks memory g, uint256 F, bool isIM)
        private
        view
        returns (uint256)
    {
        MarginConfig memory cfg = marginConfig;
        uint256 spotShock = F * (isIM ? cfg.imSpotShockBps : cfg.mmSpotShockBps) / 10000;
        uint256 volShock = isIM ? cfg.imVolShock : cfg.mmVolShock;

        uint256 deltaLoss = FixedPointMathLib.abs(g.delta) * spotShock / WAD;
        uint256 gammaLoss = g.gamma * spotShock / WAD * spotShock / (2 * WAD);
        uint256 vegaLoss = g.vega * volShock / WAD;

        return deltaLoss + gammaLoss + vegaLoss;
    }

    // ── Internal: oracle ────────────────────────────────────────────────────

    function _getForwardPriceWad() private view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = oracle.latestRoundData();
        if (answer <= 0) revert InvalidOracle();
        if (block.timestamp - updatedAt > MAX_ORACLE_STALENESS) revert OracleStale();
        return uint256(answer) * _oracleToWadFactor();
    }

    function _oracleToWadFactor() private view returns (uint256) {
        return 10 ** (18 - uint256(oracleDecimals));
    }

    // ── Internal: precision helpers ─────────────────────────────────────────

    function _toWad(uint256 tokenAmount) private view returns (uint256) {
        return tokenAmount * 10 ** (18 - uint256(tokenDecimals));
    }

    function _fromWad(uint256 wadAmount) private view returns (uint256) {
        return wadAmount / 10 ** (18 - uint256(tokenDecimals));
    }

    // ── Upgrade ─────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
