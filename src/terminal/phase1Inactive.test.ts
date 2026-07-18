import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";

interface ExtensionManifest {
  contributes?: {
    views?: Record<string, Array<{ id?: string }>>;
    commands?: Array<{ command?: string }>;
    configuration?: {
      properties?: Record<string, unknown>;
    };
  };
}

const manifest = JSON.parse(
  readFileSync("package.json", "utf8"),
) as ExtensionManifest;
const extensionSource = readFileSync("src/extension.ts", "utf8");

describe("Phase 1 inactive boundary", () => {
  it("keeps the existing Approvals view as the only AgentLink panel view", () => {
    const panelViews = manifest.contributes?.views?.agentLinkPanel ?? [];
    expect(panelViews.map((view) => view.id)).toEqual([
      "agentLink.approvalView",
    ]);
    expect(
      panelViews.some((view) => view.id === "agentLink.terminalView"),
    ).toBe(false);
  });

  it("does not contribute the custom terminal feature setting or commands", () => {
    const properties = manifest.contributes?.configuration?.properties ?? {};
    expect(properties).not.toHaveProperty("agentlink.terminal.enabled");
    const commands = manifest.contributes?.commands ?? [];
    expect(
      commands.some((entry) =>
        entry.command?.startsWith("agentlink.terminal."),
      ),
    ).toBe(false);
  });

  it("does not import or register custom terminal runtime components at activation", () => {
    for (const forbiddenReference of [
      "node-pty",
      "TerminalSessionService",
      "AgentTerminalViewProvider",
      "agentTerminalProvider",
      'registerWebviewViewProvider("agentLink.terminalView"',
    ]) {
      expect(extensionSource).not.toContain(forbiddenReference);
    }
  });
});
