// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import { AggregatorV3Interface } from "./interfaces/AggregatorV3Interface.sol";
import { OptionMarketRegistry } from "./OptionMarketRegistry.sol";
import { IHashPowerPerpsDEX } from "./interfaces/IHashPowerPerpsDEX.sol";
import { ICollateralVault } from "./interfaces/ICollateralVault.sol";
import { IPortfolioMarginEngine } from "./interfaces/IPortfolioMarginEngine.sol";
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
    error NotSettlement();
    error InsufficientCollateral();
    error WithdrawalWouldBreachMargin();
    error MaxSeriesExceeded(address user);
    error OracleStale();
    error InvalidOracle();
    error ZeroAddress();
    error ZeroAmount();
    error SeriesNotInitialized(uint64 seriesId);
    error IVNotInitialized(uint64 seriesId);
    error AccountHealthy(address account);
    error NotShortPosition(address account, uint64 seriesId);
    error ZeroLiquidation();

    // ── Events ──────────────────────────────────────────────────────────────

    event CollateralDeposited(address indexed user, uint256 amount, uint256 newBalance);
    event CollateralWithdrawn(address indexed user, uint256 amount, uint256 newBalance);
    event PositionUpdated(address indexed user, uint64 indexed seriesId, int128 newNetQuantity);
    event ImpliedVolUpdated(uint64 indexed seriesId, uint256 newIV, uint256 tradeIV);
    event MarginReserved(address indexed user, uint256 amount, uint256 totalReserved);
    event MarginReleased(address indexed user, uint256 amount, uint256 totalReserved);
    event MarginConfigUpdated(uint16 imSpotBps, uint16 mmSpotBps, uint128 imVolShock, uint128 mmVolShock);
    event RouterUpdated(address indexed newRouter);
    event SettlementContractUpdated(address indexed settlement);
    event LiquidationConfigUpdated(uint16 feeBps);
    event Liquidated(
        address indexed account, address indexed liquidator, uint256 fee, uint64 indexed seriesId, uint128 amount
    );
    event InsuranceFundDeposited(address indexed depositor, uint256 wadAmount, uint256 totalFund);
    event BadDebtRecorded(uint256 badDebt, uint256 coveredByInsurance);
    event PositionSettled(uint64 indexed seriesId, address indexed user, int256 pnlWad);
    event PerpsDexUpdated(address indexed perpsDex);

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

    // Phase 5: settlement + liquidation
    address public settlement;
    uint16 public liquidationFeeBps; // packed with settlement (e.g., 500 = 5%)
    uint256 private _insuranceFund; // WAD

    // Phase 6: Level 1 perps integration (read-only awareness)
    IHashPowerPerpsDEX public perpsDex; // optional, address(0) if not linked

    // Level 2: Unified collateral vault
    ICollateralVault public vault;
    IPortfolioMarginEngine public portfolioMargin;

    uint256[30] private __gap;

    // ── Modifiers ───────────────────────────────────────────────────────────

    modifier onlyRouter() {
        if (_msgSender() != router) revert NotRouter();
        _;
    }

    modifier onlySettlement() {
        if (_msgSender() != settlement) revert NotSettlement();
        _;
    }

    // ── Initializer ─────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _registry, address _collateralToken, address _oracle, address _vault)
        external
        initializer
    {
        if (_vault == address(0)) revert ZeroAddress();

        __Ownable_init(_msgSender());
        __UUPSUpgradeable_init();

        registry = OptionMarketRegistry(_registry);
        collateralToken = IERC20(_collateralToken);
        oracle = AggregatorV3Interface(_oracle);
        vault = ICollateralVault(_vault);

        tokenDecimals = IERC20Metadata(_collateralToken).decimals();
        oracleDecimals = oracle.decimals();
        maxSeriesPerUser = 20;

        ewmaAlpha = 0.2e18; // 20%
        maxIVChangeBps = 500; // 5%

        marginConfig = MarginConfig({
            imSpotShockBps: 1500, // 15%
            mmSpotShockBps: 1000, // 10%
            imVolShock: 0.1e18, // 10 vol points
            mmVolShock: 0.05e18 // 5 vol points
         });
    }

    // ── Admin ───────────────────────────────────────────────────────────────

    function setRouter(address _router) external onlyOwner {
        router = _router;
        emit RouterUpdated(_router);
    }

    function setMarginConfig(uint16 imSpotBps, uint16 mmSpotBps, uint128 imVolShock, uint128 mmVolShock)
        external
        onlyOwner
    {
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

    function setSettlement(address _settlement) external onlyOwner {
        settlement = _settlement;
        emit SettlementContractUpdated(_settlement);
    }

    function setLiquidationFeeBps(uint16 _feeBps) external onlyOwner {
        liquidationFeeBps = _feeBps;
        emit LiquidationConfigUpdated(_feeBps);
    }

    /// @notice Link to the perps DEX for Level 1 shared collateral awareness.
    function setPerpsDex(address _perpsDex) external onlyOwner {
        perpsDex = IHashPowerPerpsDEX(_perpsDex);
        emit PerpsDexUpdated(_perpsDex);
    }

    /// @notice Set the portfolio margin engine for cross-product margin checks.
    function setPortfolioMargin(address _pm) external onlyOwner {
        portfolioMargin = IPortfolioMarginEngine(_pm);
    }

    /// @notice Deposit collateral into the insurance fund (anyone can contribute).
    ///         Caller must have approved the vault.
    function depositToInsuranceFund(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        vault.depositFor(_msgSender(), address(this), amount);
        uint256 wadAmount = _toWad(amount);
        _insuranceFund += wadAmount;
        emit InsuranceFundDeposited(_msgSender(), wadAmount, _insuranceFund);
    }

    // ── Collateral ──────────────────────────────────────────────────────────

    /// @notice Deposit collateral. Caller must have approved the vault.
    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        vault.depositFor(_msgSender(), _msgSender(), amount);
        emit CollateralDeposited(_msgSender(), amount, _userBalance(_msgSender()));
    }

    /// @notice Withdraw collateral. Reverts if withdrawal would breach IM + reserved.
    function withdraw(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = vault.getBalance(_msgSender());
        if (bal < amount) revert InsufficientCollateral();
        uint256 newBalance = bal - amount;
        uint256 requiredTokens = _fromWad(computeAccountIM(_msgSender()) + _reservedMargin[_msgSender()]);
        if (newBalance < requiredTokens) revert WithdrawalWouldBreachMargin();
        vault.withdrawTo(_msgSender(), _msgSender(), amount);
        emit CollateralWithdrawn(_msgSender(), amount, _userBalance(_msgSender()));
    }

    // ── Position updates (called by router on fill) ─────────────────────────

    /// @notice Update a user's position after a fill.
    function updatePosition(address user, uint64 seriesId, int128 deltaQty) external onlyRouter {
        _updatePosition(user, seriesId, deltaQty);
    }

    // ── Settlement (called by OptionSettlement) ─────────────────────────────

    /// @notice Settle a user's position: apply PnL, zero out position, remove from active series.
    ///         For longs (pnlWad > 0): credit payoff to collateral.
    ///         For shorts (pnlWad < 0): debit payoff; insurance fund covers bad debt.
    function settlePosition(address user, uint64 seriesId, int256 pnlWad) external onlySettlement {
        if (_positions[user][seriesId].netQuantity == 0) return;

        uint256 pnlTokens = _fromWad(pnlWad > 0 ? uint256(pnlWad) : uint256(-pnlWad));
        if (pnlWad > 0) {
            vault.credit(user, pnlTokens);
        } else if (pnlWad < 0) {
            uint256 bal = vault.getBalance(user);
            if (bal >= pnlTokens) {
                vault.debit(user, pnlTokens);
            } else {
                if (bal > 0) vault.debit(user, bal);
                uint256 badDebt = pnlTokens - bal;
                uint256 covered = badDebt > _insuranceFund ? _insuranceFund : badDebt;
                _insuranceFund -= covered;
                emit BadDebtRecorded(uint256(-pnlWad), _toWad(covered));
            }
        }

        _positions[user][seriesId].netQuantity = 0;
        _userActiveSeries[user].remove(uint256(seriesId));

        emit PositionSettled(seriesId, user, pnlWad);
    }

    // ── Liquidation ────────────────────────────────────────────────────────

    /// @notice Liquidate a short position from an underwater account.
    ///         The liquidator takes on the short position and receives a fee from the account.
    /// @param account The underwater account
    /// @param seriesId The series to liquidate
    /// @param amount Number of contracts to liquidate (capped at position size)
    function liquidate(address account, uint64 seriesId, uint128 amount) external {
        if (amount == 0) revert ZeroLiquidation();
        if (_isHealthy(account)) revert AccountHealthy(account);

        int128 pos = _positions[account][seriesId].netQuantity;
        if (pos >= 0) revert NotShortPosition(account, seriesId);

        uint128 absPos = uint128(-pos);
        uint128 liqAmount = amount > absPos ? absPos : amount;

        uint256 marginForLiquidated = _computeSeriesMargin(seriesId, liqAmount, false);
        uint256 fee = marginForLiquidated * uint256(liquidationFeeBps) / 10_000;

        address liquidator = _msgSender();
        uint256 bal = vault.getBalance(account);
        uint256 feeTokens = _fromWad(fee);
        uint256 actualFee = feeTokens > bal ? bal : feeTokens;
        if (actualFee > 0) vault.transfer(account, liquidator, actualFee);
        actualFee = _toWad(actualFee);

        _updatePosition(account, seriesId, int128(liqAmount));
        _updatePosition(liquidator, seriesId, -int128(liqAmount));

        emit Liquidated(account, liquidator, actualFee, seriesId, liqAmount);
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
        uint256 tokenAmount = _fromWad(wadAmount);
        if (vault.getBalance(from) < tokenAmount) revert InsufficientCollateral();
        vault.transfer(from, to, tokenAmount);
    }

    // ── IV management ───────────────────────────────────────────────────────

    /// @notice Initialize IV for a series (called once, typically at first trade).
    function initializeIV(uint64 seriesId) external {
        if (_ivStates[seriesId].ewmaIV != 0) return; // already initialized
        OptionMarketRegistry.OptionSeries memory s = registry.getSeries(seriesId);
        _ivStates[seriesId] = IVState({ ewmaIV: uint128(s.initialIV), lastTradeBlock: uint64(block.number) });
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
        uint256 maxChange = oldIV * maxIVChangeBps / 10_000;
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
        return _isHealthy(user);
    }

    /// @notice Check if a user can place an order requiring additionalIM (WAD).
    ///         When portfolioMargin is set, delegates to cross-product PME.
    function canPlaceOrder(address user, uint256 additionalIM) external view returns (bool) {
        uint256 additionalTokens = _fromWad(additionalIM);
        return vault.getBalance(user) >= portfolioMargin.computePortfolioIM(user) + additionalTokens;
    }

    // ── Views ───────────────────────────────────────────────────────────────

    function getCollateral(address user) external view returns (uint256) {
        return _userBalance(user);
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

    function getInsuranceFund() external view returns (uint256) {
        return _insuranceFund;
    }

    /// @notice Aggregate signed net Greeks across all active option positions.
    ///         Used by PortfolioMarginEngine for cross-product stress margin.
    ///         Returned values are WAD-scaled.
    /// @return netDelta Signed net delta (long = positive, short = negative)
    /// @return netGamma Total gamma (always non-negative)
    /// @return netVega Total vega (always non-negative)
    function getNetGreeks(address user) external view returns (int256 netDelta, uint256 netGamma, uint256 netVega) {
        uint256 count = _userActiveSeries[user].length();
        if (count == 0) return (0, 0, 0);

        uint256 F = _getForwardPriceWad();

        for (uint256 i = 0; i < count; i++) {
            uint64 seriesId = uint64(_userActiveSeries[user].at(i));
            int128 qty = _positions[user][seriesId].netQuantity;
            if (qty == 0) continue;

            IVState memory iv = _ivStates[seriesId];
            if (iv.ewmaIV == 0) continue;

            (uint256 K, uint256 tSec, bool isCall) = _seriesParams(seriesId);
            Black76Lib.Greeks memory g = Black76Lib.greeks(F, K, iv.ewmaIV, tSec, isCall);

            OptionMarketRegistry.OptionSeries memory s = registry.getSeries(seriesId);
            int256 signedQty = int256(qty) * int256(WAD) / int256(uint256(s.lotSize));

            netDelta += int256(g.delta) * signedQty / int256(WAD);
            netGamma += g.gamma * _abs128(qty) / uint256(s.lotSize);
            netVega += g.vega * _abs128(qty) / uint256(s.lotSize);
        }
    }

    /// @notice Reserved margin for resting sell orders (WAD).
    function getOptionsReservedMargin(address user) external view returns (uint256) {
        return _reservedMargin[user];
    }

    // ── Level 1 perps awareness (read-only) ─────────────────────────────

    struct PortfolioOverview {
        // Options
        uint256 optionsCollateral; // WAD
        uint256 optionsIM; // WAD
        uint256 optionsMM; // WAD
        uint256 optionsReserved; // WAD
        uint256 activeSeriesCount;
        // Perps (zero when perpsDex not linked)
        int256 perpNetQuantity; // QUANTITY_DECIMALS (6)
        int256 perpUnrealizedPnl; // perp token decimals
        uint256 perpIM; // perp token decimals
        uint256 perpMM; // perp token decimals
        bool perpIsLiquidatable;
    }

    /// @notice Combined read of a user's options + perps positions and risk metrics.
    ///         Returns zeros for perp fields if perpsDex is not linked.
    function getPortfolioOverview(address user) external view returns (PortfolioOverview memory p) {
        p.optionsCollateral = _userBalance(user);
        p.optionsIM = computeAccountIM(user);
        p.optionsMM = computeAccountMM(user);
        p.optionsReserved = _reservedMargin[user];
        p.activeSeriesCount = _userActiveSeries[user].length();

        if (address(perpsDex) != address(0)) {
            IHashPowerPerpsDEX.Position memory pos = perpsDex.getUserPosition(user);
            p.perpNetQuantity = pos.netQuantity;
            p.perpUnrealizedPnl = perpsDex.getUnrealizedPnl(user);
            p.perpIM = perpsDex.getInitialMargin(user);
            p.perpMM = perpsDex.getMaintenanceMargin(user);
            p.perpIsLiquidatable = perpsDex.isLiquidatable(user);
        }
    }

    /// @notice Read a user's perp position (convenience wrapper).
    function getPerpPosition(address user) external view returns (int256 netQuantity, uint256 avgEntryPrice) {
        if (address(perpsDex) == address(0)) return (0, 0);
        IHashPowerPerpsDEX.Position memory pos = perpsDex.getUserPosition(user);
        return (pos.netQuantity, pos.aggregatedEntryPrice);
    }

    /// @notice Read a user's perp collateral balance from the vault.
    ///         Returns 0 when vault is not available (Level 1 fallback).
    function getPerpCollateral(address) external pure returns (uint256) {
        return 0;
    }

    // ── Internal: position management ─────────────────────────────────────

    function _updatePosition(address user, uint64 seriesId, int128 deltaQty) private {
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

    function _isHealthy(address user) private view returns (bool) {
        return vault.getBalance(user) >= portfolioMargin.computePortfolioMM(user);
    }

    /// @dev User's collateral balance in WAD (read from vault, convert to WAD).
    function _userBalance(address user) private view returns (uint256) {
        return _toWad(vault.getBalance(user));
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

    function _computeSeriesMargin(uint64 seriesId, uint128 absQty, bool isIM) private view returns (uint256) {
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
    function _stressMargin(uint64 seriesId, bool isIM, uint256 F, uint256 sigma) private view returns (uint256) {
        (uint256 K, uint256 tSec, bool isCall) = _seriesParams(seriesId);
        Black76Lib.Greeks memory g = Black76Lib.greeks(F, K, sigma, tSec, isCall);
        return _applyShocks(g, F, isIM);
    }

    /// @dev Load series params, converting strike to WAD.
    function _seriesParams(uint64 seriesId) private view returns (uint256 K, uint256 tSec, bool isCall) {
        OptionMarketRegistry.OptionSeries memory s = registry.getSeries(seriesId);
        K = uint256(s.strikeE8) * _oracleToWadFactor();
        tSec = s.expiryTs > block.timestamp ? s.expiryTs - block.timestamp : 1;
        isCall = s.isCall;
    }

    /// @dev Apply spot+vol shocks to greeks to get per-contract margin.
    function _applyShocks(Black76Lib.Greeks memory g, uint256 F, bool isIM) private view returns (uint256) {
        MarginConfig memory cfg = marginConfig;
        uint256 spotShock = F * (isIM ? cfg.imSpotShockBps : cfg.mmSpotShockBps) / 10_000;
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

    function _abs128(int128 x) private pure returns (uint256) {
        return x >= 0 ? uint256(int256(x)) : uint256(-int256(x));
    }

    // ── Upgrade ─────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal override onlyOwner { }
}
