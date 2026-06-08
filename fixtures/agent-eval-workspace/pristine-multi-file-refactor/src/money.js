export function formatCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

export function addCents(left, right) {
  return left + right;
}
