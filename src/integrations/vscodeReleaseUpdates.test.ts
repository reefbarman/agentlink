import type * as vscode from "vscode";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerVscodeReleaseUpdates } from "./vscodeReleaseUpdates.js";

const mocks = vi.hoisted(() => ({
  options: undefined as unknown,
  automatic: true,
  update: vi.fn(async () => {}),
  commands: new Map<string, () => Promise<void>>(),
  executeCommand: vi.fn(async () => {}),
  focus: undefined as ((state: { focused: boolean }) => void) | undefined,
  configuration: undefined as
    | ((event: { affectsConfiguration: (key: string) => boolean }) => void)
    | undefined,
  listener: undefined as (() => void) | undefined,
  start: vi.fn(async () => {}),
  check: vi.fn(async () => {}),
  checkDue: vi.fn(),
  setAutomaticChecks: vi.fn(async () => {}),
  dispose: vi.fn(),
}));
vi.mock("vscode", () => ({
  version: "1.105.0",
  ExtensionMode: { Production: 1, Development: 2 },
  ConfigurationTarget: { Global: 1 },
  env: { remoteName: "ssh-remote" },
  workspace: {
    getConfiguration: () => ({
      get: () => mocks.automatic,
      update: mocks.update,
    }),
    onDidChangeConfiguration: (listener: typeof mocks.configuration) => {
      mocks.configuration = listener;
      return { dispose: vi.fn() };
    },
  },
  window: {
    onDidChangeWindowState: (listener: typeof mocks.focus) => {
      mocks.focus = listener;
      return { dispose: vi.fn() };
    },
  },
  commands: {
    executeCommand: mocks.executeCommand,
    registerCommand: (id: string, handler: () => Promise<void>) => {
      mocks.commands.set(id, handler);
      return { dispose: vi.fn() };
    },
  },
}));
vi.mock("../updates/ReleaseUpdateService.js", () => ({
  ReleaseUpdateService: class {
    constructor(options: unknown) {
      mocks.options = options;
    }
    start = mocks.start;
    check = mocks.check;
    checkDue = mocks.checkDue;
    setAutomaticChecks = mocks.setAutomaticChecks;
    dispose = mocks.dispose;
    snapshot = () => ({ automaticChecks: true });
    subscribe(listener: () => void) {
      mocks.listener = listener;
      return vi.fn();
    }
  },
}));

function register(mode = 1) {
  const context = {
    extension: {
      packageJSON: {
        version: "2.3.4",
        __metadata: { targetPlatform: "linux-arm64" },
      },
    },
    extensionMode: mode,
    globalStorageUri: { fsPath: "/profile/global/agentlink" },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
  const provider = {
    setReleaseUpdateService: vi.fn(),
    sendReleaseUpdateState: vi.fn(),
    log: vi.fn(),
  };
  const service = registerVscodeReleaseUpdates(context, provider as never);
  return { context, provider, service };
}

describe("VS Code release update composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.automatic = true;
    mocks.commands.clear();
  });

  it("uses the running extension and host target, and keeps storage app-level", () => {
    const { context, provider, service } = register();
    expect(mocks.options).toMatchObject({
      identity: {
        product: "vscode",
        version: "2.3.4",
        target: "linux-arm64",
        vscodeVersion: "1.105.0",
        hostLabel: "Remote extension host (ssh-remote)",
        development: false,
      },
      storageDirectory: "/profile/global/agentlink/updates",
      automaticChecks: true,
    });
    expect(provider.setReleaseUpdateService).toHaveBeenCalledWith(service);
    expect(context.subscriptions).toContain(service);
    expect(mocks.start).toHaveBeenCalledOnce();
    mocks.listener!();
    expect(provider.sendReleaseUpdateState).toHaveBeenCalledWith();
  });

  it("opens manual details and checks without starting any installer", async () => {
    const { provider } = register();
    await mocks.commands.get("agentlink.checkForUpdates")!();
    expect(mocks.executeCommand).toHaveBeenCalledExactlyOnceWith(
      "agentLink.chatView.focus",
    );
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(provider.sendReleaseUpdateState).toHaveBeenNthCalledWith(1, true);
    expect(provider.sendReleaseUpdateState).toHaveBeenNthCalledWith(2, true);
  });

  it("forwards focus and user-level opt-out to the service", async () => {
    register(2);
    expect(mocks.options).toMatchObject({ identity: { development: true } });
    mocks.focus!({ focused: false });
    expect(mocks.checkDue).not.toHaveBeenCalled();
    mocks.focus!({ focused: true });
    expect(mocks.checkDue).toHaveBeenCalledOnce();
    mocks.automatic = false;
    mocks.configuration!({
      affectsConfiguration: (key) =>
        key === "agentlink.updates.automaticChecks",
    });
    expect(mocks.setAutomaticChecks).toHaveBeenCalledWith(false);
    const options = mocks.options as {
      saveAutomaticChecks: (value: boolean) => Promise<void>;
    };
    await options.saveAutomaticChecks(false);
    expect(mocks.update).toHaveBeenCalledWith(
      "updates.automaticChecks",
      false,
      1,
    );
  });
});
