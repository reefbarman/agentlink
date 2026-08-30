import {
  normalizeMcpElicitationSchema,
  validateAndCoerceMcpElicitationValues,
  type McpElicitationField,
  type McpFormElicitationRequest,
  type McpFormElicitationResponse,
} from "./mcpElicitation.js";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("MCP form elicitation protocol compatibility shim", () => {
  it("preserves the legacy request, response, and validation contracts", () => {
    expectTypeOf<McpFormElicitationRequest>().toHaveProperty("fields");
    expectTypeOf<McpFormElicitationResponse>().toHaveProperty("action");
    const normalized = normalizeMcpElicitationSchema({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const fields: McpElicitationField[] = normalized.schema.fields;
    expect(
      validateAndCoerceMcpElicitationValues(fields, { name: "Ada" }),
    ).toMatchObject({
      ok: true,
      values: { name: "Ada" },
    });
  });
});
