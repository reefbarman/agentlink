import { describe, expect, it, vi } from "vitest";

import { handleGetDiagnostics } from "./getDiagnostics.js";

function textPayload(result: Awaited<ReturnType<typeof handleGetDiagnostics>>) {
  const text = (result.content[0] as { type: "text"; text: string }).text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

describe("handleGetDiagnostics", () => {
  it("returns an explicit unavailable result when no diagnostics provider is supplied", async () => {
    const result = await handleGetDiagnostics({ path: "src/file.ts" });

    expect(textPayload(result)).toEqual({
      error:
        "Diagnostics are unavailable in this runtime. Provide a DiagnosticsProvider to enable get_diagnostics.",
      path: "src/file.ts",
    });
  });

  it("delegates diagnostics params to the provider", async () => {
    const getDiagnostics = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "diagnostics" }],
    }));

    const result = await handleGetDiagnostics(
      {
        path: "src/file.ts",
        severity: "error,warning",
        source: "typescript",
      },
      { diagnosticsProvider: { getDiagnostics } },
    );

    expect(textPayload(result)).toBe("diagnostics");
    expect(getDiagnostics).toHaveBeenCalledWith({
      path: "src/file.ts",
      severity: "error,warning",
      source: "typescript",
    });
  });

  it("preserves the legacy plain-text Error prefix when provider execution throws", async () => {
    const getDiagnostics = vi.fn(async () => {
      throw new Error("bad path");
    });

    const result = await handleGetDiagnostics(
      { path: "src/file.ts" },
      { diagnosticsProvider: { getDiagnostics } },
    );

    expect(textPayload(result)).toBe("Error: bad path");
  });
});
