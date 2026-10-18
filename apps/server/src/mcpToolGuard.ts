/**
 * Limits on the owner's per-tool MCP policy (personal assistance, I6).
 *
 * - **Always asks.** Tools that send, reply, forward, archive, delete,
 *   label, move or invite, or create or change events, messages or drafts,
 *   can never be set to Run: matched by the words in the tool's name, by
 *   the server's `destructiveHint`, and by any extra patterns the owner
 *   adds. The owner can add to the list, not take from it.
 * - **On the owner's network** (Home Assistant and the like), only tools
 *   whose names read (get, list, search, …) can be on Run: turning things
 *   on or off, setting, opening and calling services always ask.
 * - **Argument rules.** A tool on Run may be limited to calls whose named
 *   arguments match the owner's values (exact, or a prefix ending in `*`),
 *   for example `calendarId` = `primary`. Any other call asks.
 */

/** Words that always mean an effect, wherever they appear in the name. */
const EFFECT_WORDS = new Set([
  "send",
  "reply",
  "forward",
  "archive",
  "unarchive",
  "trash",
  "untrash",
  "delete",
  "remove",
  "purge",
  "invite",
  "rsvp",
  "respond",
  "unsubscribe",
  "mark",
  "move",
  "cancel",
  "accept",
  "decline",
]);
/** Verbs that change something when applied to a personal item below. */
const CHANGE_WORDS = new Set([
  "create",
  "update",
  "edit",
  "patch",
  "insert",
  "add",
  "set",
  "modify",
  "change",
  "apply",
  "save",
  "draft",
]);
const PERSONAL_NOUNS = new Set([
  "event",
  "events",
  "calendar",
  "calendars",
  "message",
  "messages",
  "mail",
  "email",
  "emails",
  "draft",
  "drafts",
  "label",
  "labels",
  "thread",
  "threads",
  "invitation",
  "invitations",
  "attendee",
  "attendees",
  "filter",
  "filters",
  "reminder",
  "reminders",
  "contact",
  "contacts",
  "meeting",
  "meetings",
]);
const READ_WORDS = new Set([
  "get",
  "list",
  "search",
  "read",
  "find",
  "query",
  "fetch",
  "show",
  "describe",
  "lookup",
  "view",
]);

/** Device actions: with these, a network tool acts even if it also reads. */
const DEVICE_WORDS = new Set([
  "turn",
  "toggle",
  "open",
  "close",
  "lock",
  "unlock",
  "start",
  "stop",
  "pause",
  "unpause",
  "play",
  "press",
  "call",
  "trigger",
  "activate",
  "run",
  "execute",
  "increase",
  "decrease",
  "raise",
  "lower",
  "complete",
  "broadcast",
  "announce",
  "say",
  "speak",
  "notify",
  "arm",
  "disarm",
  "enable",
  "disable",
  "reload",
  "restart",
]);

export const MAX_ALWAYS_ASK_PATTERNS = 50;
const PATTERN = /^[A-Za-z0-9_.*/-]{1,100}$/u;
const MAX_RULE_ARGUMENTS = 5;
const MAX_RULE_VALUES = 20;
const MAX_RULE_VALUE_CHARS = 200;

/** The built-in list, described for the panel. */
export const BUILT_IN_ALWAYS_ASK = [
  `names with ${[...EFFECT_WORDS].join(", ")}`,
  `names that ${[...CHANGE_WORDS].filter((word) => word !== "draft").join(", ")} or draft an event, message, draft, label, thread, invitation, filter, reminder, contact or meeting`,
  "tools the server marks as destructive",
  "on a server on your network, every tool whose name does not read (get, list, search, find, query, fetch, show, view)",
] as const;

/** Lower-case words in a tool name: `gmail_sendMessage` → gmail, send, message. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

export interface GuardedTool {
  readonly name: string;
  readonly destructiveHint?: boolean;
}

/**
 * Why a tool can never be on Run, in plain words, or `undefined`.
 * `patterns` are the owner's extra entries (`*` matches anything; a
 * pattern with `/` is matched against `server/tool`).
 */
export function alwaysAskReason(
  serverId: string,
  tool: GuardedTool,
  patterns: readonly string[] = [],
  options: { readonly network?: boolean } = {},
): string | undefined {
  if (tool.destructiveHint === true) {
    return "the server marks it as destructive";
  }
  const words = nameWords(tool.name);
  if (
    options.network &&
    (!words.some((word) => READ_WORDS.has(word)) ||
      words.some(
        (word) =>
          DEVICE_WORDS.has(word) ||
          EFFECT_WORDS.has(word) ||
          CHANGE_WORDS.has(word),
      ))
  ) {
    return "it is on your network and its name does not say it only reads, so it may act on a device";
  }
  const effect = words.find((word) => EFFECT_WORDS.has(word));
  if (effect) return `it can ${effect} things`;
  const firstRead = words.findIndex((word) => READ_WORDS.has(word));
  const change = words.findIndex(
    (word, index) =>
      CHANGE_WORDS.has(word) &&
      // "get_draft" reads a draft; "draft_reply" writes one.
      !(word === "draft" && firstRead !== -1 && firstRead < index),
  );
  if (
    change !== -1 &&
    words.some((word, index) => index !== change && PERSONAL_NOUNS.has(word))
  ) {
    return `it can ${words[change]} email or calendar items`;
  }
  const qualified = `${serverId}/${tool.name}`.toLowerCase();
  const matched = patterns.find((pattern) =>
    globMatch(
      pattern.toLowerCase(),
      pattern.includes("/") ? qualified : tool.name.toLowerCase(),
    ),
  );
  return matched ? `it matches your always-ask entry "${matched}"` : undefined;
}

/** The owner's extra always-ask patterns, cleaned; throws on a bad one. */
export function normaliseAlwaysAskPatterns(value: unknown): string[] {
  if (!Array.isArray(value)) throw new GuardError("Give a list of patterns");
  const patterns = [
    ...new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean),
    ),
  ];
  if (patterns.length > MAX_ALWAYS_ASK_PATTERNS) {
    throw new GuardError(
      `At most ${MAX_ALWAYS_ASK_PATTERNS} always-ask entries`,
    );
  }
  for (const pattern of patterns) {
    if (!PATTERN.test(pattern) || /^[*/]+$/u.test(pattern)) {
      throw new GuardError(
        `"${pattern.slice(0, 40)}" is not a tool name pattern (letters, digits, _ . - /, and * for anything)`,
      );
    }
  }
  return patterns;
}

/** Named arguments and the values that may run without asking. */
export type McpArgumentRules = Readonly<Record<string, readonly string[]>>;

/** Validates rules against the tool's schema; throws in plain words. */
export function normaliseArgumentRules(
  inputSchema: Readonly<Record<string, unknown>>,
  value: unknown,
): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GuardError("Give each argument and its allowed values");
  }
  const properties =
    inputSchema.properties && typeof inputSchema.properties === "object"
      ? Object.keys(inputSchema.properties)
      : [];
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) throw new GuardError("Name at least one argument");
  if (entries.length > MAX_RULE_ARGUMENTS) {
    throw new GuardError(`At most ${MAX_RULE_ARGUMENTS} arguments`);
  }
  const rules: Record<string, string[]> = {};
  for (const [name, raw] of entries) {
    if (!properties.includes(name)) {
      throw new GuardError(`The tool has no argument "${name.slice(0, 60)}"`);
    }
    const values = [
      ...new Set(
        (Array.isArray(raw) ? raw : [])
          .map((item) => (typeof item === "string" ? item.trim() : ""))
          .filter(Boolean),
      ),
    ];
    if (values.length === 0) {
      throw new GuardError(`Give at least one value for "${name}"`);
    }
    if (values.length > MAX_RULE_VALUES) {
      throw new GuardError(`At most ${MAX_RULE_VALUES} values for "${name}"`);
    }
    for (const item of values) {
      if (item.length > MAX_RULE_VALUE_CHARS || /^\*+$/u.test(item)) {
        throw new GuardError(
          `"${item.slice(0, 40)}" is not a value (a bare * would allow anything)`,
        );
      }
    }
    rules[name] = values;
  }
  return rules;
}

/** Whether a call's arguments are inside the rules; the first that is not. */
export function argumentsMatch(
  rules: McpArgumentRules,
  args: Readonly<Record<string, unknown>>,
): { readonly ok: true } | { readonly ok: false; readonly argument: string } {
  for (const [name, allowed] of Object.entries(rules)) {
    const value = args[name];
    const items = Array.isArray(value) ? value : [value];
    const fits =
      items.length > 0 &&
      items.every(
        (item) =>
          (typeof item === "string" ||
            typeof item === "number" ||
            typeof item === "boolean") &&
          allowed.some((rule) => valueMatches(rule, String(item))),
      );
    if (!fits) return { ok: false, argument: name };
  }
  return { ok: true };
}

/** `calendarId is primary; entity_id starts with sensor.` */
export function describeArgumentRules(rules: McpArgumentRules): string {
  return Object.entries(rules)
    .map(([name, values]) => {
      const exact = values.filter((value) => !value.endsWith("*"));
      const prefixes = values
        .filter((value) => value.endsWith("*"))
        .map((value) => value.slice(0, -1));
      const parts = [
        ...(exact.length > 0 ? [`is ${exact.join(" or ")}`] : []),
        ...(prefixes.length > 0
          ? [`starts with ${prefixes.join(" or ")}`]
          : []),
      ];
      return `${name} ${parts.join(" or ")}`;
    })
    .join("; ");
}

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

function valueMatches(rule: string, value: string): boolean {
  return rule.endsWith("*")
    ? value.startsWith(rule.slice(0, -1))
    : value === rule;
}

function globMatch(pattern: string, value: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "u").test(value);
}
