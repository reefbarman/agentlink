const MAX_HOST_TERMINAL_INPUT_BYTES = 64 * 1024;

export type TerminalChannelKind = "user-host" | "agent-sandbox";

export interface TerminalDimensions {
  columns: number;
  rows: number;
}

export interface HostTerminalTab {
  id: string;
  title: string;
  channelKind?: TerminalChannelKind;
  cwd: string;
  profileName: string;
  dimensions: TerminalDimensions;
  status: "starting" | "running" | "exited";
  exitCode?: number;
  signal?: number;
}

export interface HostTerminalState {
  tabs: HostTerminalTab[];
  activeTabId?: string;
}

export type HostTerminalRequest =
  | {
      type: "host-terminal/create";
      requestId: string;
      cwd?: string;
      profileName?: string;
    }
  | { type: "host-terminal/write"; terminalId: string; data: string }
  | {
      type: "host-terminal/resize";
      terminalId: string;
      dimensions: TerminalDimensions;
    }
  | { type: "host-terminal/activate"; terminalId: string }
  | { type: "host-terminal/close"; terminalId: string };

export type HostTerminalEvent =
  | { type: "host-terminal/opened"; terminal: HostTerminalTab }
  | { type: "host-terminal/data"; terminalId: string; data: string }
  | { type: "host-terminal/cwd"; terminalId: string; cwd: string }
  | {
      type: "host-terminal/resized";
      terminalId: string;
      dimensions: TerminalDimensions;
    }
  | { type: "host-terminal/activated"; terminalId: string }
  | {
      type: "host-terminal/exited";
      terminalId: string;
      exitCode?: number;
      signal?: number;
    }
  | { type: "host-terminal/closed"; terminalId: string }
  | {
      type: "host-terminal/error";
      requestId?: string;
      terminalId?: string;
      message: string;
    };

export const EMPTY_HOST_TERMINAL_STATE: HostTerminalState = { tabs: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

export function isValidTerminalDimensions(
  dimensions: TerminalDimensions,
): boolean {
  return (
    Number.isInteger(dimensions.columns) &&
    dimensions.columns > 0 &&
    Number.isInteger(dimensions.rows) &&
    dimensions.rows > 0
  );
}

export function isHostTerminalRequest(
  value: unknown,
): value is HostTerminalRequest {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "host-terminal/create") {
    return (
      hasOnlyKeys(value, ["type", "requestId", "cwd", "profileName"]) &&
      isNonEmptyString(value.requestId) &&
      (value.cwd === undefined || isNonEmptyString(value.cwd)) &&
      (value.profileName === undefined || isNonEmptyString(value.profileName))
    );
  }
  if (value.type === "host-terminal/write") {
    return (
      hasOnlyKeys(value, ["type", "terminalId", "data"]) &&
      isNonEmptyString(value.terminalId) &&
      typeof value.data === "string" &&
      !value.data.includes("\0") &&
      new TextEncoder().encode(value.data).byteLength <=
        MAX_HOST_TERMINAL_INPUT_BYTES
    );
  }
  if (value.type === "host-terminal/resize") {
    return (
      hasOnlyKeys(value, ["type", "terminalId", "dimensions"]) &&
      isNonEmptyString(value.terminalId) &&
      isRecord(value.dimensions) &&
      hasOnlyKeys(value.dimensions, ["columns", "rows"]) &&
      isValidTerminalDimensions(
        value.dimensions as unknown as TerminalDimensions,
      )
    );
  }
  if (
    value.type === "host-terminal/activate" ||
    value.type === "host-terminal/close"
  ) {
    return (
      hasOnlyKeys(value, ["type", "terminalId"]) &&
      isNonEmptyString(value.terminalId)
    );
  }
  return false;
}

export function reduceHostTerminalState(
  state: HostTerminalState,
  event: HostTerminalEvent,
): HostTerminalState {
  if (event.type === "host-terminal/opened") {
    // Terminal IDs are immutable identities; repeated opens are idempotent,
    // not last-write-wins updates.
    if (state.tabs.some((terminal) => terminal.id === event.terminal.id)) {
      return state;
    }
    return {
      tabs: [...state.tabs, event.terminal],
      activeTabId: event.terminal.id,
    };
  }
  if (event.type === "host-terminal/closed") {
    const index = state.tabs.findIndex(
      (terminal) => terminal.id === event.terminalId,
    );
    if (index === -1) return state;
    const tabs = state.tabs.filter(
      (terminal) => terminal.id !== event.terminalId,
    );
    if (state.activeTabId !== event.terminalId) {
      return { ...state, tabs };
    }
    return {
      tabs,
      activeTabId: tabs[Math.min(index, tabs.length - 1)]?.id,
    };
  }
  if (event.type === "host-terminal/activated") {
    return state.tabs.some((terminal) => terminal.id === event.terminalId)
      ? { ...state, activeTabId: event.terminalId }
      : state;
  }
  if (
    event.type === "host-terminal/data" ||
    event.type === "host-terminal/error"
  ) {
    return state;
  }

  let changed = false;
  const tabs = state.tabs.map((terminal): HostTerminalTab => {
    if (terminal.id !== event.terminalId) return terminal;
    changed = true;
    if (event.type === "host-terminal/cwd") {
      return { ...terminal, cwd: event.cwd };
    }
    if (event.type === "host-terminal/resized") {
      return { ...terminal, dimensions: event.dimensions };
    }
    return {
      ...terminal,
      status: "exited",
      ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
      ...(event.signal === undefined ? {} : { signal: event.signal }),
    };
  });
  return changed ? { ...state, tabs } : state;
}
