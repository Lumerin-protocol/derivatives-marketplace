// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import { OptionMarketRegistry } from "./OptionMarketRegistry.sol";
import { OptionOrderBook } from "./OptionOrderBook.sol";
import { OptionMarginEngine } from "./OptionMarginEngine.sol";

/// @title OptionMatchingRouter — Order lifecycle orchestration
/// @notice Single entry-point for submitting and cancelling option orders.
///         Validates inputs, enforces margin, walks the order book to match,
///         transfers premium, updates positions, updates EWMA IV, and rests
///         residual quantity on the book.
contract OptionMatchingRouter is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    // ── Types ───────────────────────────────────────────────────────────────

    enum OrderType {
        LIMIT, // match then rest remainder
        IOC,   // match only, discard remainder
        FOK    // fill-or-kill: revert if not fully fillable
    }

    struct SubmitParams {
        uint64 seriesId;
        bool isBuy;
        uint64 priceTicks;
        uint128 size;
        OrderType orderType;
        bool postOnly;
        bool reduceOnly;
    }

    struct SubmitResult {
        uint64 orderId;     // resting order ID (0 if nothing rested)
        uint128 filledSize; // total contracts matched
        uint128 restedSize; // contracts placed on book
    }

    /// @dev Bundled context threaded through the matching loop to avoid stack depth issues.
    struct MatchCtx {
        uint64 seriesId;
        address taker;
        bool takerIsBuy;
        uint64 takerPriceTicks;
        uint32 tickSizeE8;
        uint32 lotSize;
    }

    // ── Errors ──────────────────────────────────────────────────────────────

    error SeriesNotActive(uint64 seriesId);
    error InvalidPrice();
    error SizeNotOnLot(uint128 size, uint32 lotSize);
    error PostOnlyWouldMatch();
    error FOKNotFillable();
    error ReduceOnlyNoPosition();
    error InsufficientMargin(address user);
    error NotOrderOwner(uint64 orderId);
    error InvalidParams();

    // ── Events ──────────────────────────────────────────────────────────────

    event OrderMatched(
        uint64 indexed seriesId,
        uint64 takerOrderId,
        uint64 makerOrderId,
        uint64 priceTicks,
        uint128 fillSize,
        address buyer,
        address seller
    );

    // ── Storage ─────────────────────────────────────────────────────────────

    OptionMarketRegistry public registry;
    OptionOrderBook public book;
    OptionMarginEngine public engine;

    /// @dev Reserved IM per resting sell order (for proportional release on fill)
    mapping(uint64 => uint256) private _orderReservedIM;

    uint256[40] private __gap;

    // ── Initializer ─────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _registry, address _book, address _engine) external initializer {
        __Ownable_init(_msgSender());
        __UUPSUpgradeable_init();
        registry = OptionMarketRegistry(_registry);
        book = OptionOrderBook(_book);
        engine = OptionMarginEngine(_engine);
    }

    // ── Submit Order ────────────────────────────────────────────────────────

    /// @notice Submit an order: validate, match against the book, rest residual.
    function submitOrder(SubmitParams calldata p) external returns (SubmitResult memory result) {
        if (p.priceTicks == 0) revert InvalidPrice();
        if (p.postOnly && p.orderType != OrderType.LIMIT) revert InvalidParams();

        OptionMarketRegistry.OptionSeries memory s = registry.getSeries(p.seriesId);
        if (s.status != OptionMarketRegistry.Status.Active) revert SeriesNotActive(p.seriesId);
        if (p.size == 0 || p.size % uint128(s.lotSize) != 0) {
            revert SizeNotOnLot(p.size, s.lotSize);
        }

        address trader = _msgSender();
        uint128 tradableSize = p.size;

        // ReduceOnly: cap size at current opposite position
        if (p.reduceOnly) {
            tradableSize = _applyReduceOnly(trader, p.seriesId, p.isBuy, tradableSize);
        }

        // Ensure IV is bootstrapped for this series
        engine.initializeIV(p.seriesId);

        // PostOnly: revert if order would immediately match
        if (p.postOnly) {
            _assertPostOnly(p.seriesId, p.isBuy, p.priceTicks);
        }

        // Pre-trade margin check for sell orders
        if (!p.isBuy) {
            uint256 orderIM = engine.computeOrderIM(p.seriesId, tradableSize);
            if (!engine.canPlaceOrder(trader, orderIM)) revert InsufficientMargin(trader);
        }

        // Match against the opposing book
        uint128 remaining = tradableSize;
        uint64 lastFillTick;
        if (!p.postOnly && remaining > 0) {
            MatchCtx memory ctx = MatchCtx({
                seriesId: p.seriesId,
                taker: trader,
                takerIsBuy: p.isBuy,
                takerPriceTicks: p.priceTicks,
                tickSizeE8: s.tickSizeE8,
                lotSize: s.lotSize
            });
            (remaining, lastFillTick) = _match(ctx, remaining);
        }
        result.filledSize = tradableSize - remaining;

        // FOK: revert if not fully filled
        if (p.orderType == OrderType.FOK && remaining > 0) revert FOKNotFillable();

        // IV update (once, using last fill price)
        if (result.filledSize > 0 && lastFillTick > 0) {
            uint256 tradePremiumWad = uint256(lastFillTick) * uint256(s.tickSizeE8) * 1e10;
            engine.updateIV(p.seriesId, tradePremiumWad, s.isCall);
        }

        // Rest remainder on book (LIMIT and postOnly only)
        if (remaining > 0 && (p.orderType == OrderType.LIMIT || p.postOnly)) {
            result.orderId = book.placeOrder(
                p.seriesId, trader, p.isBuy, p.priceTicks,
                remaining, p.postOnly, p.reduceOnly
            );
            result.restedSize = remaining;

            // Reserve IM for resting sell orders
            if (!p.isBuy) {
                uint256 restIM = engine.computeOrderIM(p.seriesId, remaining);
                engine.reserveMargin(trader, restIM);
                _orderReservedIM[result.orderId] = restIM;
            }
        }
    }

    // ── Cancel Order ────────────────────────────────────────────────────────

    /// @notice Cancel a resting order. Only the order owner can cancel.
    function cancelOrder(uint64 orderId) external {
        OptionOrderBook.Order memory o = book.getOrder(orderId);
        if (o.trader != _msgSender()) revert NotOrderOwner(orderId);
        if (o.remaining == 0) return; // already filled/cancelled

        book.cancelOrder(orderId);

        // Release reserved IM for sell orders
        if (!o.isBuy) {
            uint256 reserved = _orderReservedIM[orderId];
            if (reserved > 0) {
                engine.releaseMargin(o.trader, reserved);
                delete _orderReservedIM[orderId];
            }
        }
    }

    // ── Post-settlement cleanup ────────────────────────────────────────────

    /// @notice Cancel resting orders that belong to a settled series.
    ///         Callable by anyone — once a series is settled, orders are void.
    ///         Releases reserved IM for sell orders.
    function cancelSettledOrders(uint64[] calldata orderIds) external {
        for (uint256 i = 0; i < orderIds.length; i++) {
            uint64 orderId = orderIds[i];
            OptionOrderBook.Order memory o = book.getOrder(orderId);
            if (o.remaining == 0) continue;

            OptionMarketRegistry.OptionSeries memory s = registry.getSeries(o.seriesId);
            if (s.status != OptionMarketRegistry.Status.Settled) continue;

            book.cancelOrder(orderId);

            if (!o.isBuy) {
                uint256 reserved = _orderReservedIM[orderId];
                if (reserved > 0) {
                    engine.releaseMargin(o.trader, reserved);
                    delete _orderReservedIM[orderId];
                }
            }
        }
    }

    // ── Views ───────────────────────────────────────────────────────────────

    function getOrderReservedIM(uint64 orderId) external view returns (uint256) {
        return _orderReservedIM[orderId];
    }

    // ── Internal: matching engine ───────────────────────────────────────────

    function _match(MatchCtx memory ctx, uint128 remaining)
        private
        returns (uint128, uint64 lastFillTick)
    {
        while (remaining > 0) {
            (uint64 makerOrderId, uint64 makerTick) = ctx.takerIsBuy
                ? book.bestAsk(ctx.seriesId)
                : book.bestBid(ctx.seriesId);

            if (makerTick == 0) break;
            if (ctx.takerIsBuy && makerTick > ctx.takerPriceTicks) break;
            if (!ctx.takerIsBuy && makerTick < ctx.takerPriceTicks) break;

            OptionOrderBook.Order memory maker = book.getOrder(makerOrderId);
            uint128 fillSize = remaining < maker.remaining ? remaining : maker.remaining;

            book.fillOrder(makerOrderId, fillSize);
            _settleFill(ctx, maker.trader, makerOrderId, makerTick, fillSize);

            remaining -= fillSize;
            lastFillTick = makerTick;
        }
        return (remaining, lastFillTick);
    }

    /// @dev Execute the economics of a single fill.
    function _settleFill(
        MatchCtx memory ctx,
        address makerTrader,
        uint64 makerOrderId,
        uint64 fillTick,
        uint128 fillSize
    ) private {
        address buyer = ctx.takerIsBuy ? ctx.taker : makerTrader;
        address seller = ctx.takerIsBuy ? makerTrader : ctx.taker;

        uint256 premiumWad = _premiumWad(fillTick, ctx.tickSizeE8, fillSize, ctx.lotSize);
        engine.transferPremium(buyer, seller, premiumWad);

        engine.updatePosition(buyer, ctx.seriesId, int128(uint128(fillSize)));
        engine.updatePosition(seller, ctx.seriesId, -int128(uint128(fillSize)));

        if (ctx.takerIsBuy) {
            _releaseProportionalIM(makerOrderId, fillSize);
        }

        emit OrderMatched(ctx.seriesId, 0, makerOrderId, fillTick, fillSize, buyer, seller);
    }

    /// @dev Release the proportional reserved IM when a maker sell order is filled.
    function _releaseProportionalIM(uint64 makerOrderId, uint128 fillSize) private {
        uint256 reserved = _orderReservedIM[makerOrderId];
        if (reserved == 0) return;

        OptionOrderBook.Order memory o = book.getOrder(makerOrderId);
        uint128 originalSize = o.size;
        uint256 release = reserved * uint256(fillSize) / uint256(originalSize);

        _orderReservedIM[makerOrderId] -= release;
        engine.releaseMargin(o.trader, release);

        if (o.remaining == 0) {
            delete _orderReservedIM[makerOrderId];
        }
    }

    /// @dev Compute WAD-denominated premium for a fill.
    function _premiumWad(uint64 priceTicks, uint32 tickSizeE8, uint128 fillSize, uint32 lotSize)
        private
        pure
        returns (uint256)
    {
        return uint256(priceTicks) * uint256(tickSizeE8) * 1e10
            * uint256(fillSize) / uint256(lotSize);
    }

    // ── Internal: validations ───────────────────────────────────────────────

    function _applyReduceOnly(address trader, uint64 seriesId, bool isBuy, uint128 size)
        private
        view
        returns (uint128)
    {
        int128 pos = engine.getPosition(trader, seriesId);
        if (isBuy) {
            if (pos >= 0) revert ReduceOnlyNoPosition();
            uint128 absPos = uint128(-pos);
            return size < absPos ? size : absPos;
        } else {
            if (pos <= 0) revert ReduceOnlyNoPosition();
            uint128 upos = uint128(pos);
            return size < upos ? size : upos;
        }
    }

    function _assertPostOnly(uint64 seriesId, bool isBuy, uint64 priceTicks) private view {
        if (isBuy) {
            (, uint64 bestAskTick) = book.bestAsk(seriesId);
            if (bestAskTick > 0 && priceTicks >= bestAskTick) revert PostOnlyWouldMatch();
        } else {
            (, uint64 bestBidTick) = book.bestBid(seriesId);
            if (bestBidTick > 0 && priceTicks <= bestBidTick) revert PostOnlyWouldMatch();
        }
    }

    // ── Upgrade ─────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
