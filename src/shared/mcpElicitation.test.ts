import { describe, expect, it } from "vitest";

import {
  createMcpElicitationInitialValues,
  MAX_MCP_ELICITATION_FIELDS,
  MAX_MCP_ELICITATION_OPTIONS,
  normalizeMcpElicitationSchema,
  validateAndCoerceMcpElicitationValues,
  type McpElicitationField,
} from "./mcpElicitation.js";

function normalizedFields(schema: unknown): McpElicitationField[] {
  const result = normalizeMcpElicitationSchema(schema);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.schema.fields;
}

describe("normalizeMcpElicitationSchema", () => {
  it("normalizes primitive fields and preserves defaults, formats, and constraints", () => {
    const fields = normalizedFields({
      type: "object",
      properties: {
        email: {
          type: "string",
          title: "Email",
          description: "Where notifications are sent",
          format: "email",
          minLength: 5,
          maxLength: 100,
          default: "dev@example.com",
        },
        ratio: {
          type: "number",
          minimum: 0,
          maximum: 1,
          default: 0.5,
        },
        retries: {
          type: "integer",
          minimum: 0,
          maximum: 5,
          default: 2,
        },
        enabled: { type: "boolean", default: false },
      },
      required: ["email", "enabled"],
    });

    expect(fields).toEqual([
      {
        kind: "string",
        name: "email",
        title: "Email",
        description: "Where notifications are sent",
        required: true,
        format: "email",
        minLength: 5,
        maxLength: 100,
        default: "dev@example.com",
      },
      {
        kind: "number",
        name: "ratio",
        required: false,
        minimum: 0,
        maximum: 1,
        default: 0.5,
      },
      {
        kind: "integer",
        name: "retries",
        required: false,
        minimum: 0,
        maximum: 5,
        default: 2,
      },
      {
        kind: "boolean",
        name: "enabled",
        required: true,
        default: false,
      },
    ]);
  });

  it("normalizes current and legacy single-select variants", () => {
    const fields = normalizedFields({
      type: "object",
      properties: {
        untitled: {
          type: "string",
          enum: ["red", "blue"],
          default: "blue",
        },
        titled: {
          type: "string",
          oneOf: [
            { const: "dev", title: "Developer" },
            { const: "ops", title: "Operations" },
          ],
        },
        legacy: {
          type: "string",
          enum: ["small", "large"],
          enumNames: ["Small size", "Large size"],
        },
      },
    });

    expect(fields).toEqual([
      {
        kind: "single-select",
        name: "untitled",
        required: false,
        options: [{ value: "red" }, { value: "blue" }],
        default: "blue",
      },
      {
        kind: "single-select",
        name: "titled",
        required: false,
        options: [
          { value: "dev", title: "Developer" },
          { value: "ops", title: "Operations" },
        ],
      },
      {
        kind: "single-select",
        name: "legacy",
        required: false,
        options: [
          { value: "small", title: "Small size" },
          { value: "large", title: "Large size" },
        ],
      },
    ]);
  });

  it("normalizes untitled items.enum and titled items.anyOf multi-selects", () => {
    const fields = normalizedFields({
      type: "object",
      properties: {
        interests: {
          type: "array",
          items: { type: "string", enum: ["ui", "api", "ops"] },
          minItems: 1,
          maxItems: 2,
          default: ["api"],
        },
        regions: {
          type: "array",
          items: {
            anyOf: [
              { const: "us", title: "United States" },
              { const: "eu", title: "Europe" },
            ],
          },
        },
      },
    });

    expect(fields).toEqual([
      {
        kind: "multi-select",
        name: "interests",
        required: false,
        options: [{ value: "ui" }, { value: "api" }, { value: "ops" }],
        minItems: 1,
        maxItems: 2,
        default: ["api"],
      },
      {
        kind: "multi-select",
        name: "regions",
        required: false,
        options: [
          { value: "us", title: "United States" },
          { value: "eu", title: "Europe" },
        ],
      },
    ]);
  });

  it("rejects malformed schemas and invalid defaults without throwing", () => {
    const schemas = [
      null,
      { type: "array", properties: {} },
      { type: "object", properties: [], required: [] },
      {
        type: "object",
        properties: { value: { type: "object" } },
      },
      {
        type: "object",
        properties: { value: { type: "integer", default: 1.5 } },
      },
      {
        type: "object",
        properties: { value: { type: "string", enum: ["a"] } },
        required: ["missing"],
      },
      {
        type: "object",
        properties: {
          value: {
            type: "array",
            items: { type: "string", enum: ["a"] },
            default: [],
          },
        },
        required: ["value"],
      },
    ];

    for (const schema of schemas) {
      expect(normalizeMcpElicitationSchema(schema).ok).toBe(false);
    }
  });

  it("bounds untrusted field and option collections", () => {
    const properties = Object.fromEntries(
      Array.from({ length: MAX_MCP_ELICITATION_FIELDS + 1 }, (_, index) => [
        `field-${index}`,
        { type: "string" },
      ]),
    );
    expect(
      normalizeMcpElicitationSchema({ type: "object", properties }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("field limit"),
    });

    expect(
      normalizeMcpElicitationSchema({
        type: "object",
        properties: {
          choice: {
            type: "string",
            enum: Array.from(
              { length: MAX_MCP_ELICITATION_OPTIONS + 1 },
              (_, index) => `option-${index}`,
            ),
          },
        },
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("option limit"),
    });
  });
});

describe("createMcpElicitationInitialValues", () => {
  it("applies native defaults including false and creates safe empty controls", () => {
    const fields = normalizedFields({
      type: "object",
      properties: {
        text: { type: "string", default: "hello" },
        count: { type: "integer", default: 0 },
        enabled: { type: "boolean", default: false },
        choice: { type: "string", enum: ["a", "b"] },
        selected: {
          type: "array",
          items: { type: "string", enum: ["a", "b"] },
          default: ["b"],
        },
      },
    });

    const values = createMcpElicitationInitialValues(fields);
    expect({ ...values }).toEqual({
      text: "hello",
      count: 0,
      enabled: false,
      choice: "",
      selected: ["b"],
    });
    expect(Object.getPrototypeOf(values)).toBeNull();
  });
});

describe("validateAndCoerceMcpElicitationValues", () => {
  it("coerces numbers and integers and enforces required and bounds", () => {
    const fields = normalizedFields({
      type: "object",
      properties: {
        amount: { type: "number", minimum: 1, maximum: 5 },
        count: { type: "integer", minimum: 0, maximum: 10 },
        name: { type: "string", minLength: 2, maxLength: 4 },
        enabled: { type: "boolean" },
      },
      required: ["amount", "count", "name", "enabled"],
    });

    expect(
      validateAndCoerceMcpElicitationValues(fields, {
        amount: "2.5",
        count: "3",
        name: "Ada",
        enabled: false,
      }),
    ).toEqual({
      ok: true,
      values: expect.objectContaining({
        amount: 2.5,
        count: 3,
        name: "Ada",
        enabled: false,
      }),
    });

    const invalid = validateAndCoerceMcpElicitationValues(fields, {
      amount: "6",
      count: "1.5",
      name: "",
      enabled: "false",
    });
    expect(invalid).toEqual({
      ok: false,
      errors: expect.objectContaining({
        amount: expect.stringContaining("at most 5"),
        count: expect.stringContaining("integer"),
        name: expect.stringContaining("required"),
        enabled: expect.stringContaining("true or false"),
      }),
    });

    expect(
      validateAndCoerceMcpElicitationValues(fields, {
        amount: "0x2",
        count: "   ",
        name: "Ada",
        enabled: true,
      }),
    ).toMatchObject({
      ok: false,
      errors: {
        amount: expect.stringContaining("number"),
        count: expect.stringContaining("required"),
      },
    });
  });

  it("validates email, URI, date, and date-time formats", () => {
    const fields = normalizedFields({
      type: "object",
      properties: {
        email: { type: "string", format: "email" },
        uri: { type: "string", format: "uri" },
        date: { type: "string", format: "date" },
        dateTime: { type: "string", format: "date-time" },
      },
      required: ["email", "uri", "date", "dateTime"],
    });

    expect(
      validateAndCoerceMcpElicitationValues(fields, {
        email: "dev@example.com",
        uri: "https://example.com/path",
        date: "2024-02-29",
        dateTime: "2024-02-29T10:30:00Z",
      }).ok,
    ).toBe(true);

    const invalid = validateAndCoerceMcpElicitationValues(fields, {
      email: "not-an-email",
      uri: "relative/path",
      date: "2023-02-29",
      dateTime: "2024-02-29 10:30:00",
    });
    expect(invalid).toMatchObject({
      ok: false,
      errors: {
        email: expect.stringContaining("email"),
        uri: expect.stringContaining("uri"),
        date: expect.stringContaining("date"),
        dateTime: expect.stringContaining("date-time"),
      },
    });
  });

  it("enforces enum membership and multi-select item constraints", () => {
    const fields = normalizedFields({
      type: "object",
      properties: {
        role: { type: "string", enum: ["dev", "ops"] },
        interests: {
          type: "array",
          items: { type: "string", enum: ["ui", "api", "ops"] },
          minItems: 1,
          maxItems: 2,
        },
      },
      required: ["role", "interests"],
    });

    expect(
      validateAndCoerceMcpElicitationValues(fields, {
        role: "dev",
        interests: ["ui", "api"],
      }),
    ).toMatchObject({
      ok: true,
      values: { role: "dev", interests: ["ui", "api"] },
    });

    expect(
      validateAndCoerceMcpElicitationValues(fields, {
        role: "admin",
        interests: [],
      }),
    ).toMatchObject({
      ok: false,
      errors: {
        role: expect.stringContaining("invalid selection"),
        interests: expect.stringContaining("required"),
      },
    });

    expect(
      validateAndCoerceMcpElicitationValues(fields, {
        role: "dev",
        interests: ["ui", "api", "ops"],
      }),
    ).toMatchObject({
      ok: false,
      errors: { interests: expect.stringContaining("at most 2") },
    });
  });

  it("does not consume inherited values for prototype-named fields", () => {
    const fields = normalizedFields({
      type: "object",
      properties: {
        constructor: { type: "string" },
        toString: { type: "string" },
      },
      required: ["constructor", "toString"],
    });

    expect(validateAndCoerceMcpElicitationValues(fields, {})).toMatchObject({
      ok: false,
      errors: {
        constructor: expect.stringContaining("required"),
        toString: expect.stringContaining("required"),
      },
    });
  });

  it("omits empty optional fields even when a multi-select has minItems", () => {
    const fields = normalizedFields({
      type: "object",
      properties: {
        text: { type: "string" },
        count: { type: "number" },
        choice: { type: "string", enum: ["a", "b"] },
        tags: {
          type: "array",
          items: { type: "string", enum: ["a", "b"] },
          minItems: 1,
        },
      },
    });

    const result = validateAndCoerceMcpElicitationValues(fields, {
      text: "",
      count: "",
      choice: "",
      tags: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect({ ...result.values }).toEqual({});
  });
});
