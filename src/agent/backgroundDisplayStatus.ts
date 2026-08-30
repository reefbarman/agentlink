import type { BgSessionInfo } from "@agentlink/protocol/background-result";

type BackgroundStatus = BgSessionInfo["status"];

export interface BackgroundDisplayStatusInput {
  status: BackgroundStatus;
  currentTool?: string;
  streamingText?: string;
  resultText?: string;
  errorMessage?: string;
  statusDetail?: string;
}

export interface BackgroundStatusSummary {
  shortStatus?: string;
  generatedAt?: number;
  inFlight: boolean;
}

export interface PickBackgroundDisplayStatusInput {
  status: BackgroundStatus;
  heuristicStatus: string;
  summary: BackgroundStatusSummary;
  now?: number;
}

export interface PickedBackgroundDisplayStatus {
  displayStatus: string;
  displayStatusSource: "terminal" | "model" | "heuristic";
}

export function normalizeBackgroundStatusPhrase(status: string): string {
  const raw = status.trim();
  if (!raw) return "";

  const normalized = raw
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const directMap: Record<string, string> = {
    "streaming active": "Thinking…",
    streaming: "Thinking…",
    "streaming thinking": "Thinking…",
    "streaming file analysis": "Reviewing code",
    "streaming file list": "Scanning files",
    "file analysis": "Reviewing code",
    "file list": "Scanning files",
    analysis: "Reviewing code",
    reviewing: "Reviewing code",
    "tool call": "Running tool",
    "tool calls": "Running tools",
    "tool execution": "Running tool",
    executing: "Running tool",
    done: "Done",
    complete: "Done",
    completed: "Done",
    finished: "Done",
    cancel: "Cancelled",
    cancelled: "Cancelled",
    canceled: "Cancelled",
    error: "Error",
    failed: "Error",
    waiting: "Awaiting input",
    "awaiting approval": "Awaiting approval",
    approval: "Awaiting approval",
  };

  if (directMap[normalized]) return directMap[normalized];

  if (normalized.startsWith("streaming ")) {
    const rest = normalized.replace(/^streaming\s+/, "");
    if (rest.includes("file") && rest.includes("analysis")) {
      return "Reviewing code";
    }
    if (rest.includes("file") && rest.includes("list")) {
      return "Scanning files";
    }
    if (rest.includes("tool")) {
      return "Running tool";
    }
    if (
      rest.includes("search") ||
      rest.includes("inspect") ||
      rest.includes("analy")
    ) {
      return "Reviewing code";
    }
    return "Thinking…";
  }

  return normalized
    .split(" ")
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

export function inferBackgroundDisplayStatus(
  args: BackgroundDisplayStatusInput,
): string {
  const tool = (args.currentTool ?? "").toLowerCase();
  const textWindow = [args.streamingText, args.resultText]
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
    .join("\n")
    .toLowerCase()
    .slice(-700);

  if (args.status === "queued") return "Queued";
  if (args.status === "awaiting_approval") return "Awaiting approval";
  if (args.status === "idle") return "Done";
  if (args.status === "cancelled") return "Cancelled";
  if (args.status === "error") return "Error";

  if (args.statusDetail?.trim()) {
    return args.statusDetail;
  }

  const isTestCommand =
    tool.includes("execute_command") &&
    /(\bnpm\s+test\b|\bpnpm\s+test\b|\byarn\s+test\b|\bvitest\b|\bjest\b|\blint\b|\btsc\b|\bbuild\b)/i.test(
      textWindow,
    );

  if (
    tool.includes("read_file") ||
    tool.includes("search_files") ||
    tool.includes("codebase_search") ||
    tool.includes("list_files") ||
    tool.includes("get_symbols") ||
    tool.includes("get_references") ||
    tool.includes("go_to_definition") ||
    tool.includes("go_to_implementation") ||
    tool.includes("get_type_hierarchy") ||
    tool.includes("get_hover") ||
    tool.includes("get_completions")
  ) {
    if (
      /\bi found\b|\bfound the issue\b|\broot cause\b|\bproblem is\b/.test(
        textWindow,
      )
    ) {
      return "Issue found";
    }
    if (/\binspect\b|\binvestigat\w*\b|\banaly\w*\b/.test(textWindow)) {
      return "Inspecting code";
    }
    return "Reading code";
  }

  if (
    tool.includes("apply_diff") ||
    tool.includes("write_file") ||
    tool.includes("find_and_replace") ||
    tool.includes("rename_symbol") ||
    tool.includes("apply_code_action")
  ) {
    if (/\bapplied patch\b|\bupdated\b|\bpatched\b/.test(textWindow)) {
      return "Patch applied";
    }
    return "Editing code";
  }

  if (tool.includes("execute_command")) {
    if (
      /\bre-ran tests\b|\ball tests pass\b|\btests pass\b|\bverified\b/.test(
        textWindow,
      )
    ) {
      return "Verifying fix";
    }
    return isTestCommand ? "Running tests" : "Running command";
  }

  if (tool.includes("ask_user")) return "Waiting input";

  if (args.status === "tool_executing") {
    if (/\bre-ran tests\b|\brerun\b|\btest\b/.test(textWindow)) {
      return "Running tests";
    }
    if (/\bapplied patch\b|\bupdating\b|\bpatching\b/.test(textWindow)) {
      return "Updating code";
    }
    if (/\bi found\b|\bfound the issue\b|\broot cause\b/.test(textWindow)) {
      return "Issue found";
    }
    return "Running…";
  }

  if (/\bneed confirmation\b|\bwaiting for\b|\bblocked on\b/.test(textWindow)) {
    return "Awaiting input";
  }
  if (/\bnext i('|’)ll\b|\bi('|’)m going to\b|\binspect\b/.test(textWindow)) {
    return "Inspecting code";
  }
  if (/\bi found\b|\bfound the issue\b|\broot cause\b/.test(textWindow)) {
    return "Issue found";
  }

  return "Thinking…";
}

export function pickBackgroundDisplayStatus(
  args: PickBackgroundDisplayStatusInput,
): PickedBackgroundDisplayStatus {
  if (args.status === "idle") {
    return { displayStatus: "Done", displayStatusSource: "terminal" };
  }
  if (args.status === "error") {
    return { displayStatus: "Error", displayStatusSource: "terminal" };
  }
  if (args.status === "cancelled") {
    return { displayStatus: "Cancelled", displayStatusSource: "terminal" };
  }

  if (args.summary.shortStatus && args.summary.generatedAt) {
    const ageMs = (args.now ?? Date.now()) - args.summary.generatedAt;
    if (ageMs <= 60_000) {
      const normalizedModelStatus = normalizeBackgroundStatusPhrase(
        args.summary.shortStatus,
      );
      const normalized = normalizedModelStatus.toLowerCase();
      const looksTerminal =
        normalized === "done" ||
        normalized === "cancelled" ||
        normalized === "error";
      const prefersHeuristicWhileToolActive =
        normalized === "thinking…" && args.heuristicStatus !== "Thinking…";

      if (
        !looksTerminal &&
        normalizedModelStatus &&
        !prefersHeuristicWhileToolActive
      ) {
        return {
          displayStatus: normalizedModelStatus,
          displayStatusSource: "model",
        };
      }
    }
  }

  return {
    displayStatus: args.heuristicStatus,
    displayStatusSource: "heuristic",
  };
}
