import { describe, expect, it } from "vitest";

import { STAGED_NODE_PTY_RELATIVE_PATH } from "./deferredNodePtyLoader.js";
import path from "node:path";
import { readFileSync } from "node:fs";

interface ExtensionManifest {
  contributes?: {
    viewsContainers?: Record<
      string,
      Array<{ id?: string; title?: string; icon?: string }>
    >;
    views?: Record<
      string,
      Array<{
        icon?: string;
        type?: string;
        id?: string;
        name?: string;
        when?: string;
      }>
    >;
    commands?: Array<{ command?: string; title?: string; icon?: string }>;
    menus?: Record<string, Array<{ command?: string; when?: string }>>;
    configuration?: {
      properties?: Record<
        string,
        {
          type?: string;
          scope?: string;
          default?: unknown;
          description?: string;
        }
      >;
    };
  };
}

const manifest = JSON.parse(
  readFileSync("package.json", "utf8"),
) as ExtensionManifest;
const extensionSource = readFileSync("src/extension.ts", "utf8");
const esbuildSource = readFileSync("esbuild.mjs", "utf8");
const vscodeIgnoreSource = readFileSync(".vscodeignore", "utf8");
const deferredNodePtyLoaderSource = readFileSync(
  "src/terminal/deferredNodePtyLoader.ts",
  "utf8",
);
const browserGatewayServerSource = readFileSync(
  "src/browser-gateway/BrowserGatewayServer.ts",
  "utf8",
);
const toolAdapterSource = readFileSync("src/agent/toolAdapter.ts", "utf8");

describe("Phase 1 gated activation boundary", () => {
  it("keeps management left, Agent right, and only Terminal in the bottom panel", () => {
    expect(manifest.contributes?.viewsContainers?.activitybar).toEqual([
      {
        id: "agentLink",
        title: "AgentLink",
        icon: "media/agentlink.svg",
      },
    ]);
    expect(manifest.contributes?.views?.agentLink).toEqual([
      {
        icon: "media/agentlink.svg",
        type: "webview",
        id: "agentLink.statusView",
        name: "Activity",
      },
    ]);
    expect(manifest.contributes?.viewsContainers?.secondarySidebar).toEqual([
      {
        id: "agentLinkAgent",
        title: "AgentLink Agent",
        icon: "media/agentlink.svg",
      },
    ]);
    expect(manifest.contributes?.views?.agentLinkAgent).toEqual([
      {
        icon: "media/agentlink.svg",
        type: "webview",
        id: "agentLink.chatView",
        name: "Agent",
      },
    ]);
    expect(manifest.contributes?.viewsContainers?.panel).toEqual([
      {
        id: "agentLinkPanel",
        title: "AgentLink Terminal",
        icon: "media/agentlink-terminal.svg",
      },
    ]);
    expect(manifest.contributes?.views?.agentLinkPanel).toEqual([
      {
        icon: "media/agentlink-terminal.svg",
        type: "webview",
        id: "agentLink.terminalView",
        name: "Terminal",
        when: "agentLink.customTerminalAvailable",
      },
    ]);
    expect(extensionSource).not.toContain("ApprovalPanelProvider.viewType");
  });

  it("contributes the default-on terminal setting and open command", () => {
    const properties = manifest.contributes?.configuration?.properties ?? {};
    expect(properties["agentlink.terminal.enabled"]).toEqual({
      type: "boolean",
      scope: "machine",
      default: true,
      description:
        "Enable AgentLink terminals on supported local macOS extension hosts when a compatible standalone Node.js runtime is available. User Host Shell tabs run unsandboxed, while built-in agent commands run in isolated workspace sandboxes. Unsupported, remote, or runtime-incompatible hosts keep the native VS Code terminal provider.",
    });
    expect(properties["agentlink.terminal.nodePath"]).toEqual({
      type: "string",
      scope: "machine",
      default: "",
      description:
        "Optional absolute path to a standalone Node.js executable used by the AgentLink sandbox helper. Leave empty to probe Node.js from VS Code's inherited PATH and standard macOS installation locations. Electron is not supported.",
    });
    expect(properties["agentlink.terminal.environmentPolicy"]).toMatchObject({
      type: "object",
      scope: "machine",
      default: {
        inherit: "all",
        ignoreDefaultExcludes: true,
        exclude: [],
        set: {},
        includeOnly: [],
        useProfile: false,
      },
      additionalProperties: false,
    });
    expect(extensionSource).toContain(
      "the configured shell environment policy controls inherited variables",
    );
    expect(extensionSource).not.toContain(
      "credential-like environment variables are removed",
    );
    const commands = manifest.contributes?.commands ?? [];
    expect(commands).toContainEqual({
      command: "agentlink.openTerminal",
      title: "AgentLink: Open Terminal",
      icon: "$(terminal)",
    });
    expect(
      manifest.contributes?.menus?.commandPalette?.filter(
        (entry) => entry.command === "agentlink.openTerminal",
      ) ?? [],
    ).toEqual([]);
    expect(
      Object.values(manifest.contributes?.menus ?? {})
        .flat()
        .some((entry) => entry.command?.startsWith("agentlink.terminal.")),
    ).toBe(false);
  });

  it("composes the live terminal only behind the supported-host coordinator gate", () => {
    expect(extensionSource).toContain("Phase1HostTerminalCoordinator");
    expect(extensionSource).toContain("AgentTerminalViewProvider");
    expect(extensionSource).toContain("LiveHostTerminalSurfaceController");
    expect(extensionSource).toContain("createDeferredNodePtyLoader");
    expect(extensionSource).toContain('get<boolean>("terminal.enabled", true)');
    expect(extensionSource).toContain(
      'affectsConfiguration("agentlink.terminal.enabled")',
    );
    const createRuntimeStart = extensionSource.indexOf(
      "createRuntime: async () => {",
    );
    const liveControllerStart = extensionSource.indexOf(
      "new LiveHostTerminalSurfaceController",
      createRuntimeStart,
    );
    const createRuntimeEnd = extensionSource.indexOf(
      "onRuntimeUnavailable:",
      createRuntimeStart,
    );
    const sandboxAvailabilityStart = extensionSource.indexOf(
      "getSandboxAvailability:",
    );
    expect(createRuntimeStart).toBeGreaterThan(-1);
    expect(liveControllerStart).toBeGreaterThan(createRuntimeStart);
    expect(createRuntimeEnd).toBeGreaterThan(liveControllerStart);
    expect(
      extensionSource.slice(createRuntimeStart, createRuntimeEnd),
    ).not.toContain("ensureSandboxNodeRuntime");
    expect(extensionSource).toContain('get<string>("terminal.nodePath", "")');
    expect(extensionSource).toContain(
      'affectsConfiguration("agentlink.terminal.nodePath")',
    );
    expect(extensionSource).toContain(
      'affectsConfiguration("agentlink.terminal.environmentPolicy")',
    );
    expect(sandboxAvailabilityStart).toBeGreaterThan(createRuntimeEnd);
    const sandboxAvailability = extensionSource.slice(sandboxAvailabilityStart);
    expect(sandboxAvailability).toContain("ensureSandboxNodeRuntime");
    expect(sandboxAvailability).toContain("showSandboxRuntimeUnavailable");
    expect(extensionSource).toContain("resetSandboxNodeRuntime();");
    expect(extensionSource).toContain("SandboxBehaviorAttestationService");
    expect(extensionSource).toContain("createProductionSandboxBehaviorProbe");
    expect(extensionSource).not.toContain("isSandboxAvailable:");
    expect(extensionSource).toContain("retainContextWhenHidden: true");
  });

  it("keeps sandbox Node configuration out of custom-terminal lifecycle", () => {
    const subscriptionStart = extensionSource.indexOf(
      "subscribeEnabledChanges: (listener)",
    );
    const createRuntimeStart = extensionSource.indexOf(
      "createRuntime: async () => {",
      subscriptionStart,
    );
    const subscription = extensionSource.slice(
      subscriptionStart,
      createRuntimeStart,
    );

    expect(subscription).toContain(
      'affectsConfiguration("agentlink.terminal.enabled")',
    );
    expect(subscription).not.toContain("terminal.nodePath");
    expect(subscription).not.toContain("terminal.environmentPolicy");
    expect(subscription).not.toContain("resetSandboxNodeRuntime");
    expect(subscription).not.toContain("showSandboxRuntimeUnavailable");
  });

  it("keeps terminal-provider selection host-owned and preserves approval boundaries", () => {
    expect(extensionSource).toContain("initializeTerminalManager");
    expect(extensionSource).toContain("builtinApprovalPanel.onForwardApproval");
    expect(extensionSource).toContain("approvalPanel: builtinApprovalPanel");
    expect(extensionSource).toContain("AgentTerminalProviderRouter");
    expect(extensionSource).toContain("createVscodeTerminalProvider");
    expect(extensionSource).toContain("SandboxTerminalCoordinator");
    expect(extensionSource).toContain("TabTerminalProviderRegistry");
    expect(extensionSource).toContain("terminalProviderForSession:");
    expect(extensionSource).toContain("terminalProvider: undefined");
    expect(extensionSource).not.toContain(
      "terminalProvider: agentTerminalProvider",
    );
    expect(toolAdapterSource).not.toContain("createVscodeTerminalProvider");
    expect(extensionSource).not.toContain('from "node-pty"');
    expect(extensionSource).not.toContain('require("node-pty")');
  });

  it("builds and packages every terminal webview output", () => {
    expect(esbuildSource).toContain(
      'entryPoints: ["src/terminal/webview/index.tsx"]',
    );
    expect(esbuildSource).toContain('entryNames: "terminal"');
    for (const output of [
      "dist/terminal.js",
      "dist/terminal.js.map",
      "dist/terminal.css",
      "dist/terminal.css.map",
    ]) {
      expect(vscodeIgnoreSource).toContain(`!${output}`);
    }
  });

  it("keeps host terminal input out of browser and agent tool provider surfaces", () => {
    for (const source of [browserGatewayServerSource, toolAdapterSource]) {
      expect(source).not.toContain("host-terminal/");
      expect(source).not.toContain("AgentTerminalViewProvider");
      expect(source).not.toContain("Phase1HostTerminalCoordinator");
    }
  });

  it("keeps node-pty behind the trusted deferred loader boundary", () => {
    expect(deferredNodePtyLoaderSource).not.toMatch(
      /(?:from\s+|require\s*\()\s*["']node-pty["']/,
    );
    expect(STAGED_NODE_PTY_RELATIVE_PATH).toBe(
      path.join("dist", "sandbox-runtime", "node_modules", "node-pty"),
    );
  });
});
