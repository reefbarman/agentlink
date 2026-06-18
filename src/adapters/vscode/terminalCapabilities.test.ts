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

  it("delegates terminal state and control methods to TerminalManager", () => {
    terminalManager.getBackgroundState.mockReturnValue({
      is_running: true,
      exit_code: null,
      output: "running",
      output_captured: true,
    });
    terminalManager.interruptTerminal.mockReturnValue(true);
    terminalManager.getRecentlyClosedTerminals.mockReturnValue([
      { id: "term_1", name: "Server", closedAt: 123 },
    ]);
    terminalManager.listTerminals.mockReturnValue([
      { id: "term_2", name: "Tests", busy: false },
    ]);
    terminalManager.closeTerminals.mockReturnValue({ closed: 1 });

    const provider = createVscodeTerminalProvider();

    expect(provider.getBackgroundState("term_1")).toEqual({
      is_running: true,
      exit_code: null,
      output: "running",
      output_captured: true,
    });
    expect(provider.interruptTerminal("term_1")).toBe(true);
    expect(provider.getRecentlyClosedTerminals(5)).toEqual([
      { id: "term_1", name: "Server", closedAt: 123 },
    ]);
    expect(provider.listTerminals()).toEqual([
      { id: "term_2", name: "Tests", busy: false },
    ]);
    expect(provider.closeTerminals(["Server"])).toEqual({ closed: 1 });

    expect(terminalManager.getBackgroundState).toHaveBeenCalledWith("term_1");
    expect(terminalManager.interruptTerminal).toHaveBeenCalledWith("term_1");
    expect(terminalManager.getRecentlyClosedTerminals).toHaveBeenCalledWith(5);
    expect(terminalManager.closeTerminals).toHaveBeenCalledWith(["Server"]);
  });

  it("proxies log access to TerminalManager", () => {
    const provider = createVscodeTerminalProvider();
    const log = vi.fn();

    provider.log = log;

    expect(terminalManager.log).toBe(log);
    expect(provider.log).toBe(log);
  });
});
