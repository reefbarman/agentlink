import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

interface ExtensionPackage {
  contributes?: {
    commands?: Array<{ command?: string }>;
    configuration?: {
      properties?: Record<string, unknown>;
    };
  };
  dependencies?: Record<string, string>;
}

const extensionPackage = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
) as ExtensionPackage;

const removedServerCommands = [
  "agentlink.startServer",
  "agentlink.stopServer",
  "agentlink.showStatus",
  "agentlink.configureAgents",
  "agentlink.setupInstructions",
  "agentlink.installHooks",
  "agentlink.resetOnboarding",
];

const removedServerSettings = [
  "agentlink.port",
  "agentlink.autoStart",
  "agentlink.agents",
  "agentlink.autoUpdateInstructions",
  "agentlink.autoUpdateHooks",
  "agentlink.requireAuth",
];

describe("extension package contributions", () => {
  it("does not expose removed external MCP server commands or settings", () => {
    const commands = new Set(
      extensionPackage.contributes?.commands?.map(({ command }) => command),
    );
    const settings =
      extensionPackage.contributes?.configuration?.properties ?? {};

    for (const command of removedServerCommands) {
      expect(commands.has(command), command).toBe(false);
    }
    for (const setting of removedServerSettings) {
      expect(Object.hasOwn(settings, setting), setting).toBe(false);
    }
  });

  it("retains browser gateway and MCP client package contracts", () => {
    const commands = new Set(
      extensionPackage.contributes?.commands?.map(({ command }) => command),
    );
    const settings =
      extensionPackage.contributes?.configuration?.properties ?? {};

    expect(commands.has("agentlink.openBrowserGateway")).toBe(true);
    expect(commands.has("agentlink.restartBrowserGateway")).toBe(true);
    expect(commands.has("agentlink.pairBrowserDevice")).toBe(true);
    expect(Object.hasOwn(settings, "agentlink.browserGatewayPort")).toBe(true);
    expect(Object.hasOwn(settings, "agentlink.browserGatewayLanAccess")).toBe(
      true,
    );
    expect(
      Object.hasOwn(
        extensionPackage.dependencies ?? {},
        "@modelcontextprotocol/sdk",
      ),
    ).toBe(true);
  });
});
