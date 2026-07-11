import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", async () => ({
  ...(await import("../__mocks__/vscode.js")),
  env: {
    openExternal: vi.fn(async () => true),
    clipboard: { writeText: vi.fn(async () => {}) },
  },
}));

import * as vscode from "vscode";
import type { BrowserGatewayHelperDiscoveryRecord } from "./protocol.js";
import {
  collectGatewayUrls,
  registerBrowserGatewayCommands,
  type BrowserGatewayCommandDependencies,
} from "./browserGatewayCommands.js";

const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();

function discovery(
  overrides: Partial<BrowserGatewayHelperDiscoveryRecord> = {},
): BrowserGatewayHelperDiscoveryRecord {
  return {
    pid: 123,
    port: 47137,
    url: "http://127.0.0.1:47137",
    protocolVersion: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    helperVersion: "1.2.3",
    browserBootstrapToken: "bootstrap",
    clientSharedSecret: "secret",
    ...overrides,
  };
}

function createDependencies(
  current: BrowserGatewayHelperDiscoveryRecord | null = discovery(),
): BrowserGatewayCommandDependencies {
  return {
    ensureRuntimeReady: vi.fn(async () => {}),
    forceRestart: vi.fn(async () => {}),
    pairBrowserDevice: vi.fn(async () => {}),
    managePairedDevices: vi.fn(async () => {}),
    getDiscovery: vi.fn(() => current),
    extensionVersion: "9.8.7",
    formatError: vi.fn((error) => `formatted: ${String(error)}`),
    log: vi.fn(),
  };
}

async function invoke(command: string): Promise<void> {
  const handler = commandHandlers.get(command);
  expect(handler).toBeTypeOf("function");
  await handler!();
}

describe("collectGatewayUrls", () => {
  it("orders mDNS, LAN IP, and loopback URLs while removing duplicates", () => {
    expect(
      collectGatewayUrls(
        discovery({
          lanAccess: true,
          mdnsUrl: "http://agentlink.local:47137",
          lanUrls: ["http://192.168.1.2:47137", "http://agentlink.local:47137"],
        }),
      ),
    ).toEqual([
      "http://agentlink.local:47137",
      "http://192.168.1.2:47137",
      "http://127.0.0.1:47137",
    ]);
  });

  it("returns only loopback when LAN access is disabled", () => {
    expect(
      collectGatewayUrls(
        discovery({
          lanAccess: false,
          mdnsUrl: "http://agentlink.local:47137",
          lanUrls: ["http://192.168.1.2:47137"],
        }),
      ),
    ).toEqual(["http://127.0.0.1:47137"]);
  });
});

describe("registerBrowserGatewayCommands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    commandHandlers.clear();
    vi.mocked(vscode.env.openExternal).mockClear();
    vi.mocked(vscode.env.clipboard.writeText).mockClear();
    vi.spyOn(vscode.commands, "registerCommand").mockImplementation(
      (command: string, callback: (...args: unknown[]) => unknown) => {
        commandHandlers.set(command, callback);
        return { dispose: vi.fn() };
      },
    );
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(
      undefined,
    );
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);
    vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
  });

  it("registers the complete browser gateway command group", () => {
    const disposables = registerBrowserGatewayCommands(createDependencies());

    expect([...commandHandlers.keys()]).toEqual([
      "agentlink.restartBrowserGateway",
      "agentlink.openBrowserGateway",
      "agentlink.showBrowserGatewayStatus",
      "agentlink.pairBrowserDevice",
      "agentlink.managePairedDevices",
    ]);
    expect(disposables).toHaveLength(5);
  });

  it.each([
    ["agentlink.pairBrowserDevice", "pairBrowserDevice"],
    ["agentlink.managePairedDevices", "managePairedDevices"],
  ] as const)(
    "prepares the runtime before delegating %s",
    async (command, action) => {
      const dependencies = createDependencies();
      registerBrowserGatewayCommands(dependencies);

      await invoke(command);

      expect(dependencies.ensureRuntimeReady).toHaveBeenCalledOnce();
      expect(dependencies[action]).toHaveBeenCalledOnce();
    },
  );

  it("opens loopback directly when LAN access is disabled", async () => {
    const dependencies = createDependencies(discovery({ lanAccess: false }));
    registerBrowserGatewayCommands(dependencies);

    await invoke("agentlink.openBrowserGateway");

    expect(dependencies.ensureRuntimeReady).toHaveBeenCalledOnce();
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(vscode.env.openExternal).toHaveBeenCalledWith(
      expect.objectContaining({ path: "http://127.0.0.1:47137" }),
    );
  });

  it("offers ordered LAN URLs and opens the selected URL", async () => {
    const dependencies = createDependencies(
      discovery({
        lanAccess: true,
        mdnsUrl: "http://agentlink.local:47137",
        lanUrls: ["http://192.168.1.2:47137"],
      }),
    );
    registerBrowserGatewayCommands(dependencies);
    vi.mocked(vscode.window.showQuickPick).mockImplementation(async (items) =>
      Array.isArray(items) ? items[1] : undefined,
    );

    await invoke("agentlink.openBrowserGateway");

    expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          label: "http://agentlink.local:47137",
          description: "mDNS — works on the same network",
        }),
        expect.objectContaining({ label: "http://192.168.1.2:47137" }),
      ]),
      expect.objectContaining({ title: "Open Browser Gateway" }),
    );
    expect(vscode.env.openExternal).toHaveBeenCalledWith(
      expect.objectContaining({ path: "http://192.168.1.2:47137" }),
    );
  });

  it("restarts and opens the preferred discovered URL on request", async () => {
    const dependencies = createDependencies(
      discovery({
        lanAccess: true,
        mdnsUrl: "http://agentlink.local:47137",
      }),
    );
    registerBrowserGatewayCommands(dependencies);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      "Open Browser Gateway" as never,
    );

    await invoke("agentlink.restartBrowserGateway");

    expect(dependencies.forceRestart).toHaveBeenCalledOnce();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("helperVersion 1.2.3, extension 9.8.7"),
      "Open Browser Gateway",
    );
    expect(vscode.env.openExternal).toHaveBeenCalledWith(
      expect.objectContaining({ path: "http://agentlink.local:47137" }),
    );
  });

  it("formats status and copies the selected URL", async () => {
    const current = discovery({
      lanAccess: true,
      mdnsUrl: "http://agentlink.local:47137",
      lanUrls: ["http://192.168.1.2:47137"],
    });
    const dependencies = createDependencies(current);
    registerBrowserGatewayCommands(dependencies);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      "Copy loopback URL" as never,
    );

    await invoke("agentlink.showBrowserGatewayStatus");

    expect(dependencies.log).toHaveBeenCalledWith(
      expect.stringContaining("LAN IP URLs: http://192.168.1.2:47137"),
    );
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(current.url);
  });

  it.each([
    "agentlink.openBrowserGateway",
    "agentlink.pairBrowserDevice",
    "agentlink.managePairedDevices",
    "agentlink.showBrowserGatewayStatus",
  ])("reports runtime errors for %s", async (command) => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.ensureRuntimeReady).mockRejectedValue(
      new Error("not ready"),
    );
    registerBrowserGatewayCommands(dependencies);

    await invoke(command);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "formatted: Error: not ready",
    );
    expect(dependencies.pairBrowserDevice).not.toHaveBeenCalled();
    expect(dependencies.managePairedDevices).not.toHaveBeenCalled();
  });
});
