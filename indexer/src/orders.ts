import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import { Order } from "../generated/schema";

/**
 * True once the order has left the book for good, whatever the reason. Guards
 * the handlers against a late or duplicate log downgrading a terminal state —
 * `liquidateOrder` co-emits OrderCancelled + OrderLiquidated, and the taker's
 * OrderUpdated(0) can arrive either side of its OrderMatched.
 */
export function isTerminalOrderStatus(status: string): boolean {
  return (
    status == "FILLED" || status == "CANCELLED" || status == "LIQUIDATED"
  );
}

/**
 * `cancelledQuantity` is everything that left the order without matching:
 * amend shrinks, self-crosses, user cancels, IOC remainders, liquidations.
 * Deriving it from the other three counters keeps
 * `originalQuantity = filledQuantity + cancelledQuantity + quantity` true
 * regardless of whether OrderUpdated or OrderMatched lands first.
 */
export function syncCancelledQuantity(order: Order): void {
  order.cancelledQuantity = order.originalQuantity
    .minus(order.filledQuantity)
    .minus(order.quantity);
}

/**
 * Terminal transition. Nothing rests once an order is out of the book, so the
 * remaining quantity is zeroed and whatever it held rolls into
 * `cancelledQuantity`.
 */
export function closeOrder(
  order: Order,
  status: string,
  timestamp: BigInt,
  closedByTx: Bytes,
): void {
  order.quantity = BigInt.zero();
  order.status = status;
  order.closedAt = timestamp;
  order.closedByTx = closedByTx;
  order.updatedAt = timestamp;
  syncCancelledQuantity(order);
}
