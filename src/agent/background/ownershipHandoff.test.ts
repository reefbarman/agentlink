import { describe, expect, it } from "vitest";

import { appendOwnershipHandoff } from "./ownershipHandoff.js";

describe("appendOwnershipHandoff", () => {
  it("leaves unscoped handoffs unchanged", () => {
    expect(
      appendOwnershipHandoff("task", {
        backend: "native",
        executionRoot: "/repo",
      }),
    ).toBe("task");
  });

  it("preserves exact path data and distinguishes an empty allowlist from a grant", () => {
    const forbiddenPaths = ['src/odd"name\nfile.ts', "/other/root/private"];
    const result = appendOwnershipHandoff("task", {
      backend: "native",
      executionRoot: "/repo",
      ownedPaths: [],
      forbiddenPaths,
    });
    const data = JSON.parse(
      result.split("\n").find((line) => line.startsWith('{"executionRoot"'))!,
    );
    expect(data).toEqual({
      executionRoot: "/repo",
      ownedPaths: [],
      forbiddenPaths,
    });
    expect(result).toContain(
      "empty ownedPaths list adds no ownership restriction",
    );
    expect(result).toContain("forbiddenPaths take precedence");
    expect(result).toContain("not glob patterns");
    expect(result).toContain(
      "Conversation, steering, and coordinator replies do not change",
    );
  });

  it("never claims native enforcement for ACP paths", () => {
    const result = appendOwnershipHandoff("task", {
      backend: "acp",
      executionRoot: "/repo",
      ownedPaths: ["src"],
    });
    expect(result).toContain("advisory task boundaries");
    expect(result).not.toContain(
      "These are the native delegation path restrictions",
    );
  });
});
