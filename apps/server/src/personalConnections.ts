import { describeArgumentRules, nameWords } from "./mcpToolGuard.js";

import type { McpServerRecord } from "./mcpRegistry.js";

/**
 * Which of the owner's MCP tools read their calendar or email, for the
 * briefing's calendar and email sections. A briefing runs unattended, so
 * only tools on **Run** are used; read tools that still ask, or a server
 * that is signed out or failing, become one status line instead.
 *
 * A tool counts when its name reads (get, list, search, …), it is not on
 * the always-ask list, and it is about the area: by its own name
 * (`calendar`, `gmail`, `inbox`, …), or by `events`/`messages` on a server
 * whose name says calendar or mail (so a chat app's `search_messages` is
 * not taken for email).
 */

export type PersonalArea = "calendar" | "email";

export interface PersonalReadTool {
  readonly server: string;
  readonly serverLabel: string;
  readonly tool: string;
  /** The owner's Run rule, in words, when Run is limited. */
  readonly rule?: string;
}

export type PersonalConnection =
  | { readonly state: "ready"; readonly tools: readonly PersonalReadTool[] }
  /** Connected, but every read tool asks first. */
  | { readonly state: "asks"; readonly tools: readonly PersonalReadTool[] }
  /** The only matching servers are signed out or failing. */
  | { readonly state: "needs_attention"; readonly serverLabel: string }
  | { readonly state: "not_connected" };

const READ_WORDS = new Set([
  "get",
  "list",
  "search",
  "read",
  "find",
  "query",
  "fetch",
  "show",
  "view",
]);
const AREA_WORDS: Record<PersonalArea, ReadonlySet<string>> = {
  calendar: new Set(["calendar", "calendars", "agenda", "freebusy", "gcal"]),
  email: new Set(["mail", "email", "emails", "gmail", "inbox", "mailbox"]),
};
/** Words that need a calendar or mail server to count. */
const ITEM_WORDS: Record<PersonalArea, ReadonlySet<string>> = {
  calendar: new Set(["event", "events"]),
  email: new Set(["message", "messages", "thread", "threads"]),
};
const SERVER_WORDS: Record<PersonalArea, ReadonlySet<string>> = {
  calendar: new Set([
    ...AREA_WORDS.calendar,
    "google",
    "workspace",
    "outlook",
    "microsoft",
    "fastmail",
    "proton",
    "icloud",
  ]),
  email: new Set([
    ...AREA_WORDS.email,
    "google",
    "workspace",
    "outlook",
    "microsoft",
    "fastmail",
    "proton",
    "icloud",
  ]),
};

const MAX_TOOLS = 6;

export function personalConnection(
  servers: readonly McpServerRecord[],
  area: PersonalArea,
  runRefusal: (serverId: string, tool: string) => string | undefined,
): PersonalConnection {
  const ready: PersonalReadTool[] = [];
  const asking: PersonalReadTool[] = [];
  let attention: string | undefined;
  for (const server of servers) {
    if (!server.enabled) continue;
    const serverWords = new Set([
      ...nameWords(server.id),
      ...nameWords(server.label),
    ]);
    const onAreaServer = [...serverWords].some((word) =>
      SERVER_WORDS[area].has(word),
    );
    const matching = server.tools.filter((tool) => {
      if (tool.policy === "off") return false;
      const words = nameWords(tool.name);
      if (!words.some((word) => READ_WORDS.has(word))) return false;
      if (runRefusal(server.id, tool.name)) return false;
      return words.some(
        (word) =>
          AREA_WORDS[area].has(word) ||
          (onAreaServer && ITEM_WORDS[area].has(word)),
      );
    });
    if (matching.length === 0) continue;
    if (server.status !== "ok") {
      attention ??= server.label;
      continue;
    }
    for (const tool of matching) {
      const entry: PersonalReadTool = {
        server: server.id,
        serverLabel: server.label,
        tool: tool.name,
        ...(tool.policy === "run" && tool.runWhen
          ? { rule: describeArgumentRules(tool.runWhen) }
          : {}),
      };
      (tool.policy === "run" ? ready : asking).push(entry);
    }
  }
  if (ready.length > 0) {
    return { state: "ready", tools: ready.slice(0, MAX_TOOLS) };
  }
  if (asking.length > 0) {
    return { state: "asks", tools: asking.slice(0, MAX_TOOLS) };
  }
  if (attention) return { state: "needs_attention", serverLabel: attention };
  return { state: "not_connected" };
}
