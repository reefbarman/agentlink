import { formatCents } from "./money.js";
import { orderSubtotal } from "./orders.js";

export function invoiceTotal(order, taxRate) {
  return Math.round(orderSubtotal(order) * (1 + taxRate));
}

export function invoiceLabel(order, taxRate) {
  return `Invoice ${order.id}: ${formatCents(invoiceTotal(order, taxRate))}`;
}
