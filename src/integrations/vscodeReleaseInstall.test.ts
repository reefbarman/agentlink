import type * as vscode from "vscode";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import type { ReleaseUpdateService } from "../updates/ReleaseUpdateService.js";
import os from "node:os";
import path from "node:path";
import { registerVscodeReleaseInstall } from "./vscodeReleaseInstall.js";

const mocks = vi.hoisted(() => ({
  commands: new Map<string, () => Promise<void>>(),
  execute: vi.fn(async () => {}),
  confirm: vi.fn(async () => "Install"),
  error: vi.fn(),
  download: vi.fn(async () => "/tmp/update.vsix"),
  release: vi.fn(async () => {}),
  lock: vi.fn(),
  env: { remoteName: undefined as string | undefined },
}));
vi.mock("vscode", () => ({
  env: mocks.env,
  Uri: { file: (file: string) => ({ scheme: "file", fsPath: file }) },
  ProgressLocation: { Notification: 1 },
  commands: {
    registerCommand: (id: string, fn: () => Promise<void>) => {
      mocks.commands.set(id, fn);
      return { dispose() {} };
    },
    executeCommand: mocks.execute,
  },
  window: {
    showWarningMessage: mocks.confirm,
    showInformationMessage: vi.fn(),
    showErrorMessage: mocks.error,
    onDidChangeWindowState: () => ({ dispose() {} }),
    withProgress: async (
      _options: unknown,
      task: (progress: unknown, token: unknown) => Promise<void>,
    ) =>
      task(
        { report() {} },
        { onCancellationRequested: () => ({ dispose() {} }) },
      ),
  },
}));
vi.mock("../updates/releaseInstall.js", () => ({
  downloadReleaseUpdate: mocks.download,
  acquireInstallLock: async () => {
    mocks.lock();
    return mocks.release;
  },
}));
let directory: string;
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.env.remoteName = undefined;
  directory = await mkdtemp(path.join(os.tmpdir(), "vscode-update-"));
  mocks.confirm.mockResolvedValue("Install");
  mocks.download.mockResolvedValue("/tmp/update.vsix");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
function setup(development = false) {
  const state = {
    identity: {
      product: "vscode",
      version: "1.0.0",
      target: "darwin-arm64",
      development,
    },
    candidate: { version: "1.1.0", tag: "v1.1.0" },
  };
  const service = {
    snapshot: () => state,
    check: vi.fn(async () => state),
  } as unknown as ReleaseUpdateService;
  const publish = vi.fn();
  registerVscodeReleaseInstall(
    { globalStorageUri: { fsPath: directory } } as vscode.ExtensionContext,
    service,
    publish,
  );
  return { publish, service };
}
describe("VS Code self-update", () => {
  it("installs a verified VSIX and does not reload without separate consent", async () => {
    const { publish } = setup();
    await mocks.commands.get("agentlink.installUpdate")!();
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(mocks.execute).toHaveBeenCalledExactlyOnceWith(
      "workbench.extensions.installExtension",
      { scheme: "file", fsPath: "/tmp/update.vsix" },
    );
    expect(mocks.confirm).toHaveBeenCalledTimes(2);
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ready_to_restart", version: "1.1.0" }),
    );
    expect(
      JSON.parse(
        await readFile(path.join(directory, "updates/installed.json"), "utf8"),
      ).version,
    ).toBe("1.1.0");
  });
  it("reloads only after Reload Window is selected", async () => {
    setup();
    mocks.confirm
      .mockResolvedValueOnce("Install")
      .mockResolvedValueOnce("Reload Window");
    await mocks.commands.get("agentlink.installUpdate")!();
    expect(mocks.execute).toHaveBeenLastCalledWith(
      "workbench.action.reloadWindow",
    );
  });
  it.each(["source", "remote"])(
    "blocks %s installs without downloads",
    async (kind) => {
      const { publish } = setup(kind === "source");
      if (kind === "remote") mocks.env.remoteName = "ssh-remote";
      await mocks.commands.get("agentlink.installUpdate")!();
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "blocked" }),
      );
      expect(mocks.download).not.toHaveBeenCalled();
    },
  );
  it("leaves the install untouched when confirmation is cancelled", async () => {
    setup();
    mocks.confirm.mockResolvedValue("");
    await mocks.commands.get("agentlink.installUpdate")!();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.lock).not.toHaveBeenCalled();
  });
  it("does not install or reload on a download failure", async () => {
    const { publish } = setup();
    mocks.download.mockRejectedValueOnce(new Error("checksum mismatch"));
    await mocks.commands.get("agentlink.installUpdate")!();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "failed",
        message: "checksum mismatch",
      }),
    );
  });
  it("does not reinstall the same version from another window", async () => {
    setup();
    await mocks.commands.get("agentlink.installUpdate")!();
    const { publish } = setup();
    await mocks.commands.get("agentlink.installUpdate")!();
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ready_to_restart" }),
    );
  });
});
