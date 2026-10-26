/**
 * Golden tasks for the first-turn routing eval.
 *
 * Each task is a realistic user prompt against this repository. The eval sends
 * it to a live model with AgentLink's real system prompt and tool catalog, then
 * grades the tools the model reaches for in its first response. This measures
 * routing (right tool, right skill, no needless delegation), not end-to-end task
 * completion. Run each task more than once: routing regressions are often
 * intermittent.
 */

export interface GoldenTaskExpectation {
  /** At least one first-response tool call must be one of these tools. */
  anyOf?: readonly string[];
  /** Treat a plain-text reply with no tool call as a pass. */
  allowNoToolCall?: boolean;
  /** None of the first-response tool calls may use these tools. */
  forbid?: readonly string[];
  /** When this tool is called, its serialized input must match the pattern. */
  inputMatches?: { tool: string; pattern: RegExp };
  /** When this tool is called, its serialized input must not match the pattern. */
  forbidInputMatches?: { tool: string; pattern: RegExp };
}

export interface GoldenTask {
  id: string;
  mode: string;
  prompt: string;
  /** What the task checks, shown in the report. */
  intent: string;
  expect: GoldenTaskExpectation;
}

export interface ObservedToolCall {
  name: string;
  input: unknown;
}

export interface GoldenTaskGrade {
  pass: boolean;
  /** Effective tool names, with call_native_tool unwrapped to its target. */
  tools: string[];
  reasons: string[];
}

const NO_DELEGATION = ["spawn_background_agent"];
const FILE_EDIT_TOOLS = ["apply_diff", "write_file", "find_and_replace"];
/** Shell commands that write file contents (read-only git/grep checks are fine). */
const SHELL_FILE_WRITE = {
  tool: "execute_command",
  pattern: /\bsed\b|\bperl\b|\btee\b|\bawk\b.*>|[^2&]>>?\s*[\w./~]/,
};

export const GOLDEN_TASKS: readonly GoldenTask[] = [
  {
    id: "known-file-read",
    mode: "code",
    intent: "A named file is read directly, not searched for or delegated.",
    prompt: "What does src/shared/randomId.ts export?",
    expect: {
      anyOf: ["read_file"],
      forbid: [...NO_DELEGATION, "execute_command"],
    },
  },
  {
    id: "unknown-location-search",
    mode: "ask",
    intent: "An unknown location uses workspace search, not delegation.",
    prompt:
      "Where is the code that decides whether an MCP server's tools are deferred or shown directly?",
    expect: {
      anyOf: ["search_files", "get_repo_map"],
      forbid: NO_DELEGATION,
    },
  },
  {
    id: "exact-symbol-callers",
    mode: "ask",
    intent: "Exact-name lookups use regex search or references.",
    prompt: "Find every caller of partitionMcpToolsForDisclosure.",
    expect: {
      anyOf: ["search_files", "get_references", "find_native_tools"],
      forbid: [...NO_DELEGATION, "execute_command"],
    },
  },
  {
    id: "web-current-info",
    mode: "ask",
    intent: "Fresh external facts go to native web_search first.",
    prompt: "What changed in the most recent stable TypeScript release?",
    expect: {
      anyOf: ["web_search"],
      forbid: [...NO_DELEGATION, "execute_command"],
    },
  },
  {
    id: "web-known-url",
    mode: "ask",
    intent: "A given URL is opened with native web_fetch.",
    prompt: "Open https://example.com and tell me the page title.",
    expect: {
      anyOf: ["web_fetch"],
      forbid: [...NO_DELEGATION, "execute_command"],
    },
  },
  {
    id: "product-docs-skill",
    mode: "ask",
    intent: "AgentLink product questions load the bundled documentation skill.",
    prompt:
      "How do I make one MCP server's tools load only on demand in AgentLink?",
    expect: {
      anyOf: ["load_skill"],
      inputMatches: { tool: "load_skill", pattern: /documentation/ },
      forbid: NO_DELEGATION,
    },
  },
  {
    id: "focused-test-run",
    mode: "code",
    intent: "A requested test run goes straight to the terminal.",
    prompt: "Run the unit tests in src/shared/randomId.test.ts.",
    expect: {
      anyOf: ["execute_command"],
      forbid: NO_DELEGATION,
    },
  },
  {
    id: "rename-without-shell",
    mode: "code",
    intent: "A cross-file rename never edits files through the shell.",
    prompt:
      "Rename the exported function randomId to createRandomId everywhere in the project.",
    expect: {
      forbid: [...NO_DELEGATION, "write_file"],
      forbidInputMatches: SHELL_FILE_WRITE,
    },
  },
  {
    id: "ambiguous-ask-first",
    mode: "code",
    intent:
      "An underspecified change edits nothing first; read-only inspection or a question is fine.",
    prompt: "Make it faster.",
    expect: {
      allowNoToolCall: true,
      forbid: [...NO_DELEGATION, ...FILE_EDIT_TOOLS],
      forbidInputMatches: SHELL_FILE_WRITE,
    },
  },
  {
    id: "past-session-recall",
    mode: "code",
    intent:
      "Work the user says happened in another session is recalled from saved sessions before guessing from files.",
    prompt:
      "Use the same release checklist we worked out in another session last week to prepare this release.",
    expect: {
      anyOf: ["search_workspace_sessions"],
      forbid: NO_DELEGATION,
    },
  },
  {
    id: "deferred-mcp-resources",
    mode: "ask",
    intent: "A deferred native tool is discovered or called by exact name.",
    prompt: "List the resources my connected MCP servers expose.",
    expect: {
      anyOf: ["find_native_tools", "list_mcp_resources"],
      forbid: NO_DELEGATION,
    },
  },
];

function effectiveToolName(call: ObservedToolCall): string {
  if (call.name !== "call_native_tool") return call.name;
  const input = call.input as { name?: unknown } | null | undefined;
  return typeof input?.name === "string" ? input.name : call.name;
}

function effectiveInput(call: ObservedToolCall): unknown {
  if (call.name !== "call_native_tool") return call.input;
  return (call.input as { input?: unknown } | null | undefined)?.input;
}

export function gradeGoldenTask(
  task: GoldenTask,
  calls: readonly ObservedToolCall[],
): GoldenTaskGrade {
  const tools = calls.map(effectiveToolName);
  const reasons: string[] = [];
  const { anyOf, allowNoToolCall, forbid, inputMatches, forbidInputMatches } =
    task.expect;

  if (calls.length === 0) {
    if (!allowNoToolCall && anyOf?.length) {
      reasons.push(`no tool call; expected one of ${anyOf.join(", ")}`);
    }
  } else if (anyOf?.length && !tools.some((tool) => anyOf.includes(tool))) {
    reasons.push(
      `called ${tools.join(", ")}; expected one of ${anyOf.join(", ")}`,
    );
  }

  const forbidden = tools.filter((tool) => forbid?.includes(tool));
  if (forbidden.length > 0) {
    reasons.push(`called forbidden ${[...new Set(forbidden)].join(", ")}`);
  }

  if (inputMatches) {
    calls.forEach((call, index) => {
      if (tools[index] !== inputMatches.tool) return;
      const serialized = JSON.stringify(effectiveInput(call) ?? null);
      if (!inputMatches.pattern.test(serialized)) {
        reasons.push(
          `${inputMatches.tool} input ${serialized} does not match ${inputMatches.pattern}`,
        );
      }
    });
  }

  if (forbidInputMatches) {
    calls.forEach((call, index) => {
      if (tools[index] !== forbidInputMatches.tool) return;
      const serialized = JSON.stringify(effectiveInput(call) ?? null);
      if (forbidInputMatches.pattern.test(serialized)) {
        reasons.push(
          `${forbidInputMatches.tool} input ${serialized} matches forbidden ${forbidInputMatches.pattern}`,
        );
      }
    });
  }

  return { pass: reasons.length === 0, tools, reasons };
}
