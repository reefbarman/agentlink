import { describe, expect, it } from "vitest";

import { isAcpSuccessfulStopError } from "./acpBackgroundRunner.js";

describe("isAcpSuccessfulStopError", () => {
  it.each([
    { details: "Claude stopped with success." },
    { details: "claude STOPPED with SUCCESS" },
    { details: "Claude stopped with success. (exit 0)" },
    "Claude stopped with success. (adapter shutdown)",
  ])("recognizes success details in supported error data shapes", (data) => {
    const error = new Error("Internal error");
    (error as { data?: unknown }).data = data;

    expect(isAcpSuccessfulStopError(error)).toBe(true);
  });

  it("recognizes success details on the error cause chain", () => {
    const cause = new Error("Internal error");
    (cause as { data?: unknown }).data = {
      details: "Claude stopped with success.",
    };

    expect(
      isAcpSuccessfulStopError(new Error("ACP prompt failed", { cause })),
    ).toBe(true);
  });

  it.each([
    { details: "Claude stopped with failure." },
    { details: "OAuth token expired" },
    "Internal error",
    undefined,
  ])("does not classify genuine or unstructured errors as success", (data) => {
    const error = new Error("Internal error");
    (error as { data?: unknown }).data = data;

    expect(isAcpSuccessfulStopError(error)).toBe(false);
  });
});
