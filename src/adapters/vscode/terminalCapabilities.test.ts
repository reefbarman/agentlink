import { beforeEach, describe, expect, it, vi } from "vitest";

import { createVscodeTerminalProvider } from "./terminalCapabilities.js";

const terminalManager = vi.hoisted(() => ({
  log: undefined as ((message: string) => void) | undefined,
  executeCommand: vi.fn(),
  getBackgroundState: vi.fn(),
  interruptTerminal: vi.fn(),
  getRecentlyClosedTerminals: vi.fn(),
  listTerminals: vi.fn(),
  closeTerminals: vi.fn(),
}));

vi.mock("../../integrations/TerminalManager.js", () => ({
  getTerminalManager: () => terminalManager,
}));

describe("createVscodeTerminalProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalManager.log = undefined;
  });

  it("delegates command execution to TerminalManager", async () => {
    terminalManager.executeCommand.mockResolvedValue({
      exit_code: 0,
      output: "ok",
      output_captured: true,
      terminal_id: "term_1",
    });

    const provider = createVscodeTerminalProvider();
    const onTerminalAssigned = vi.fn();
    const result = await provider.executeCommand({
      owner: undefined,
      command: "npm test",
      cwd: "/workspace",
      timeout: 1000,
      onTerminalAssigned,
    });

    expect(result).toEqual({
      exit_code: 0,
      output: "ok",
      output_captured: true,
      terminal_id: "term_1",
    });
    expect(terminalManager.executeCommand).toHaveBeenCalledWith({
      command: "npm test",
      cwd: "/workspace",
      timeout: 1000,
      onTerminalAssigned,
    });
  });

  it("fails closed for sandbox capability and authorization inputs", async () => {
    const provider = createVscodeTerminalProvider();

    await expect(
      provider.executeCommand({
        owner: undefined,
        command: "curl https://example.com",
        cwd: "/workspace",
        sandboxCapabilityRequest: { unrestrictedPublicNetwork: true },
      }),
    ).rejects.toThrow(
      "Sandbox capability requests cannot run in the native VS Code terminal provider.",
    );
    await expect(
      provider.executeCommand({
        owner: undefined,
        command: "pwd",
        cwd: "/workspace",
        sandbox: {
          policy: {
            version: "test",
            profileId: "test",
            readableRoots: [],
            writableRoots: [],
            deniedRoots: [],
            protectedReadOnlyRoots: [],
            network: { mode: "loopback" },
            environment: { inheritHost: false, values: {} },
            allowedUnixSockets: [],
          },
          bindingDigest: "binding",
        },
      }),
    ).rejects.toThrow(
      "Sandbox capability requests cannot run in the native VS Code terminal provider.",
    );
    expect(terminalManager.executeCommand).not.toHaveBeenCalled();
  });

  it("delegates terminal state and control methods to TerminalManager", () => {
    terminalManager.getBackgroundState.mockReturnValue({
      is_running: true,
      state: "running",
      exit_code: null,
      output: "running",
      output_captured: true,
    });
    terminalManager.interruptTerminal.mockReturnValue(true);
    terminalManager.getRecentlyClosedTerminals.mockReturnValue([
      {
        id: "term_1",
        name: "Server",
        closedAt: 123,
        is_running: false,
        state: "completed",
        exit_code: 0,
        output: "done",
        output_captured: true,
      },
    ]);
    terminalManager.listTerminals.mockReturnValue([
      { id: "term_2", name: "Tests", busy: false },
    ]);
    terminalManager.closeTerminals.mockReturnValue({ closed: 1 });

    const provider = createVscodeTerminalProvider();

    const targetRequest = { owner: undefined, terminalId: "term_1" };
    const recentRequest = { owner: undefined, limit: 5 };
    const listRequest = { owner: undefined };
    const closeRequest = { owner: undefined, names: ["Server"] };

    expect(provider.getBackgroundState(targetRequest)).toEqual({
      is_running: true,
      state: "running",
      exit_code: null,
      output: "running",
      output_captured: true,
    });
    expect(provider.interruptTerminal(targetRequest)).toBe(true);
    expect(provider.getRecentlyClosedTerminals(recentRequest)).toEqual([
      {
        id: "term_1",
        name: "Server",
        closedAt: 123,
        is_running: false,
        state: "completed",
        exit_code: 0,
        output: "done",
        output_captured: true,
      },
    ]);
    expect(provider.listTerminals(listRequest)).toEqual([
      { id: "term_2", name: "Tests", busy: false },
    ]);
    expect(provider.closeTerminals(closeRequest)).toEqual({ closed: 1 });

    expect(terminalManager.getBackgroundState).toHaveBeenCalledWith(
      targetRequest,
    );
    expect(terminalManager.interruptTerminal).toHaveBeenCalledWith(
      targetRequest,
    );
    expect(terminalManager.getRecentlyClosedTerminals).toHaveBeenCalledWith(
      recentRequest,
    );
    expect(terminalManager.listTerminals).toHaveBeenCalledWith(listRequest);
    expect(terminalManager.closeTerminals).toHaveBeenCalledWith(closeRequest);
  });

  it("proxies log access to TerminalManager", () => {
    const provider = createVscodeTerminalProvider();
    const log = vi.fn();

    provider.log = log;

    expect(terminalManager.log).toBe(log);
    expect(provider.log).toBe(log);
  });
});
