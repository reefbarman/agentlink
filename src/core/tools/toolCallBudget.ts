export interface ToolCallBudgetSnapshot {
  limit: number;
  used: number;
  remaining: number | null;
}

export type ToolCallBudgetReservation =
  | { ok: true; snapshot: ToolCallBudgetSnapshot }
  | { ok: false; requested: number; snapshot: ToolCallBudgetSnapshot };

/**
 * Run-scoped tool-call accounting shared by top-level and nested dispatch.
 * A limit of zero means unlimited while still recording usage.
 */
export class ToolCallBudget {
  private used = 0;

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new Error("Tool call budget limit must be a non-negative integer");
    }
  }

  tryReserve(count = 1): ToolCallBudgetReservation {
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error("Tool call reservation must be a positive integer");
    }

    if (this.limit > 0 && this.used + count > this.limit) {
      return {
        ok: false,
        requested: count,
        snapshot: this.snapshot(),
      };
    }

    this.used += count;
    return { ok: true, snapshot: this.snapshot() };
  }

  snapshot(): ToolCallBudgetSnapshot {
    return {
      limit: this.limit,
      used: this.used,
      remaining: this.limit === 0 ? null : this.limit - this.used,
    };
  }
}
