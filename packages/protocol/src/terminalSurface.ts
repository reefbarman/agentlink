import type {
  HostTerminalState,
  HostTerminalTab,
  TerminalDimensions,
} from "./terminal.js";

export type ShellIntegrationMode = "raw" | "integrated";

/** `modes` is the DECSET/DECRST delta that crossed overall active state,
 * not the complete set of currently active alternate-screen modes. */
export type AlternateScreenTransition =
  | { type: "enter"; modes: readonly number[] }
  | { type: "exit"; modes: readonly number[] };

interface HostTerminalBlockOutput {
  readonly output: string;
  readonly outputBytes: number;
  readonly droppedOutputBytes: number;
}

export interface HostTerminalRawBlock extends HostTerminalBlockOutput {
  readonly id: string;
  readonly kind: "raw";
  readonly cwd: string;
}

export interface HostTerminalPromptBlock extends HostTerminalBlockOutput {
  readonly id: string;
  readonly kind: "prompt";
  readonly cwd: string;
  readonly status: "open" | "closed";
}

export interface HostTerminalCommandBlock extends HostTerminalBlockOutput {
  readonly id: string;
  readonly kind: "command";
  readonly cwd: string;
  readonly command: string;
  readonly status: "running" | "exited";
  readonly exitCode?: number;
}

export type HostTerminalBlock =
  | HostTerminalRawBlock
  | HostTerminalPromptBlock
  | HostTerminalCommandBlock;

export interface HostTerminalBlockState {
  readonly blocks: readonly HostTerminalBlock[];
  readonly currentCwd: string;
  readonly mode: ShellIntegrationMode;
  readonly activePromptBlockId?: string;
  readonly activeCommandBlockId?: string;
  readonly droppedBlocks: number;
  readonly nextBlockNumber: number;
  readonly maxBlockOutputBytes: number;
  readonly maxBlocks: number;
}

export type TerminalOutputPolicyAction = "allow" | "suppress";

export type TerminalOutputPolicyReason =
  | "terminal-control"
  | "clipboard"
  | "notification"
  | "proprietary-host-integration"
  | "private-shell-integration"
  | "incomplete"
  | "oversized";

export interface TerminalOutputPolicyDecision {
  readonly type: "osc";
  readonly command: number | null;
  readonly recommendedAction: TerminalOutputPolicyAction;
  readonly reason: TerminalOutputPolicyReason;
}

export const TERMINAL_SURFACE_PROTOCOL_VERSION = 2;
export const MAX_TERMINAL_IDENTIFIER_BYTES = 256;
export const MAX_TERMINAL_CWD_BYTES = 16 * 1024;
export const MAX_TERMINAL_INPUT_BYTES = 64 * 1024;
export const MAX_TERMINAL_LINK_BYTES = 8 * 1024;
export const MAX_TERMINAL_DIMENSION = 1_000;
export const MAX_TERMINAL_PASTE_BYTES = 64 * 1024;
export const MAX_TERMINAL_TASK_LABEL_BYTES = 200;
export const MAX_TERMINAL_TASK_COMMAND_BYTES = 64 * 1024 - 1;
export const MAX_TERMINAL_TASK_MESSAGE_BYTES = 2 * 1024;

export interface HostTerminalTaskMenuItem {
  id: string;
  label: string;
  command: string;
}

export type HostTerminalTasksStatus =
  | "ok"
  | "missing"
  | "invalid"
  | "unavailable";

export type HostTerminalTaskRunStatus =
  | "started"
  | "stale"
  | "unavailable"
  | "failed";

export type HostTerminalSurfaceAction =
  | "copy-command"
  | "copy-output"
  | "copy-command-and-output"
  | "rerun-command"
  | "interrupt-command";

interface TerminalTarget {
  terminalId: string;
  terminalInstanceId: string;
  rendererEpoch: string;
}

export type TerminalSurfaceRequest =
  | {
      type: "terminal-view/ready";
      protocolVersion: typeof TERMINAL_SURFACE_PROTOCOL_VERSION;
    }
  | {
      type: "host-terminal/create";
      requestId: string;
      cwd?: string;
      profileName?: string;
    }
  | { type: "terminal-view/resync"; rendererEpoch: string }
  | { type: "terminal-view/focus-changed"; focused: boolean }
  | (TerminalTarget & {
      type: "host-terminal/write";
      data: string;
    })
  | (TerminalTarget & {
      type: "host-terminal/resize";
      dimensions: TerminalDimensions;
    })
  | (TerminalTarget & { type: "host-terminal/activate" })
  | (TerminalTarget & { type: "host-terminal/close-intent" })
  | (TerminalTarget & {
      type: "host-terminal/paste-intent";
      bracketedPasteMode?: boolean;
    })
  | (TerminalTarget & {
      type: "terminal-view/confirm";
      confirmationId: string;
      accept: boolean;
      bracketedPasteMode?: boolean;
    })
  | (TerminalTarget & {
      type: "terminal-view/output-ack";
      sequence: number;
    })
  | (TerminalTarget & {
      type: "terminal-view/action";
      blockId: string;
      action: HostTerminalSurfaceAction;
    })
  | { type: "terminal-view/open-link"; rendererEpoch: string; url: string }
  | { type: "terminal-view/open-native-fallback"; rendererEpoch: string }
  | { type: "terminal-view/list-tasks"; requestId: string }
  | {
      type: "terminal-view/run-task";
      requestId: string;
      revision: string;
      taskId: string;
    }
  | { type: "terminal-view/open-tasks-file"; requestId: string };

export type HostTerminalBlockBoundary =
  | "prompt-start"
  | "prompt-end"
  | "command-start"
  | "command-end";

export interface HostTerminalSurfaceCommandSummary {
  /** First line of the command, bounded for display surfaces. */
  commandLine: string;
  /** True when the command has more lines or characters than commandLine. */
  truncated: boolean;
  status: "running" | "exited";
  exitCode?: number;
}

export interface HostTerminalSurfaceBlockPresentation {
  blockId: string;
  decoration: "hidden" | "undecorated" | "active" | "completed";
  actions: readonly HostTerminalSurfaceAction[];
  command?: HostTerminalSurfaceCommandSummary;
}

export interface HostTerminalSurfacePresentation {
  alternateScreen: boolean;
  terminalRunning: boolean;
  blocks: readonly HostTerminalSurfaceBlockPresentation[];
}

export type HostTerminalRenderOperation =
  | { type: "write"; data: string }
  | {
      type: "block-boundary";
      boundary: HostTerminalBlockBoundary;
      blockId: string;
    }
  | { type: "alternate-screen"; transition: AlternateScreenTransition }
  | {
      type: "presentation";
      alternateScreen: boolean;
      blocks: readonly HostTerminalSurfaceBlockPresentation[];
    };

export type HostTerminalSurfaceLifecycleEvent =
  | {
      type: "host-terminal/opened";
      terminalInstanceId: string;
      terminal: HostTerminalTab;
      activate?: boolean;
    }
  | {
      type: "host-terminal/data";
      terminalId: string;
      terminalInstanceId: string;
      data: string;
    }
  | {
      type: "host-terminal/cwd";
      terminalId: string;
      terminalInstanceId: string;
      cwd: string;
    }
  | {
      type: "host-terminal/resized";
      terminalId: string;
      terminalInstanceId: string;
      dimensions: TerminalDimensions;
    }
  | {
      type: "host-terminal/activated";
      terminalId: string;
      terminalInstanceId: string;
    }
  | {
      type: "host-terminal/agent-activity";
      terminalId: string;
      terminalInstanceId: string;
      activity: "running" | "unread" | "none";
    }
  | {
      type: "host-terminal/exited";
      terminalId: string;
      terminalInstanceId: string;
      exitCode?: number;
      signal?: number;
    }
  | {
      type: "host-terminal/closed";
      terminalId: string;
      terminalInstanceId: string;
    }
  | {
      type: "host-terminal/error";
      requestId?: string;
      terminalId?: string;
      terminalInstanceId?: string;
      message: string;
    };

export interface HostTerminalRenderBatch {
  type: "terminal-view/render-batch";
  terminalId: string;
  terminalInstanceId: string;
  sequence: number;
  operations: readonly HostTerminalRenderOperation[];
  droppedRenderBytes: number;
  replayTruncated: boolean;
  replayPendingControl: boolean;
  suppressedOutputCharacters: number;
  outputPolicyDecisions: readonly TerminalOutputPolicyDecision[];
}

/** Position of a retained block's first line inside replay `data`, in UTF-16
 * code units. Lets the renderer re-register block markers after a replay. */
export interface HostTerminalReplayAnchor {
  blockId: string;
  offset: number;
}

export interface HostTerminalReplaySnapshot {
  terminalId: string;
  terminalInstanceId: string;
  sequence: number;
  data: string;
  byteLength: number;
  droppedBytes: number;
  replayTruncated: boolean;
  replayPendingControl: boolean;
  blocks: HostTerminalBlockState;
  presentation: HostTerminalSurfacePresentation;
  anchors: readonly HostTerminalReplayAnchor[];
}

export interface HostTerminalFallbackState {
  reason:
    | "host-unsupported"
    | "native-shell-required"
    | "shell-unsupported"
    | "terminal-configuration-unsafe"
    | "workspace-untrusted"
    | "unsupported-bash-arguments"
    | "unsupported-zsh-arguments";
  message: string;
  profileName?: string;
  executable?: string;
}

export interface TerminalSurfaceConfiguration {
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  letterSpacing?: number;
  cursorStyle?: "block" | "line" | "underline";
  cursorBlink?: boolean;
  screenReaderMode?: boolean;
  multiLinePasteWarning?: "auto" | "always" | "never";
  scrollback: number;
}

export type TerminalSurfaceEvent =
  | HostTerminalSurfaceLifecycleEvent
  | {
      type: "terminal-view/bootstrap";
      protocolVersion: typeof TERMINAL_SURFACE_PROTOCOL_VERSION;
      rendererEpoch: string;
      state: HostTerminalState;
      configuration: TerminalSurfaceConfiguration;
      replay: readonly HostTerminalReplaySnapshot[];
      fallback?: HostTerminalFallbackState;
    }
  | HostTerminalRenderBatch
  | {
      type: "terminal-view/confirmation";
      confirmationId: string;
      terminalId: string;
      terminalInstanceId: string;
      operation: "close" | "paste";
      title: string;
      message: string;
      confirmLabel: string;
    }
  | { type: "terminal-view/confirmation-cancelled"; confirmationId: string }
  | {
      type: "terminal-view/config";
      configuration: TerminalSurfaceConfiguration;
    }
  | { type: "terminal-view/resync-required"; rendererEpoch: string }
  | { type: "terminal-view/fallback"; fallback: HostTerminalFallbackState }
  | {
      type: "terminal-view/tasks";
      requestId: string;
      status: HostTerminalTasksStatus;
      revision?: string;
      tasks: readonly HostTerminalTaskMenuItem[];
      errorSummary?: string;
    }
  | {
      type: "terminal-view/task-run-result";
      requestId: string;
      status: HostTerminalTaskRunStatus;
      terminalId?: string;
      message?: string;
    };

const textEncoder = new TextEncoder();

const SURFACE_ACTIONS = new Set<HostTerminalSurfaceAction>([
  "copy-command",
  "copy-output",
  "copy-command-and-output",
  "rerun-command",
  "interrupt-command",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key)) &&
    optional.every(
      (key) => !Object.hasOwn(value, key) || value[key] !== undefined,
    )
  );
}

function isBoundedString(
  value: unknown,
  maxBytes: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    !value.includes("\0") &&
    textEncoder.encode(value).byteLength <= maxBytes
  );
}

function isIdentifier(value: unknown): value is string {
  return isBoundedString(value, MAX_TERMINAL_IDENTIFIER_BYTES);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isDimensions(value: unknown): value is TerminalDimensions {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["columns", "rows"]) &&
    isPositiveSafeInteger(value.columns) &&
    value.columns <= MAX_TERMINAL_DIMENSION &&
    isPositiveSafeInteger(value.rows) &&
    value.rows <= MAX_TERMINAL_DIMENSION
  );
}

function hasValidTarget(value: Record<string, unknown>): boolean {
  return (
    isIdentifier(value.terminalId) &&
    isIdentifier(value.terminalInstanceId) &&
    isIdentifier(value.rendererEpoch)
  );
}

export function isTerminalSurfaceRequest(
  value: unknown,
): value is TerminalSurfaceRequest {
  if (!isRecord(value) || typeof value.type !== "string") return false;

  if (value.type === "terminal-view/ready") {
    return (
      hasExactKeys(value, ["type", "protocolVersion"]) &&
      value.protocolVersion === TERMINAL_SURFACE_PROTOCOL_VERSION
    );
  }

  if (value.type === "host-terminal/create") {
    return (
      hasExactKeys(value, ["type", "requestId"], ["cwd", "profileName"]) &&
      isIdentifier(value.requestId) &&
      (!Object.hasOwn(value, "cwd") ||
        isBoundedString(value.cwd, MAX_TERMINAL_CWD_BYTES)) &&
      (!Object.hasOwn(value, "profileName") || isIdentifier(value.profileName))
    );
  }

  if (
    value.type === "terminal-view/list-tasks" ||
    value.type === "terminal-view/open-tasks-file"
  ) {
    return (
      hasExactKeys(value, ["type", "requestId"]) &&
      isIdentifier(value.requestId)
    );
  }

  if (value.type === "terminal-view/run-task") {
    return (
      hasExactKeys(value, ["type", "requestId", "revision", "taskId"]) &&
      isIdentifier(value.requestId) &&
      isIdentifier(value.revision) &&
      isIdentifier(value.taskId)
    );
  }

  if (value.type === "terminal-view/resync") {
    return (
      hasExactKeys(value, ["type", "rendererEpoch"]) &&
      isIdentifier(value.rendererEpoch)
    );
  }
  if (value.type === "terminal-view/focus-changed") {
    return (
      hasExactKeys(value, ["type", "focused"]) &&
      typeof value.focused === "boolean"
    );
  }

  const targetKeys = [
    "type",
    "terminalId",
    "terminalInstanceId",
    "rendererEpoch",
  ] as const;

  if (value.type === "host-terminal/write") {
    return (
      hasExactKeys(value, [...targetKeys, "data"]) &&
      hasValidTarget(value) &&
      isBoundedString(value.data, MAX_TERMINAL_INPUT_BYTES)
    );
  }

  if (value.type === "host-terminal/resize") {
    return (
      hasExactKeys(value, [...targetKeys, "dimensions"]) &&
      hasValidTarget(value) &&
      isDimensions(value.dimensions)
    );
  }

  if (
    value.type === "host-terminal/activate" ||
    value.type === "host-terminal/close-intent"
  ) {
    return hasExactKeys(value, targetKeys) && hasValidTarget(value);
  }

  if (value.type === "host-terminal/paste-intent") {
    return (
      hasExactKeys(value, targetKeys, ["bracketedPasteMode"]) &&
      hasValidTarget(value) &&
      (!Object.hasOwn(value, "bracketedPasteMode") ||
        typeof value.bracketedPasteMode === "boolean")
    );
  }

  if (value.type === "terminal-view/confirm") {
    return (
      hasExactKeys(
        value,
        [...targetKeys, "confirmationId", "accept"],
        ["bracketedPasteMode"],
      ) &&
      hasValidTarget(value) &&
      isIdentifier(value.confirmationId) &&
      typeof value.accept === "boolean" &&
      (!Object.hasOwn(value, "bracketedPasteMode") ||
        typeof value.bracketedPasteMode === "boolean")
    );
  }

  if (value.type === "terminal-view/output-ack") {
    return (
      hasExactKeys(value, [...targetKeys, "sequence"]) &&
      hasValidTarget(value) &&
      isPositiveSafeInteger(value.sequence)
    );
  }

  if (value.type === "terminal-view/action") {
    return (
      hasExactKeys(value, [...targetKeys, "blockId", "action"]) &&
      hasValidTarget(value) &&
      isIdentifier(value.blockId) &&
      typeof value.action === "string" &&
      SURFACE_ACTIONS.has(value.action as HostTerminalSurfaceAction)
    );
  }

  if (value.type === "terminal-view/open-link") {
    return (
      hasExactKeys(value, ["type", "rendererEpoch", "url"]) &&
      isIdentifier(value.rendererEpoch) &&
      isBoundedString(value.url, MAX_TERMINAL_LINK_BYTES)
    );
  }

  if (value.type === "terminal-view/open-native-fallback") {
    return (
      hasExactKeys(value, ["type", "rendererEpoch"]) &&
      isIdentifier(value.rendererEpoch)
    );
  }

  return false;
}
