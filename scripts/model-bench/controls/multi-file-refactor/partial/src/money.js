export function formatCurrency(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

export function addMoney(left, right) {
  return left + right;
}
