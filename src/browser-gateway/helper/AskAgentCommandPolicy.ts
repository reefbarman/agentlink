import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type {
  RuleEntry,
  SubCommandEntry,
} from "@agentlink/protocol/approval-transport";
import type { CommandRule } from "../../approvals/commandRuleTypes.js";
import type { ScopedRules } from "../../approvals/ruleTypes.js";
import {
  commandRuleMatches,
  evaluateCommandRulePolicy,
} from "../../approvals/commandRulePolicy.js";
import {
  expandSubCommands,
  splitCompoundCommand,
} from "../../approvals/commandSplitter.js";
import { randomUUID } from "node:crypto";
import { writeTextFileAtomic } from "../atomicFile.js";

/**
 * Approval policy for Ask Agent commands in folders granted for commands.
 *
 * Rules use VS Code's command rule format and matching (prefix, exact or
 * regex per sub-command; Forbidden beats Prompt beats Allow), with Ask Agent
 * scopes: `session` is this chat (kept in memory), `project` is one granted
 * folder and `global` is every granted folder (both saved). VS Code's own
 * rules are never read. Approve for Me runs commands without a card unless a
 * Prompt or Forbidden rule matches; every command still runs in the sandbox.
 *
 * Destination rules let a command that asked for the network connect to an
 * exact `protocol://host:port` without a card, with the same scopes. They
 * never make a command itself run, or run outside the sandbox.
 */

export type AskAgentCommandRuleScope = "session" | "project" | "global";

export interface AskAgentSavedCommandRule {
  readonly id: string;
  readonly pattern: string;
  readonly mode: CommandRule["mode"];
  readonly decision: "allow" | "prompt" | "forbidden";
  readonly scope: AskAgentCommandRuleScope;
  /** The granted folder a `project` rule belongs to. */
  readonly root?: string;
  readonly createdAt: number;
}

export interface AskAgentNetworkDestination {
  readonly protocol: "http" | "https" | "tcp";
  /** Lower-case host name or address. */
  readonly host: string;
  readonly port: number;
}

export interface AskAgentSavedDestinationRule extends AskAgentNetworkDestination {
  readonly id: string;
  readonly scope: AskAgentCommandRuleScope;
  /** The granted folder a `project` rule belongs to. */
  readonly root?: string;
  readonly createdAt: number;
}

export interface AskAgentCommandPolicySnapshot {
  readonly approveForMe: boolean;
  /** Saved rules plus the given chat's rules. */
  readonly rules: readonly AskAgentSavedCommandRule[];
  /** Saved destination rules plus the given chat's. */
  readonly destinations: readonly AskAgentSavedDestinationRule[];
}

export type AskAgentCommandPolicyDecision =
  | { readonly decision: "allow"; readonly by: "rule" | "approve-for-me" }
  | { readonly decision: "forbidden" }
  | {
      readonly decision: "ask";
      /** Sub-commands for the card's rule rows. */
      readonly subCommands: SubCommandEntry[];
    };

interface PolicyFile {
  readonly schemaVersion: 1;
  readonly approveForMe: boolean;
  readonly rules: readonly AskAgentSavedCommandRule[];
  readonly destinations: readonly AskAgentSavedDestinationRule[];
}

const MODES = new Set(["prefix", "exact", "regex"]);
const DECISIONS = new Set(["allow", "prompt", "forbidden"]);
const MAX_PATTERN_LENGTH = 2_000;
const MAX_RULES = 500;
const PROTOCOLS = new Set(["http", "https", "tcp"]);
const HOST = /^[a-z0-9.:_-]{1,253}$/;

export function getAskAgentCommandPolicyPath(): string {
  return path.join(os.homedir(), ".agentlink", "ask-agent-command-policy.json");
}

function validRule(value: unknown): value is AskAgentSavedCommandRule {
  if (!value || typeof value !== "object") return false;
  const rule = value as Record<string, unknown>;
  return (
    typeof rule.id === "string" &&
    typeof rule.pattern === "string" &&
    rule.pattern.trim().length > 0 &&
    rule.pattern.length <= MAX_PATTERN_LENGTH &&
    MODES.has(rule.mode as string) &&
    DECISIONS.has(rule.decision as string) &&
    (rule.scope === "global" ||
      rule.scope === "session" ||
      (rule.scope === "project" &&
        typeof rule.root === "string" &&
        path.isAbsolute(rule.root))) &&
    typeof rule.createdAt === "number" &&
    (rule.mode !== "regex" || compiles(rule.pattern))
  );
}

function validDestination(
  value: unknown,
): value is AskAgentSavedDestinationRule {
  if (!value || typeof value !== "object") return false;
  const rule = value as Record<string, unknown>;
  return (
    typeof rule.id === "string" &&
    PROTOCOLS.has(rule.protocol as string) &&
    typeof rule.host === "string" &&
    HOST.test(rule.host) &&
    Number.isInteger(rule.port) &&
    (rule.port as number) >= 1 &&
    (rule.port as number) <= 65_535 &&
    (rule.scope === "global" ||
      rule.scope === "session" ||
      (rule.scope === "project" &&
        typeof rule.root === "string" &&
        path.isAbsolute(rule.root))) &&
    typeof rule.createdAt === "number"
  );
}

function sameDestination(
  left: AskAgentNetworkDestination & { scope?: string; root?: string },
  right: AskAgentNetworkDestination & { scope?: string; root?: string },
): boolean {
  return (
    left.protocol === right.protocol &&
    left.host === right.host &&
    left.port === right.port &&
    left.scope === right.scope &&
    (left.root ?? "") === (right.root ?? "")
  );
}

function removeSessionEntry<T extends { readonly id: string }>(
  sessions: Map<string, T[]>,
  id: string,
): boolean {
  for (const [sessionId, entries] of sessions) {
    const remaining = entries.filter((entry) => entry.id !== id);
    if (remaining.length !== entries.length) {
      sessions.set(sessionId, remaining);
      return true;
    }
  }
  return false;
}

/** Whether a value is a well-formed rule row sent back by the approval card. */
export function isAskAgentCardRuleEntry(value: unknown): value is RuleEntry {
  if (!value || typeof value !== "object") return false;
  const rule = value as Record<string, unknown>;
  if (
    typeof rule.pattern !== "string" ||
    rule.pattern.length > MAX_PATTERN_LENGTH ||
    !["prefix", "exact", "regex", "skip"].includes(rule.mode as string) ||
    !["session", "project", "global", "skip"].includes(rule.scope as string) ||
    (rule.decision !== undefined && !DECISIONS.has(rule.decision as string))
  ) {
    return false;
  }
  if (rule.scope === "skip" || rule.mode === "skip") return true;
  return (
    rule.pattern.trim().length > 0 &&
    (rule.mode !== "regex" || compiles(rule.pattern))
  );
}

/**
 * Regex rules are tested synchronously in the helper, so refuse patterns
 * that compile but can backtrack catastrophically. This conservatively
 * rejects any quantified group that itself contains a quantifier, the
 * `(a+)+` shape behind most such patterns.
 */
function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern);
  } catch {
    return false;
  }
  return !hasNestedQuantifier(pattern);
}

function hasNestedQuantifier(pattern: string): boolean {
  // Whether each open group contains a quantifier so far.
  const groups: boolean[] = [];
  let closedGroupQuantified = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\") {
      index += 1;
      closedGroupQuantified = false;
      continue;
    }
    if (char === "[") {
      index += 1;
      while (index < pattern.length && pattern[index] !== "]") {
        if (pattern[index] === "\\") index += 1;
        index += 1;
      }
      closedGroupQuantified = false;
      continue;
    }
    if (char === "(") {
      groups.push(false);
      closedGroupQuantified = false;
      continue;
    }
    if (char === ")") {
      closedGroupQuantified = groups.pop() ?? false;
      if (closedGroupQuantified && groups.length > 0) {
        groups[groups.length - 1] = true;
      }
      continue;
    }
    if (char === "+" || char === "*" || char === "{") {
      if (closedGroupQuantified) return true;
      if (groups.length > 0) groups[groups.length - 1] = true;
      continue;
    }
    if (char === "?" && closedGroupQuantified) {
      // `(a+)?` cannot repeat the group; keep scanning.
      closedGroupQuantified = false;
      continue;
    }
    if (char !== "?") closedGroupQuantified = false;
  }
  return false;
}

function sameRule(
  left: Pick<AskAgentSavedCommandRule, "pattern" | "mode" | "scope" | "root">,
  right: Pick<AskAgentSavedCommandRule, "pattern" | "mode" | "scope" | "root">,
): boolean {
  return (
    left.pattern === right.pattern &&
    left.mode === right.mode &&
    left.scope === right.scope &&
    (left.root ?? "") === (right.root ?? "")
  );
}

export class AskAgentCommandPolicy {
  private readonly filePath: string;
  private loaded: Promise<PolicyFile> | undefined;
  private state: PolicyFile = {
    schemaVersion: 1,
    approveForMe: false,
    rules: [],
    destinations: [],
  };
  private readonly sessionRules = new Map<string, AskAgentSavedCommandRule[]>();
  private readonly sessionDestinations = new Map<
    string,
    AskAgentSavedDestinationRule[]
  >();
  private pending: Promise<void> = Promise.resolve();

  constructor(options: { readonly filePath?: string } = {}) {
    this.filePath = options.filePath ?? getAskAgentCommandPolicyPath();
  }

  async snapshot(sessionId?: string): Promise<AskAgentCommandPolicySnapshot> {
    const state = await this.load();
    return {
      approveForMe: state.approveForMe,
      rules: [
        ...(sessionId ? (this.sessionRules.get(sessionId) ?? []) : []),
        ...state.rules,
      ].map((rule) => ({ ...rule })),
      destinations: [
        ...(sessionId ? (this.sessionDestinations.get(sessionId) ?? []) : []),
        ...state.destinations,
      ].map((rule) => ({ ...rule })),
    };
  }

  /** Whether a destination rule lets a command in `root` connect. */
  async isDestinationAllowed(
    request: AskAgentNetworkDestination & {
      readonly sessionId: string;
      readonly root: string;
    },
  ): Promise<boolean> {
    const state = await this.load();
    const host = request.host.toLowerCase();
    const matches = (rule: AskAgentSavedDestinationRule) =>
      rule.protocol === request.protocol &&
      rule.host === host &&
      rule.port === request.port;
    return (
      (this.sessionDestinations.get(request.sessionId) ?? []).some(matches) ||
      state.destinations.some(
        (rule) =>
          matches(rule) &&
          (rule.scope === "global" ||
            (rule.scope === "project" && rule.root === request.root)),
      )
    );
  }

  /** Save an exact destination rule chosen on a network approval card. */
  async saveDestination(
    request: AskAgentNetworkDestination & {
      readonly sessionId: string;
      readonly root: string;
      readonly scope: AskAgentCommandRuleScope;
    },
  ): Promise<void> {
    const rule = {
      id: `ask-agent-destination-rule-${randomUUID()}`,
      protocol: request.protocol,
      host: request.host.toLowerCase(),
      port: request.port,
      scope: request.scope,
      ...(request.scope === "project" ? { root: request.root } : {}),
      createdAt: Date.now(),
    } satisfies AskAgentSavedDestinationRule;
    if (!validDestination(rule)) throw new Error("destination_rule_invalid");
    if (rule.scope === "session") {
      const current = this.sessionDestinations.get(request.sessionId) ?? [];
      this.sessionDestinations.set(request.sessionId, [
        ...current.filter((existing) => !sameDestination(existing, rule)),
        rule,
      ]);
      return;
    }
    await this.mutate((state) => ({
      ...state,
      destinations: [
        ...state.destinations.filter(
          (existing) => !sameDestination(existing, rule),
        ),
        rule,
      ].slice(-MAX_RULES),
    }));
  }

  /** Decide whether a command in `root` runs, is refused, or asks first. */
  async evaluate(request: {
    readonly sessionId: string;
    readonly root: string;
    readonly command: string;
  }): Promise<AskAgentCommandPolicyDecision> {
    const state = await this.load();
    const scoped = this.scopedRules(state, request.sessionId, request.root);
    const evaluation = evaluateCommandRulePolicy(scoped, request.command);
    if (evaluation.decision === "forbidden") return { decision: "forbidden" };
    if (evaluation.decision !== "prompt") {
      if (evaluation.allSegmentsExplicitlyAllowed) {
        return { decision: "allow", by: "rule" };
      }
      if (state.approveForMe)
        return { decision: "allow", by: "approve-for-me" };
    }
    const segments = splitCompoundCommand(request.command);
    const expanded = expandSubCommands(
      segments.length > 0 ? segments : [request.command.trim()],
    );
    return {
      decision: "ask",
      subCommands: expanded.map((command) => {
        for (const scope of ["session", "project", "global"] as const) {
          const rule = scoped[scope].find((candidate) =>
            commandRuleMatches(command, candidate),
          );
          if (rule) {
            return {
              command,
              existingRule: {
                pattern: rule.pattern,
                mode: rule.mode,
                decision: rule.decision ?? "allow",
                scope,
              },
            };
          }
        }
        return { command };
      }),
    };
  }

  /** Save the rules chosen on an approval card (`skip` entries are ignored). */
  async saveCardRules(request: {
    readonly sessionId: string;
    readonly root: string;
    readonly rules: readonly RuleEntry[];
  }): Promise<void> {
    const additions = request.rules.flatMap((entry) => {
      if (entry.scope === "skip" || entry.mode === "skip") return [];
      const rule = {
        id: `ask-agent-command-rule-${randomUUID()}`,
        pattern: entry.pattern.trim(),
        mode: entry.mode,
        decision: entry.decision ?? "allow",
        scope: entry.scope,
        ...(entry.scope === "project" ? { root: request.root } : {}),
        createdAt: Date.now(),
      } satisfies AskAgentSavedCommandRule;
      if (!validRule(rule)) throw new Error("command_rule_invalid");
      return [rule];
    });
    if (additions.length === 0) return;
    // Save to disk first, so a failed write applies none of the rules.
    const saved = additions.filter((rule) => rule.scope !== "session");
    if (saved.length > 0) {
      await this.mutate((state) => ({
        ...state,
        rules: [
          ...state.rules.filter(
            (existing) => !saved.some((rule) => sameRule(rule, existing)),
          ),
          ...saved,
        ].slice(-MAX_RULES),
      }));
    }
    const session = additions.filter((rule) => rule.scope === "session");
    if (session.length > 0) {
      const current = this.sessionRules.get(request.sessionId) ?? [];
      this.sessionRules.set(request.sessionId, [
        ...current.filter(
          (existing) => !session.some((rule) => sameRule(rule, existing)),
        ),
        ...session,
      ]);
    }
  }

  /** Remove a command or destination rule by ID. */
  async removeRule(id: string): Promise<boolean> {
    if (removeSessionEntry(this.sessionRules, id)) return true;
    if (removeSessionEntry(this.sessionDestinations, id)) return true;
    let removed = false;
    await this.mutate((state) => {
      const rules = state.rules.filter((rule) => rule.id !== id);
      const destinations = state.destinations.filter((rule) => rule.id !== id);
      removed =
        rules.length !== state.rules.length ||
        destinations.length !== state.destinations.length;
      return { ...state, rules, destinations };
    });
    return removed;
  }

  async setApproveForMe(enabled: boolean): Promise<void> {
    await this.mutate((state) => ({ ...state, approveForMe: enabled }));
  }

  /** Forget a chat's session rules (for example when it is deleted). */
  clearSession(sessionId: string): void {
    this.sessionRules.delete(sessionId);
    this.sessionDestinations.delete(sessionId);
  }

  private scopedRules(
    state: PolicyFile,
    sessionId: string,
    root: string,
  ): ScopedRules<CommandRule> {
    const toRule = (rule: AskAgentSavedCommandRule): CommandRule => ({
      pattern: rule.pattern,
      mode: rule.mode,
      decision: rule.decision,
    });
    return {
      session: (this.sessionRules.get(sessionId) ?? []).map(toRule),
      project: state.rules
        .filter((rule) => rule.scope === "project" && rule.root === root)
        .map(toRule),
      global: state.rules.filter((rule) => rule.scope === "global").map(toRule),
    };
  }

  private load(): Promise<PolicyFile> {
    this.loaded ??= (async () => {
      const raw = await fs.readFile(this.filePath, "utf8").catch(() => null);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Partial<PolicyFile>;
          this.state = {
            schemaVersion: 1,
            approveForMe: parsed.approveForMe === true,
            // Chat rules are never saved, so ignore any on disk.
            rules: Array.isArray(parsed.rules)
              ? parsed.rules.filter(
                  (rule) => validRule(rule) && rule.scope !== "session",
                )
              : [],
            destinations: Array.isArray(parsed.destinations)
              ? parsed.destinations.filter(
                  (rule) => validDestination(rule) && rule.scope !== "session",
                )
              : [],
          };
        } catch {
          // A damaged file falls back to asking for every command.
        }
      }
      return this.state;
    })();
    return this.loaded;
  }

  private async mutate(
    change: (state: PolicyFile) => PolicyFile,
  ): Promise<void> {
    const run = async () => {
      const next = change(await this.load());
      // Apply only after the write succeeds, so a failed save changes
      // nothing that decides whether commands run.
      await writeTextFileAtomic(
        this.filePath,
        `${JSON.stringify(next, null, 2)}\n`,
        { mode: 0o600 },
      );
      this.state = next;
      this.loaded = Promise.resolve(next);
    };
    const next = this.pending.then(run, run);
    this.pending = next.catch(() => undefined);
    await next;
  }
}
