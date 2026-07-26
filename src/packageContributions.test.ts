import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

interface ExtensionPackage {
  description?: string;
  contributes?: {
    commands?: Array<{ command?: string; title?: string }>;
    views?: Record<string, Array<{ id?: string; name?: string }>>;
    configuration?: {
      properties?: Record<string, unknown>;
    };
  };
  dependencies?: Record<string, string>;
}

interface ConfigurationProperty {
  default?: unknown;
}

const root = path.join(__dirname, "..");
const extensionPackage = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
) as ExtensionPackage;
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const installScript = fs.readFileSync(
  path.join(root, "scripts", "install.sh"),
  "utf8",
);
const contributorInstructions = fs.readFileSync(
  path.join(root, "CLAUDE.md"),
  "utf8",
);

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

const removedCompatibilitySettings = [
  "agentlink.agentModel",
  "agentlink.autoCondenseThreshold",
  "agentlink.questionDetection.llmEnabled",
  "agentlink.questionDetection.baseUrl",
  "agentlink.questionDetection.model",
  "agentlink.questionDetection.apiKey",
  "agentlink.questionDetection.timeoutMs",
];

describe("extension package contributions", () => {
  it("describes the retained built-in agent product", () => {
    expect(extensionPackage.description).toBe(
      "AI coding agent for VS Code with browser remote control",
    );
  });

  it("does not document retired external MCP server setup workflows", () => {
    const currentDocs = `${readme}\n${changelog}\n${installScript}\n${contributorInstructions}`;
    for (const staleInstruction of [
      "AgentLink: Start MCP Server",
      "AgentLink: Stop MCP Server",
      "AgentLink: Show Server Status",
      "AgentLink: Configure Agents",
      "resources/enforce-agentlink.sh",
      "http://localhost:<port>/mcp",
    ]) {
      expect(currentDocs, staleInstruction).not.toContain(staleInstruction);
    }
  });

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

  it("does not expose pre-release compatibility settings", () => {
    const settings =
      extensionPackage.contributes?.configuration?.properties ?? {};

    for (const setting of removedCompatibilitySettings) {
      expect(Object.hasOwn(settings, setting), setting).toBe(false);
    }
  });

  it("labels the retained sidebar view as Activity", () => {
    const activityView = extensionPackage.contributes?.views?.agentLink?.find(
      ({ id }) => id === "agentLink.statusView",
    );

    expect(activityView?.name).toBe("Activity");
  });

  it("scopes approval commands to built-in agent sessions", () => {
    const commands = new Map(
      extensionPackage.contributes?.commands?.map(({ command, title }) => [
        command,
        title,
      ]),
    );

    expect(commands.get("agentlink.addTrustedCommand")).toBe(
      "AgentLink: Add Built-In Agent Trusted Command Pattern",
    );
    expect(commands.get("agentlink.clearSessionApprovals")).toBe(
      "AgentLink: Clear Built-In Agent Session Approvals",
    );
  });

  it("defaults every built-in chat mode to flagship GPT-5.6 Sol", () => {
    const settings = extensionPackage.contributes?.configuration?.properties as
      | Record<string, ConfigurationProperty>
      | undefined;

    expect(settings?.["agentlink.modeModelPreferences"]?.default).toEqual({
      code: "gpt-5.6-sol",
      architect: "gpt-5.6-sol",
      ask: "gpt-5.6-sol",
      debug: "gpt-5.6-sol",
    });
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
