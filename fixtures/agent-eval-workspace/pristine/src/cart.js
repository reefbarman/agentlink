export function calculateCartTotal(items, options = {}) {
  const taxRate = options.taxRate ?? 0;
  const discountCents = options.discountCents ?? 0;

  const subtotalCents = items.reduce((total, item) => {
    return total + item.unitPriceCents * item.quantity;
  }, 0);

  const taxedCents = Math.round(subtotalCents * (1 + taxRate));

  return taxedCents - discountCents;
}
