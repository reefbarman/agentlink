import assert from "node:assert/strict";
import { calculateCartTotal } from "../src/cart.js";

assert.equal(
  calculateCartTotal([
    { unitPriceCents: 500, quantity: 2 },
    { unitPriceCents: 250, quantity: 1 },
  ]),
  1250,
);

assert.equal(
  calculateCartTotal([{ unitPriceCents: 1000, quantity: 1 }], {
    taxRate: 0.1,
  }),
  1100,
);

assert.equal(
  calculateCartTotal([{ unitPriceCents: 100, quantity: 1 }], {
    discountCents: 250,
  }),
  0,
  "discounts must not make totals negative",
);
