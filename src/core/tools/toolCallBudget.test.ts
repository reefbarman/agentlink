import { describe, expect, it } from "vitest";

import { ToolCallBudget } from "@agentlink/core/tool-call-budget";

describe("ToolCallBudget", () => {
  it("reserves calls up to a finite limit", () => {
    const budget = new ToolCallBudget(3);

    expect(budget.tryReserve(2)).toEqual({
      ok: true,
      snapshot: { limit: 3, used: 2, remaining: 1 },
    });
    expect(budget.tryReserve()).toEqual({
      ok: true,
      snapshot: { limit: 3, used: 3, remaining: 0 },
    });
  });

  it("rejects an over-limit reservation without consuming budget", () => {
    const budget = new ToolCallBudget(2);

    expect(budget.tryReserve()).toMatchObject({ ok: true });
    expect(budget.tryReserve(2)).toEqual({
      ok: false,
      requested: 2,
      snapshot: { limit: 2, used: 1, remaining: 1 },
    });
    expect(budget.snapshot()).toEqual({ limit: 2, used: 1, remaining: 1 });
  });

  it("tracks usage when the limit is unlimited", () => {
    const budget = new ToolCallBudget(0);

    expect(budget.tryReserve(64)).toEqual({
      ok: true,
      snapshot: { limit: 0, used: 64, remaining: null },
    });
  });

  it("rejects invalid limits and reservations", () => {
    expect(() => new ToolCallBudget(-1)).toThrow(/non-negative integer/);
    expect(() => new ToolCallBudget(1.5)).toThrow(/non-negative integer/);

    const budget = new ToolCallBudget(1);
    expect(() => budget.tryReserve(0)).toThrow(/positive integer/);
    expect(() => budget.tryReserve(1.5)).toThrow(/positive integer/);
  });
});
