import {
  BROWSER_GATEWAY_SNAPSHOT_PARITY_CONTRACT,
  flattenBrowserGatewaySnapshotParityContract,
} from "./snapshotParityContract.js";
import { describe, expect, it } from "vitest";

describe("browser gateway snapshot parity contract", () => {
  it("classifies every legacy wire-state leaf with actionable notes", () => {
    const entries = flattenBrowserGatewaySnapshotParityContract();

    expect(entries.length).toBeGreaterThan(40);
    expect(new Set(entries.map((entry) => entry.path)).size).toBe(
      entries.length,
    );
    expect(entries.every((entry) => entry.notes.trim().length > 0)).toBe(true);
    expect(entries.every((entry) => entry.transports.length > 0)).toBe(true);
  });

  it("uses no transport for exclusions and unresolved missing fields only", () => {
    const entries = flattenBrowserGatewaySnapshotParityContract();

    for (const entry of entries) {
      if (entry.status === "missing" || entry.status === "excluded") {
        expect(entry.transports, entry.path).toEqual(["none"]);
      } else {
        expect(entry.transports, entry.path).not.toContain("none");
      }
    }
  });

  it("keeps known cutover blockers explicit", () => {
    const byPath = new Map(
      flattenBrowserGatewaySnapshotParityContract().map((entry) => [
        entry.path,
        entry,
      ]),
    );

    expect(byPath.get("session.foreground.projectedMessages")?.status).toBe(
      "partial",
    );
    expect(byPath.get("ui.approval")?.status).toBe("partial");
    expect(byPath.get("session.foreground.contextBudget")?.status).toBe(
      "covered",
    );
    expect(byPath.get("session.foreground.thinkingEnabled")?.status).toBe(
      "covered",
    );
    expect(byPath.get("session.foreground.interrupted")?.status).toBe(
      "covered",
    );
    expect(byPath.get("session.foreground.revertRecoveryNotice")?.status).toBe(
      "covered",
    );
    expect(byPath.get("session.foreground.detectedQuestion")?.status).toBe(
      "missing",
    );
    expect(byPath.get("diffs")?.transports).toContain("detail_handle");
    expect(byPath.get("theme")?.status).toBe("partial");
    expect(byPath.get("session.foreground.projectedMessages")?.notes).toContain(
      "cursor/hasEarlier",
    );
    expect(byPath.get("session.foreground.systemPrompt")?.status).toBe(
      "excluded",
    );
  });

  it("represents the expected top-level legacy snapshot containers", () => {
    expect(
      Object.keys(BROWSER_GATEWAY_SNAPSHOT_PARITY_CONTRACT).sort(),
    ).toEqual([
      "background",
      "diffs",
      "modelsVersion",
      "pluginsVersion",
      "session",
      "theme",
      "ui",
    ]);
  });
});
