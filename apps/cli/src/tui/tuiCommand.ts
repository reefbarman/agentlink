import type {
  StandaloneBackgroundAgentProjection,
  StandaloneCommandObservation,
  StandaloneCommandProjection,
  StandaloneSessionSummary,
} from "../sessionProjection.js";

export type TuiCommand =
  | { readonly type: "agents" }
  | { readonly type: "agent-stop"; readonly childSessionId: string }
  | {
      readonly type: "agent-steer";
      readonly childSessionId: string;
      readonly message: string;
    }
  | { readonly type: "approvals" }
  | { readonly type: "condense" }
  | {
      readonly type: "condense-threshold";
      /** A fraction of usable input, null to reset, undefined to show. */
      readonly threshold: number | null | undefined;
    }
  | { readonly type: "exit" }
  | { readonly type: "help" }
  | { readonly type: "mcp" }
  | { readonly type: "model" }
  | { readonly type: "reasoning" }
  | { readonly type: "mode" }
  | { readonly type: "new" }
  | { readonly type: "output"; readonly commandId: string }
  | { readonly type: "processes" }
  | { readonly type: "session-select"; readonly sessionId: string }
  | { readonly type: "sessions" }
  | { readonly type: "stop"; readonly commandId: string };

export function parseTuiCommand(input: string): TuiCommand | undefined {
  if (!input.startsWith("/")) return undefined;
  const [name, ...args] = input.trim().split(/\s+/u);
  switch (name) {
    case "/exit":
    case "/quit":
      return { type: "exit" };
    case "/help":
      return { type: "help" };
    case "/new":
      return { type: "new" };
    case "/model":
      return { type: "model" };
    case "/reasoning":
    case "/thinking":
      return { type: "reasoning" };
    case "/mode":
      return { type: "mode" };
    case "/mcp":
      return { type: "mcp" };
    case "/condense":
      return parseCondenseCommand(args);
    case "/sessions":
      return args[0]
        ? { type: "session-select", sessionId: args[0] }
        : { type: "sessions" };
    case "/processes":
      return { type: "processes" };
    case "/output":
      if (!args[0]) throw new Error("/output requires a command ID");
      return { type: "output", commandId: args[0] };
    case "/stop":
      if (!args[0]) throw new Error("/stop requires a command ID");
      return { type: "stop", commandId: args[0] };
    case "/agents":
      return { type: "agents" };
    case "/approvals":
      return { type: "approvals" };
    case "/agent-stop":
      if (!args[0]) throw new Error("/agent-stop requires a child ID");
      return { type: "agent-stop", childSessionId: args[0] };
    case "/agent-steer": {
      const [childSessionId, ...messageParts] = args;
      const message = messageParts.join(" ");
      if (!childSessionId || !message) {
        throw new Error("/agent-steer requires a child ID and message");
      }
      return { type: "agent-steer", childSessionId, message };
    }
    default:
      throw new Error(
        `Unknown command: ${name}. Type /help for valid commands.`,
      );
  }
}

function parseCondenseCommand(args: readonly string[]): TuiCommand {
  if (args.length === 0) return { type: "condense" };
  const [subcommand, value, ...rest] = args;
  if (subcommand !== "threshold" || rest.length > 0) {
    throw new Error("Usage: /condense, or /condense threshold [0.1-1|default]");
  }
  if (value === undefined)
    return { type: "condense-threshold", threshold: undefined };
  if (value === "default" || value === "reset") {
    return { type: "condense-threshold", threshold: null };
  }
  const percent = value.endsWith("%");
  const parsed = Number(percent ? value.slice(0, -1) : value);
  const threshold = percent ? parsed / 100 : parsed;
  if (!Number.isFinite(threshold) || threshold < 0.1 || threshold > 1) {
    throw new Error(
      "The condense threshold is a fraction of the model's usable input from 0.1 to 1 (or 10% to 100%), or default",
    );
  }
  return { type: "condense-threshold", threshold };
}

export function renderTuiHelp(): string {
  return [
    "Commands: /new, /sessions, /model, /reasoning, /mode, /mcp, /condense, /condense threshold [0.1-1|default], /processes, /output ID,",
    "/stop ID, /agents, /approvals, /agent-steer ID MESSAGE, /agent-stop ID, /exit",
    "Keys: Enter send, Ctrl+J newline, Tab focus, Ctrl+O controls, Ctrl+T TODOs, Ctrl+N continue action, Ctrl+Z suspend; transcript Page Up/Down/Home/End and Enter tool details; activity Up/Down/Home/End and Enter/Space details; Ctrl+C cancel/exit",
    "Composer: type / for commands and @ for project file attachments; pasting a project file path also attaches it.",
  ].join("\n");
}

export function renderSessions(
  records: readonly StandaloneSessionSummary[],
): string {
  if (records.length === 0) return "No saved sessions for this project.";
  return records
    .map(
      (record) =>
        `${record.sessionId}\t${record.state}\t${record.model ? `${record.model.providerId}/${record.model.modelId}` : "default"}`,
    )
    .join("\n");
}

export function renderProcesses(
  records: readonly StandaloneCommandProjection[],
): string {
  if (records.length === 0) return "No retained commands for this session.";
  return records
    .map(
      (record) =>
        `${record.commandId}\t${record.state}\t${record.mode}\t${record.command}`,
    )
    .join("\n");
}

export function renderCommandOutput(
  observation: StandaloneCommandObservation,
): string {
  const header = `${observation.record.commandId}\t${observation.record.state}${observation.truncatedBeforeOffset ? "\t(output truncated)" : ""}`;
  return [header, ...observation.output.map((chunk) => chunk.text)].join("\n");
}

export function renderBackgroundAgents(
  records: readonly StandaloneBackgroundAgentProjection[],
): string {
  if (records.length === 0) return "No background agents for this session.";
  return records
    .map(
      (record) =>
        `${record.childSessionId}\t${record.lifecycle}\t${record.phase}\t${record.task}`,
    )
    .join("\n");
}
