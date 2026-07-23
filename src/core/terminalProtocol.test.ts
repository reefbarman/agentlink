import {
  EMPTY_HOST_TERMINAL_STATE,
  isHostTerminalRequest,
  isValidTerminalDimensions,
  reduceHostTerminalState,
  type HostTerminalTab,
} from "./terminalProtocol.js";
import { describe, expect, it } from "vitest";

function terminal(id: string): HostTerminalTab {
  return {
    id,
    title: id,
    cwd: `/workspace/${id}`,
    profileName: "zsh",
    dimensions: { columns: 80, rows: 24 },
    status: "running",
  };
}

describe("host terminal protocol", () => {
  it("validates positive integer dimensions", () => {
    expect(isValidTerminalDimensions({ columns: 80, rows: 24 })).toBe(true);
    expect(isValidTerminalDimensions({ columns: 0, rows: 24 })).toBe(false);
    expect(isValidTerminalDimensions({ columns: 80.5, rows: 24 })).toBe(false);
  });

  it("validates exact request shapes at the future webview boundary", () => {
    expect(
      isHostTerminalRequest({
        type: "host-terminal/create",
        requestId: "request-1",
        cwd: "/workspace",
      }),
    ).toBe(true);
    expect(
      isHostTerminalRequest({
        type: "host-terminal/write",
        terminalId: "terminal-1",
        data: "hello\r",
      }),
    ).toBe(true);
    expect(
      isHostTerminalRequest({
        type: "host-terminal/resize",
        terminalId: "terminal-1",
        dimensions: { columns: 120, rows: 40 },
      }),
    ).toBe(true);
    expect(
      isHostTerminalRequest({
        type: "host-terminal/resize",
        terminalId: "terminal-1",
        dimensions: { columns: 0, rows: 40 },
      }),
    ).toBe(false);
    expect(
      isHostTerminalRequest({
        type: "host-terminal/close",
        terminalId: "terminal-1",
        agentWritable: true,
      }),
    ).toBe(false);
    expect(
      isHostTerminalRequest({
        type: "host-terminal/write",
        terminalId: "terminal-1",
        data: "bad\0data",
      }),
    ).toBe(false);
    expect(
      isHostTerminalRequest({
        type: "host-terminal/write",
        terminalId: "terminal-1",
        data: "x".repeat(64 * 1024 + 1),
      }),
    ).toBe(false);
  });

  it("opens unique tabs and activates the newest tab", () => {
    const first = reduceHostTerminalState(EMPTY_HOST_TERMINAL_STATE, {
      type: "host-terminal/opened",
      terminal: terminal("one"),
    });
    const second = reduceHostTerminalState(first, {
      type: "host-terminal/opened",
      terminal: terminal("two"),
    });
    expect(second.tabs.map((tab) => tab.id)).toEqual(["one", "two"]);
    expect(second.activeTabId).toBe("two");
    expect(
      reduceHostTerminalState(second, {
        type: "host-terminal/opened",
        terminal: terminal("two"),
      }),
    ).toBe(second);
  });

  it("opens agent tabs quietly and clears unread activity when activated", () => {
    let state = reduceHostTerminalState(EMPTY_HOST_TERMINAL_STATE, {
      type: "host-terminal/opened",
      terminal: terminal("user"),
    });
    state = reduceHostTerminalState(state, {
      type: "host-terminal/opened",
      terminal: terminal("agent"),
      activate: false,
    });
    expect(state.activeTabId).toBe("user");

    state = reduceHostTerminalState(state, {
      type: "host-terminal/agent-activity",
      terminalId: "agent",
      activity: "unread",
    });
    expect(state.tabs[1]).toMatchObject({
      id: "agent",
      agentActivity: "unread",
    });

    state = reduceHostTerminalState(state, {
      type: "host-terminal/activated",
      terminalId: "agent",
    });
    expect(state.activeTabId).toBe("agent");
    expect(state.tabs[1]?.agentActivity).toBeUndefined();
  });

  it("updates cwd, dimensions, and exit state without storing stream data", () => {
    let state = reduceHostTerminalState(EMPTY_HOST_TERMINAL_STATE, {
      type: "host-terminal/opened",
      terminal: terminal("one"),
    });
    state = reduceHostTerminalState(state, {
      type: "host-terminal/cwd",
      terminalId: "one",
      cwd: "/workspace/next",
    });
    state = reduceHostTerminalState(state, {
      type: "host-terminal/resized",
      terminalId: "one",
      dimensions: { columns: 120, rows: 40 },
    });
    const beforeData = state;
    expect(
      reduceHostTerminalState(state, {
        type: "host-terminal/data",
        terminalId: "one",
        data: "output",
      }),
    ).toBe(beforeData);
    state = reduceHostTerminalState(state, {
      type: "host-terminal/exited",
      terminalId: "one",
      exitCode: 0,
    });
    expect(state.tabs[0]).toMatchObject({
      cwd: "/workspace/next",
      dimensions: { columns: 120, rows: 40 },
      status: "exited",
      exitCode: 0,
    });
    expect(state.tabs[0]).not.toHaveProperty("signal");
  });

  it("ignores stale IDs and activates the neighboring tab when closing", () => {
    const first = reduceHostTerminalState(EMPTY_HOST_TERMINAL_STATE, {
      type: "host-terminal/opened",
      terminal: terminal("one"),
    });
    let state = reduceHostTerminalState(first, {
      type: "host-terminal/opened",
      terminal: terminal("two"),
    });
    expect(
      reduceHostTerminalState(state, {
        type: "host-terminal/activated",
        terminalId: "missing",
      }),
    ).toBe(state);
    state = reduceHostTerminalState(state, {
      type: "host-terminal/closed",
      terminalId: "two",
    });
    expect(state.tabs.map((tab) => tab.id)).toEqual(["one"]);
    expect(state.activeTabId).toBe("one");
    state = reduceHostTerminalState(state, {
      type: "host-terminal/closed",
      terminalId: "one",
    });
    expect(state).toEqual({ tabs: [], activeTabId: undefined });
  });
});
