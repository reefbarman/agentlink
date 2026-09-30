import * as vscode from "vscode";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCliInstallCommand,
  findStandaloneRelease,
} from "./standaloneReleaseInstall.js";

import { registerStandaloneInstallCommands } from "./standaloneInstallCommands.js";

vi.mock("vscode", async () => {
  const mock = await import("../__mocks__/vscode.js");
  return {
    ...mock,
    env: { remoteName: undefined, openExternal: vi.fn() },
    ProgressLocation: { Notification: 15 },
    window: { ...mock.window, withProgress: vi.fn(), createTerminal: vi.fn() },
  };
});
vi.mock("./standaloneReleaseInstall.js", () => ({
  findStandaloneRelease: vi.fn(),
  buildCliInstallCommand: vi.fn(() => "verified install script"),
}));

const release = {
  tag: "cli-v0.1.0",
  asset: {
    name: "archive",
    browser_download_url: "https://github.com/release",
  },
};
const handlers = new Map<string, () => Promise<void>>();

describe("standalone install commands", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
    Object.assign(vscode.env, { remoteName: undefined });
    vi.spyOn(vscode.commands, "registerCommand").mockImplementation(
      (id, handler) => {
        handlers.set(id, handler);
        return { dispose: vi.fn() };
      },
    );
    vi.spyOn(vscode.window, "withProgress").mockImplementation(
      async (_options, task) =>
        task({ report: vi.fn() }, {} as vscode.CancellationToken),
    );
    vi.mocked(findStandaloneRelease).mockResolvedValue(release);
    vi.mocked(buildCliInstallCommand).mockReturnValue(
      "verified install script",
    );
    registerStandaloneInstallCommands();
  });
  afterEach(() => vi.restoreAllMocks());

  it("does not start installation after cancellation", async () => {
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);
    await handlers.get("agentlink.installCli")!();
    expect(vscode.window.createTerminal).not.toHaveBeenCalled();
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
  });

  it("forwards the selected release into the visible CLI terminal", async () => {
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(
      "Install in Terminal" as never,
    );
    const terminal = { show: vi.fn(), sendText: vi.fn() };
    vi.spyOn(vscode.window, "createTerminal").mockReturnValue(
      terminal as unknown as vscode.Terminal,
    );
    await handlers.get("agentlink.installCli")!();
    expect(findStandaloneRelease).toHaveBeenCalledWith("cli", "arm64");
    expect(buildCliInstallCommand).toHaveBeenCalledWith(release);
    expect(terminal.show).toHaveBeenCalledOnce();
    expect(terminal.sendText).toHaveBeenCalledWith("verified install script");
  });

  it("opens the selected desktop DMG only after confirmation", async () => {
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(
      "Download DMG" as never,
    );
    vi.mocked(vscode.env.openExternal).mockResolvedValue(true);
    await handlers.get("agentlink.installDesktopApp")!();
    expect(findStandaloneRelease).toHaveBeenCalledWith("desktop", "arm64");
    expect(vscode.env.openExternal).toHaveBeenCalledOnce();
    expect(vscode.window.createTerminal).not.toHaveBeenCalled();
  });

  it("refuses remote extension hosts before fetching or running anything", async () => {
    Object.assign(vscode.env, { remoteName: "ssh-remote" });
    await handlers.get("agentlink.installCli")!();
    expect(findStandaloneRelease).not.toHaveBeenCalled();
    expect(vscode.window.createTerminal).not.toHaveBeenCalled();
  });

  it("refuses Intel CLI installs but permits desktop discovery", async () => {
    vi.spyOn(process, "arch", "get").mockReturnValue("x64");
    await handlers.get("agentlink.installCli")!();
    expect(findStandaloneRelease).not.toHaveBeenCalled();
    await handlers.get("agentlink.installDesktopApp")!();
    expect(findStandaloneRelease).toHaveBeenCalledWith("desktop", "x64");
  });
});
