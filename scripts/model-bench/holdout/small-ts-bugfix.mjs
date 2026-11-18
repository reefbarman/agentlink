import { check, expectEqual, finish, firstFailure } from "./check.mjs";

const { calculateCartTotal: total } = await import("../src/cart.js");
const one = (cents) => [{ unitPriceCents: cents, quantity: 1 }];

await check("oversized-discount-floors-at-zero", () =>
  firstFailure(
    expectEqual(total(one(100), { discountCents: 250 }), 0, "100 - 250"),
    expectEqual(total([], { discountCents: 5 }), 0, "empty cart - 5"),
    expectEqual(
      total(one(1000), { taxRate: 0.1, discountCents: 1200 }),
      0,
      "1000 + 10% tax - 1200",
    ),
  ),
);

await check("discount-still-applies-after-tax", () =>
  firstFailure(
    expectEqual(total(one(1000), { discountCents: 300 }), 700, "1000 - 300"),
    expectEqual(
      total(one(1000), { taxRate: 0.1, discountCents: 100 }),
      1000,
      "1000 + 10% tax - 100",
    ),
    expectEqual(
      total(one(1000), { taxRate: 0.1, discountCents: 1050 }),
      50,
      "1000 + 10% tax - 1050",
    ),
  ),
);

await check("totals-without-discount-unchanged", () =>
  firstFailure(
    expectEqual(
      total([
        { unitPriceCents: 500, quantity: 2 },
        { unitPriceCents: 250, quantity: 1 },
      ]),
      1250,
      "plain subtotal",
    ),
    expectEqual(
      total([{ unitPriceCents: 333, quantity: 3 }], { taxRate: 0.2 }),
      Math.round(999 * 1.2),
      "999 + 20% tax",
    ),
    expectEqual(total([]), 0, "empty cart"),
  ),
);

finish();
