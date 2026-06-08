import { invoiceLabel, invoiceTotal } from "../src/invoices.js";
import { orderSubtotal, orderSummary } from "../src/orders.js";

import assert from "node:assert/strict";

const order = {
  id: "A100",
  items: [
    { unitPriceCents: 500, quantity: 2 },
    { unitPriceCents: 125, quantity: 4 },
  ],
};

assert.equal(orderSubtotal(order), 1500);
assert.equal(orderSummary(order), "A100: $15.00");
assert.equal(invoiceTotal(order, 0.1), 1650);
assert.equal(invoiceLabel(order, 0.1), "Invoice A100: $16.50");
