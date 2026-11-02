import {
  AGENT_BUDGET_DESCRIPTION,
  AGENT_BUDGET_PROPERTY,
} from "@agentlink/core/background-agent-tools";
import { agentBudgetDescription, agentBudgetSchema } from "./toolSchemas.js";
import { describe, expect, it } from "vitest";

import { z } from "zod";

describe("agentBudgetSchema", () => {
  it("matches the budget schema other surfaces advertise from core", () => {
    const { $schema: _, ...converted } = z.toJSONSchema(
      z.object(agentBudgetSchema),
    ) as Record<string, unknown>;
    expect({ ...converted, description: agentBudgetDescription }).toEqual(
      AGENT_BUDGET_PROPERTY,
    );
    expect(AGENT_BUDGET_DESCRIPTION).toBe(agentBudgetDescription);
  });
});
