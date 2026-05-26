import type { ChatMessage, ContentBlock } from "../agent/webview/types";

export type TerminalActivityStatus =
  | "running"
  | "completed"
  | "warning"
  | "error";

export interface TerminalActivityEntry {
  id: string;
  toolCallId: string;
  sourceMessageId: string;
  kind: "execute_command" | "get_terminal_output";
  command?: string;
  cwd?: string;
  terminalId?: string;
  terminalName?: string;
  splitFrom?: string;
  background?: boolean;
  timeoutSeconds?: number;
  status: TerminalActivityStatus;
  exitCode?: number | null;
  output?: string;
  rawOutput?: string;
  durationMs?: number;
}

export interface TerminalBufferLine {
  id: string;
  kind: "command" | "output" | "status" | "cursor";
  text: string;
  prompt?: string;
  status?: TerminalActivityStatus;
}

export interface TerminalBufferChunk {
  id: string;
  kind: "raw";
  text: string;
  command?: string;
  prompt?: string;
  status?: TerminalActivityStatus;
}

export interface TerminalBuffer {
  id: string;
  label: string;
  terminalId?: string;
  cwd?: string;
  lines: TerminalBufferLine[];
  chunks?: TerminalBufferChunk[];
  lastStatus?: TerminalActivityStatus;
  lastUpdatedIndex: number;
}

export interface KnownTerminalInfo {
  id: string;
  name: string;
  busy?: boolean;
  stale?: boolean;
}

export interface DeriveTerminalBuffersOptions {
  workspaceName?: string;
  gitBranch?: string;
  dirty?: boolean;
  terminals?: KnownTerminalInfo[];
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function numericOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function deriveStatus(
  payload: Record<string, unknown> | null,
  complete: boolean,
): TerminalActivityStatus {
  if (!complete) return "running";
  if (!payload) return "completed";

  const exitCode = numericOrNull(payload.exit_code);
  if (typeof payload.error === "string" && payload.error.trim()) return "error";
  if (typeof exitCode === "number" && exitCode !== 0) return "warning";

  const status = typeof payload.status === "string" ? payload.status : "";
  if (["error", "failed"].includes(status)) return "error";
  if (
    [
      "timed_out",
      "cancelled",
      "rejected",
      "rejected_by_user",
      "force-completed",
      "stopped",
    ].includes(status)
  ) {
    return "warning";
  }

  return "completed";
}

function stringValue(
  payload: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = payload?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanValue(
  payload: Record<string, unknown> | null,
  key: string,
): boolean | undefined {
  const value = payload?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function basename(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const normalized = path.replace(/[/\\]+$/, "");
  const parts = normalized.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) ?? normalized;
}

function toEntry(
  message: ChatMessage,
  block: Extract<ContentBlock, { type: "tool_call" }>,
): TerminalActivityEntry | null {
  if (
    block.name !== "execute_command" &&
    block.name !== "get_terminal_output"
  ) {
    return null;
  }

  const input = parseJsonObject(block.inputJson);
  const result = parseJsonObject(block.result);
  const kind = block.name;

  if (kind === "execute_command") {
    return {
      id: `${message.id}:${block.id}`,
      toolCallId: block.id,
      sourceMessageId: message.id,
      kind,
      command: stringValue(input, "command"),
      cwd: stringValue(input, "cwd"),
      terminalId:
        stringValue(result, "terminal_id") ?? stringValue(input, "terminal_id"),
      terminalName:
        stringValue(result, "terminal_name") ??
        stringValue(input, "terminal_name"),
      splitFrom: stringValue(input, "split_from"),
      background: booleanValue(input, "background"),
      timeoutSeconds: numericOrNull(input?.timeout) ?? undefined,
      status: deriveStatus(result, block.complete),
      exitCode: result ? numericOrNull(result.exit_code) : undefined,
      output:
        result && typeof result.output === "string" ? result.output : undefined,
      rawOutput:
        result && typeof result.terminal_raw_output === "string"
          ? result.terminal_raw_output
          : undefined,
      durationMs: block.durationMs,
    };
  }

  return {
    id: `${message.id}:${block.id}`,
    toolCallId: block.id,
    sourceMessageId: message.id,
    kind,
    terminalId:
      stringValue(input, "terminal_id") ?? stringValue(result, "terminal_id"),
    terminalName:
      stringValue(input, "terminal_name") ??
      stringValue(result, "terminal_name"),
    status: deriveStatus(result, block.complete),
    exitCode: result ? numericOrNull(result.exit_code) : undefined,
    output:
      result && typeof result.output === "string" ? result.output : undefined,
    rawOutput:
      result && typeof result.terminal_raw_output === "string"
        ? result.terminal_raw_output
        : undefined,
    durationMs: block.durationMs,
  };
}

export function extractTerminalActivityEntries(
  messages: ChatMessage[],
): TerminalActivityEntry[] {
  const entries: TerminalActivityEntry[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.blocks) {
      if (block.type !== "tool_call") continue;
      const entry = toEntry(message, block);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

function shouldKeepEntryForKnownTerminals(
  entry: TerminalActivityEntry,
  terminals: KnownTerminalInfo[],
): boolean {
  if (terminals.length === 0) return true;
  if (entry.status === "running") return true;
  if (!entry.terminalId) return false;
  return terminals.some((terminal) => terminal.id === entry.terminalId);
}

function resolveTerminalForEntry(
  entry: TerminalActivityEntry,
  terminals: KnownTerminalInfo[],
): KnownTerminalInfo | undefined {
  if (entry.terminalId) {
    return terminals.find((terminal) => terminal.id === entry.terminalId);
  }

  if (entry.status !== "running") return undefined;
  const busyTerminals = terminals.filter(
    (terminal) => terminal.busy && !terminal.stale,
  );
  return busyTerminals.length === 1 ? busyTerminals[0] : undefined;
}

function terminalBufferId(
  entry: TerminalActivityEntry,
  terminal: KnownTerminalInfo | undefined,
): string {
  return terminal
    ? `terminal:${terminal.id}`
    : entry.terminalId
      ? `terminal:${entry.terminalId}`
      : "terminal:default";
}

function terminalBufferLabel(
  entry: TerminalActivityEntry,
  terminal: KnownTerminalInfo | undefined,
): string {
  return terminal?.name ?? entry.terminalName ?? "AgentLink";
}

function formatPrompt(
  cwd: string | undefined,
  options: DeriveTerminalBuffersOptions,
): string {
  const base = basename(cwd) ?? options.workspaceName?.trim() ?? "agentlink";
  const branch = options.gitBranch?.trim() || "main";
  return `➜  ${base} git:(${branch})${options.dirty === true ? " ✗" : ""}`;
}

function derivePrompt(
  entry: TerminalActivityEntry,
  options: DeriveTerminalBuffersOptions,
): string {
  return formatPrompt(entry.cwd, options);
}

function splitOutputLines(output: string): string[] {
  const lines = output.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length > 0 ? lines : [""];
}

function hasObviousFailureText(output: string | undefined): boolean {
  if (!output) return false;
  return /\b(error|failed|exit code|command failed)\b/i.test(output);
}

function entryChunkText(entry: TerminalActivityEntry): string {
  if (entry.rawOutput) return entry.rawOutput;
  const parts: string[] = [];
  if (entry.output) parts.push(entry.output);
  if (entry.status === "running") {
    parts.push("running…");
  } else if (
    (entry.status === "warning" || entry.status === "error") &&
    !hasObviousFailureText(entry.output)
  ) {
    parts.push(
      typeof entry.exitCode === "number"
        ? `exit code ${entry.exitCode}`
        : entry.status,
    );
  }
  return parts.join("\n");
}

function createIdleBuffer(
  options: DeriveTerminalBuffersOptions,
): TerminalBuffer {
  const prompt = formatPrompt(undefined, options);
  return {
    id: "terminal:default",
    label: "AgentLink",
    lines: [
      {
        id: "terminal:default:cursor",
        kind: "cursor",
        prompt,
        text: "",
        status: "completed",
      },
    ],
    lastStatus: "completed",
    lastUpdatedIndex: -1,
  };
}

export function deriveTerminalBuffers(
  messages: ChatMessage[],
  options: DeriveTerminalBuffersOptions = {},
): TerminalBuffer[] {
  const knownTerminals = options.terminals ?? [];
  const entries = extractTerminalActivityEntries(messages).filter(
    (entry) =>
      entry.kind === "execute_command" &&
      entry.background !== true &&
      shouldKeepEntryForKnownTerminals(entry, knownTerminals),
  );
  const buffers = new Map<string, TerminalBuffer>();

  entries.forEach((entry, entryIndex) => {
    const terminal = resolveTerminalForEntry(entry, knownTerminals);
    const id = terminalBufferId(entry, terminal);
    const existing = buffers.get(id);
    const buffer: TerminalBuffer = existing ?? {
      id,
      label: terminalBufferLabel(entry, terminal),
      terminalId: terminal?.id ?? entry.terminalId,
      cwd: entry.cwd,
      lines: [],
      lastUpdatedIndex: entryIndex,
    };

    if (
      entry.command ||
      entry.rawOutput ||
      entry.output ||
      entry.status === "running"
    ) {
      buffer.chunks = buffer.chunks ?? [];
      buffer.chunks.push({
        id: `${entry.id}:chunk`,
        kind: "raw",
        text: entryChunkText(entry),
        command: entry.command,
        prompt: derivePrompt(entry, options),
        status: entry.status,
      });
    }

    buffer.label = terminal?.name ?? entry.terminalName ?? buffer.label;
    buffer.cwd = entry.cwd ?? buffer.cwd;
    buffer.lastStatus = entry.status;
    buffer.lastUpdatedIndex = entryIndex;

    if (entry.command) {
      buffer.lines.push({
        id: `${entry.id}:command`,
        kind: "command",
        prompt: derivePrompt(entry, options),
        text: entry.command,
        status: entry.status,
      });
    }

    if (entry.output) {
      splitOutputLines(entry.output).forEach((line, lineIndex) => {
        buffer.lines.push({
          id: `${entry.id}:output:${lineIndex}`,
          kind: "output",
          text: line,
          status: entry.status,
        });
      });
    }

    if (entry.status === "running") {
      buffer.lines.push({
        id: `${entry.id}:status`,
        kind: "status",
        text: "running…",
        status: entry.status,
      });
    } else if (
      (entry.status === "warning" || entry.status === "error") &&
      !hasObviousFailureText(entry.output)
    ) {
      const exitText =
        typeof entry.exitCode === "number"
          ? `exit code ${entry.exitCode}`
          : entry.status;
      buffer.lines.push({
        id: `${entry.id}:status`,
        kind: "status",
        text: exitText,
        status: entry.status,
      });
    }

    buffers.set(id, buffer);
  });

  for (const terminal of knownTerminals) {
    const id = `terminal:${terminal.id}`;
    if (buffers.has(id)) continue;
    buffers.set(id, {
      id,
      label: terminal.name,
      terminalId: terminal.id,
      lines: [
        {
          id: `${id}:cursor`,
          kind: "cursor",
          prompt: formatPrompt(undefined, options),
          text: terminal.stale
            ? "# reload terminal environment before reuse"
            : "",
          status: terminal.stale
            ? "warning"
            : terminal.busy
              ? "running"
              : "completed",
        },
      ],
      lastStatus: terminal.stale
        ? "warning"
        : terminal.busy
          ? "running"
          : "completed",
      lastUpdatedIndex: entries.length,
    });
  }

  const result = [...buffers.values()].sort(
    (a, b) => a.lastUpdatedIndex - b.lastUpdatedIndex,
  );
  return result.length > 0 ? result : [createIdleBuffer(options)];
}
