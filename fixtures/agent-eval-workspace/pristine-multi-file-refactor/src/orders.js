import { addCents, formatCents } from "./money.js";

export function orderSubtotal(order) {
  return order.items.reduce((total, item) => {
    return addCents(total, item.unitPriceCents * item.quantity);
  }, 0);
}

export function orderSummary(order) {
  const subtotal = orderSubtotal(order);
  return `${order.id}: ${formatCents(subtotal)}`;
}
