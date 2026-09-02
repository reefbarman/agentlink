import {
  HostToolInputValidationError,
  defineTool,
  formatHostToolValidationError,
} from "./hostTools.js";
import { describe, expect, it, vi } from "vitest";

const CONTEXT = {
  principal: { tenantId: "tenant-a", subjectId: "subject-a" },
  sessionId: "session-1",
  turnId: "turn-1",
  model: {
    model: { providerId: "fake", modelId: "model" },
    source: "runtime" as const,
  },
  signal: undefined,
};

describe("dynamic host tool contracts", () => {
  it("defines an immutable tool and validates before dispatch", async () => {
    const handler = vi.fn(async (input: Record<string, unknown>) => ({
      modelContent: `found:${String(input.query)}`,
    }));
    const tool = defineTool({
      name: "lookup",
      description: "Look up tenant data",
      effect: "read",
      parallelSafe: true,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      handler,
    });

    expect(tool.definition).toEqual({
      name: "lookup",
      description: "Look up tenant data",
      input_schema: expect.objectContaining({ type: "object" }),
    });
    expect(Object.isFrozen(tool)).toBe(true);
    expect(Object.isFrozen(tool.definition.input_schema)).toBe(true);
    expect(
      Object.isFrozen(
        tool.definition.input_schema.properties as Record<string, unknown>,
      ),
    ).toBe(true);
    expect(tool.validate({ query: "sleep" })).toEqual({
      valid: true,
      input: { query: "sleep" },
    });
    expect(tool.validate({ query: "", extra: true })).toEqual({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ keyword: "minLength" }),
        expect.objectContaining({ keyword: "additionalProperties" }),
      ]),
    });

    await expect(tool.execute({ query: "sleep" }, CONTEXT)).resolves.toEqual({
      modelContent: "found:sleep",
    });
    await expect(
      tool.execute({ query: "", extra: true }, CONTEXT),
    ).rejects.toMatchObject({
      code: "tool_input_invalid",
      retryable: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ keyword: "additionalProperties" }),
      ]),
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("isolates schema compilation between tools with the same schema id", () => {
    const options = {
      description: "Schema isolation",
      inputSchema: { $id: "shared-tool-schema", type: "object" },
      effect: "read" as const,
      handler: async () => ({ modelContent: "ok" }),
    };

    expect(() => defineTool({ ...options, name: "first_tool" })).not.toThrow();
    expect(() => defineTool({ ...options, name: "second_tool" })).not.toThrow();
  });

  it("bounds non-cloneable schema errors", () => {
    expect(() =>
      defineTool({
        name: "non_cloneable",
        description: "Non-cloneable schema",
        inputSchema: {
          type: "object",
          unsupported: () => undefined,
        },
        effect: "read",
        handler: async () => ({ modelContent: "" }),
      }),
    ).toThrow('Host tool "non_cloneable" input schema is invalid');
  });

  it("rejects invalid schemas and unsafe parallel metadata at definition time", () => {
    expect(() =>
      defineTool({
        name: "bad schema",
        description: "Invalid name",
        inputSchema: { type: "object" },
        effect: "read",
        handler: async () => ({ modelContent: "" }),
      }),
    ).toThrow("Host tool name must start with a letter");
    expect(() =>
      defineTool({
        name: "bad_schema",
        description: "Invalid schema",
        inputSchema: { type: "not-a-json-type" },
        effect: "read",
        handler: async () => ({ modelContent: "" }),
      }),
    ).toThrow('Host tool "bad_schema" input schema is invalid');
    expect(() =>
      defineTool({
        name: "bad_effect",
        description: "Invalid effect",
        inputSchema: { type: "object" },
        effect: "unsafe" as "read",
        handler: async () => ({ modelContent: "" }),
      }),
    ).toThrow('Host tool "bad_effect" effect is invalid');
    expect(() =>
      defineTool({
        name: "bad_authorization",
        description: "Invalid authorization",
        inputSchema: { type: "object" },
        effect: "read",
        authorization: "prompt" as "none",
        handler: async () => ({ modelContent: "" }),
      }),
    ).toThrow('Host tool "bad_authorization" authorization is invalid');
    expect(() =>
      defineTool({
        name: "write_parallel",
        description: "Unsafe metadata",
        inputSchema: { type: "object" },
        effect: "write",
        parallelSafe: true,
        handler: async () => ({ modelContent: "" }),
      }),
    ).toThrow('parallel-safe only when effect is "read"');
    expect(() =>
      defineTool({
        name: "approval_parallel",
        description: "Unsafe authorization metadata",
        inputSchema: { type: "object" },
        effect: "read",
        parallelSafe: true,
        authorization: "required",
        handler: async () => ({ modelContent: "" }),
      }),
    ).toThrow("cannot be parallel-safe when authorization is required");
  });

  it("bounds validation issue presentation", () => {
    const issues = Array.from({ length: 30 }, (_value, index) => ({
      path: `$.field${index}`,
      keyword: "required",
      message: "x".repeat(300),
    }));
    const message = formatHostToolValidationError("lookup", issues);

    expect(message).toContain('Tool "lookup" input is invalid');
    expect(message).toContain("$.field0");
    expect(message).not.toContain("$.field5");
    expect(message.length).toBeLessThan(1200);
  });

  it("exposes the typed validation error class", () => {
    const error = new HostToolInputValidationError("lookup", [
      { path: "$.query", keyword: "required", message: "is required" },
    ]);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("tool_input_invalid");
    expect(error.message).toContain("$.query: is required");
  });
});
