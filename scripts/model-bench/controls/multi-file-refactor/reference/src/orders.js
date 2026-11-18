import { addMoney, formatCurrency } from "./money.js";

export function orderSubtotal(order) {
  return order.items.reduce((total, item) => {
    return addMoney(total, item.unitPriceCents * item.quantity);
  }, 0);
}

export function orderSummary(order) {
  const subtotal = orderSubtotal(order);
  return `${order.id}: ${formatCurrency(subtotal)}`;
}
