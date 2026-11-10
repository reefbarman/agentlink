import type { BgSessionInfo } from "@agentlink/protocol/background-result";

type BackgroundStatus = BgSessionInfo["status"];

export interface BackgroundDisplayStatusInput {
  status: BackgroundStatus;
  currentTool?: string;
  /** Bounded redacted input summary, e.g. `command=npm test` for execute_command. */
  currentToolInput?: string;
  /** A tool of this agent is waiting on an approval or human answer. */
  awaitingApproval?: boolean;
  streamingText?: string;
  resultText?: string;
  errorMessage?: string;
  statusDetail?: string;
}

// Status labels are hints, so prefer a neutral label over inventing a finding.
function hasAffirmativeFinding(text: string): boolean {
  return text.split(/[.!?;\n]|\bbut\b|\bhowever\b/).some((clause) => {
    if (/\b(?:no|not|never|without|cannot|unable|\w+n['’]t)\b/.test(clause)) {
      return false;
    }
    return /\b(?:i found|found|identified|confirmed)\s+(?:(?:the|a|an)\s+)?(?:(?:material|actual|likely)\s+)?(?:issue|bug|defect|problem|root cause)\b|\b(?:the )?root cause is\b|\bthe problem is\b/.test(
      clause,
    );
  });
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
  if (args.status === "awaiting_approval" || args.awaitingApproval) {
    return "Awaiting approval";
  }
  if (args.status === "idle") return "Done";
  if (args.status === "cancelled") return "Cancelled";
  if (args.status === "error") return "Error";

  const statusDetail = args.statusDetail?.trim();
  if (statusDetail) {
    return statusDetail.length > 80
      ? `${statusDetail.slice(0, 79).trimEnd()}…`
      : statusDetail;
  }

  // Prefer the running command itself; narration can be stale or mention
  // tests the agent has not started yet.
  const commandEvidence = args.currentToolInput?.includes("command=")
    ? args.currentToolInput
    : textWindow;
  const isTestCommand =
    tool.includes("execute_command") &&
    /(\bnpm\s+(?:run\s+)?test\b|\bpnpm\s+(?:run\s+)?test\b|\byarn\s+test\b|\bvitest\b|\bjest\b|\blint\b|\btsc\b|\bbuild\b)/i.test(
      commandEvidence,
    );

  if (
    tool.includes("read_file") ||
    tool.includes("search_files") ||
    tool.includes("list_files") ||
    tool.includes("get_symbols") ||
    tool.includes("get_references") ||
    tool.includes("go_to_definition") ||
    tool.includes("go_to_implementation") ||
    tool.includes("get_type_hierarchy") ||
    tool.includes("get_hover") ||
    tool.includes("get_completions")
  ) {
    if (hasAffirmativeFinding(textWindow)) {
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
    // A named tool is better evidence than narration, which may describe
    // plans (for example "smoke-test") that have not started.
    if (args.currentTool?.trim()) {
      const name = args.currentTool.trim();
      return `Running ${name.length > 60 ? `${name.slice(0, 59)}…` : name}`;
    }
    if (/\bapplied patch\b|\bupdating\b|\bpatching\b/.test(textWindow)) {
      return "Updating code";
    }
    if (hasAffirmativeFinding(textWindow)) {
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
  if (hasAffirmativeFinding(textWindow)) {
    return "Issue found";
  }

  return "Thinking…";
}
