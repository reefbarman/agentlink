import { describe, expect, it } from "vitest";
import {
  getFleetResultSchema,
  validateFleetResult,
} from "./fleetResultSchema.js";

import Ajv2020 from "ajv/dist/2020.js";
import { z } from "zod";

const samples = [
  { type: "text", text: "Findings" },
  {
    type: "patch",
    summary: "Fixed",
    files: ["src/fix.ts"],
    contracts: ["legacy extra field"],
  },
  {
    type: "verification",
    passed: true,
    summary: "Passed",
    screenshots: ["captures/test.png"],
    logs: ["test output"],
  },
  {
    type: "review_findings",
    findings: [{ severity: "high", message: "Bug", path: "src/a.ts", line: 3 }],
    emptyDiff: false,
  },
];

describe("fleet result schemas", () => {
  const validateJson = new Ajv2020().compile(
    z.toJSONSchema(getFleetResultSchema()),
  );

  it.each(samples)("accepts $type with schema/runtime parity", (sample) => {
    expect(validateJson(sample)).toBe(true);
    expect(validateFleetResult(sample)).toEqual([]);
  });

  it.each([
    undefined,
    null,
    [],
    { type: "unknown" },
    { type: "patch", summary: "Fixed", changedFiles: ["src/fix.ts"] },
    { type: "patch", summary: "Fixed", files: ["../outside.ts"] },
    { type: "verification", passed: "yes", summary: "Passed" },
    {
      type: "review_findings",
      findings: [{ severity: "medium", message: "Bug", line: 1.5 }],
    },
    {
      type: "review_findings",
      findings: [{ severity: "medium", message: "Bug", line: 0 }],
    },
  ])("rejects invalid envelopes with schema/runtime parity: %j", (sample) => {
    expect(validateJson(sample)).toBe(false);
    expect(validateFleetResult(sample).length).toBeGreaterThan(0);
  });

  it.each([
    "",
    "/tmp/a",
    "C:\\tmp\\a",
    "../a",
    "src/../a",
    "src\\..\\a",
    "src\n/../a",
  ])("rejects unsafe artifact path %j", (path) => {
    const sample = { type: "patch", summary: "Fixed", files: [path] };
    expect(validateJson(sample)).toBe(false);
    expect(validateFleetResult(sample)[0]?.path).toBe("result.files.0");
  });

  it("requires emptyDiff only for expected review completions", () => {
    const legacy = { type: "review_findings", findings: [] };
    expect(validateFleetResult(legacy)).toEqual([]);
    expect(validateFleetResult(legacy, "review_findings")).toEqual([
      { path: "result.emptyDiff", message: expect.any(String) },
    ]);
    const validateExpected = new Ajv2020().compile(
      z.toJSONSchema(getFleetResultSchema("review_findings")),
    );
    expect(validateExpected(legacy)).toBe(false);
    expect(validateExpected({ ...legacy, emptyDiff: true })).toBe(true);
  });

  it("preserves native review guidance in both result schemas", () => {
    for (const schema of [
      getFleetResultSchema("review_findings"),
      getFleetResultSchema(),
    ]) {
      const advertised = JSON.stringify(z.toJSONSchema(schema));
      expect(advertised).toContain("empty or unavailable");
      expect(advertised).toContain(
        "attributes the normalized target automatically",
      );
      expect(advertised).toContain("materially differs");
    }
  });

  it("bounds diagnostics without echoing submitted contents", () => {
    const sample = {
      type: "patch",
      summary: "Fixed",
      files: Array(20).fill("../PRIVATE_PAYLOAD"),
    };
    const issues = validateFleetResult(sample);
    expect(issues).toHaveLength(8);
    expect(JSON.stringify(issues)).not.toContain("PRIVATE_PAYLOAD");
  });
});
