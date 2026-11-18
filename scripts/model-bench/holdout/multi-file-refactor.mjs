import { check, expectEqual, finish, firstFailure } from "./check.mjs";

const order = {
  id: "Z9",
  items: [
    { unitPriceCents: 999, quantity: 3 },
    { unitPriceCents: 1, quantity: 1 },
  ],
};

await check("money-exports-renamed", async () => {
  const money = await import("../src/money.js");
  const missing = ["formatCurrency", "addMoney"].filter(
    (name) => typeof money[name] !== "function",
  );
  return missing.length === 0 || `not exported: ${missing.join(", ")}`;
});

await check("old-exports-removed", async () => {
  const money = await import("../src/money.js");
  const left = ["formatCents", "addCents"].filter((name) => name in money);
  return left.length === 0 || `still exported: ${left.join(", ")}`;
});

await check("money-behaviour", async () => {
  const money = await import("../src/money.js");
  return firstFailure(
    expectEqual(money.formatCurrency(1650), "$16.50", "formatCurrency(1650)"),
    expectEqual(money.formatCurrency(5), "$0.05", "formatCurrency(5)"),
    expectEqual(money.addMoney(125, 375), 500, "addMoney(125, 375)"),
  );
});

await check("orders-behaviour", async () => {
  const orders = await import("../src/orders.js");
  return firstFailure(
    expectEqual(orders.orderSubtotal(order), 2998, "orderSubtotal"),
    expectEqual(orders.orderSummary(order), "Z9: $29.98", "orderSummary"),
  );
});

await check("invoices-behaviour", async () => {
  const invoices = await import("../src/invoices.js");
  const total = Math.round(2998 * (1 + 0.075));
  return firstFailure(
    expectEqual(invoices.invoiceTotal(order, 0.075), total, "invoiceTotal"),
    expectEqual(
      invoices.invoiceLabel(order, 0.075),
      `Invoice Z9: $${(total / 100).toFixed(2)}`,
      "invoiceLabel",
    ),
  );
});

finish();
