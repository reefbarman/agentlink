import { scanShellLexBoundaries, scanShellLexWords } from "../util/shellLex.js";

import type { HumanDecisionRecordSnapshot } from "../agent/HumanDecisionRecord.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { isCommandPathInsideWorkspace } from "./commandTierClassifier.js";
import os from "node:os";
import path from "node:path";

const MAX_RESPONSE_CHARS = 32_768;
const MAX_RECEIPTS = 50;
const MAX_SESSIONS = 100;
const MAX_PAYLOAD_BYTES = 32_768;
const MAX_CURRENT_VIEWS = 50;
const MAX_CURRENT_OBJECTS = 200;
// Agents commonly stage review payloads in /tmp, which on macOS is not
// os.tmpdir() (a per-user /var/folders path) and resolves to /private/tmp.
const SHARED_TEMP_ROOT = "/tmp";

export interface ReviewPublicationTarget {
  host: string;
  repository: string;
  pr: number;
}

export interface ReviewPublicationContext {
  version: 1;
  mode: "builtin_review";
  command: string;
  cwd: string;
  humanInputRevision: number;
  target: ReviewPublicationTarget;
  kind: "comment" | "review" | "edit_comment" | "submit_review";
  sourceInputIds: string[];
  verified: true;
  payloadFiles: Array<{ reference: string; path: string; sha256: string }>;
  payloadPreviews?: Array<{ reference: string; content: string }>;
  workspaceRoots: string[];
  pendingReviewBody?: string;
}

export interface ReviewPublicationSessionSnapshot {
  builtinReview: boolean;
  foreground: boolean;
  humanInputRevision: number;
  humanDecisions: HumanDecisionRecordSnapshot;
  queuedHumanInputs: readonly string[];
}

export type ReviewPublicationUnavailableReason =
  | "pr_observation_missing"
  | "scope_unavailable"
  | "ambiguous_target"
  | "stale_human_input"
  | "unsupported_command"
  | "environment_opaque"
  | "ownership_unverified"
  | "payload_unavailable"
  | "unsupported_payload"
  | "collection_failed";

export type ReviewPublicationPreparation =
  | { status: "verified"; context: ReviewPublicationContext }
  | { status: "not_applicable" }
  | {
      status: "unavailable";
      reason: ReviewPublicationUnavailableReason;
      prerequisite?: { command: string };
    };

export interface ReviewPublicationRequest {
  sessionId: string;
  command: string;
  cwd: string;
  workspaceRoots: string[];
  humanInputRevision?: number;
  hasEnvOverrides?: boolean;
  environmentOpaque?: boolean;
  signal?: AbortSignal;
  allowPrerequisite?: boolean;
}

export interface ReviewPublicationCommandObservation extends ReviewPublicationRequest {
  result: {
    exit_code?: number | null;
    output?: string;
    output_complete?: boolean;
    output_finalized?: boolean;
    output_transformed?: boolean;
    is_running?: boolean;
    timed_out?: boolean;
    termination_reason?: string;
  };
}

export interface ReviewPublicationHost {
  prepare(
    request: ReviewPublicationRequest,
  ): ReviewPublicationContext | undefined;
  assess(request: ReviewPublicationRequest): ReviewPublicationPreparation;
  isCurrent(sessionId: string, context: ReviewPublicationContext): boolean;
  observe(request: ReviewPublicationCommandObservation): void;
}

interface ParsedGhAction {
  target?: ReviewPublicationTarget;
  kind: ReviewPublicationContext["kind"] | "read";
  endpoint?: string;
  host?: string;
  id?: number;
  method: string;
  payloadFiles: string[];
  payload?: Record<string, unknown>;
  receiptEligible: boolean;
  completePages?: boolean;
}

interface PublicationReceipt {
  target: ReviewPublicationTarget;
  id: number;
  family: "issue_comment" | "review_comment" | "review";
  actor: string;
  body: string;
  state?: string;
  emptyDraft?: boolean;
  sourceInputIds: string[];
}

interface CurrentReviewView {
  revision: number;
  target: ReviewPublicationTarget;
  objects: Map<
    string,
    {
      family: PublicationReceipt["family"];
      id: number;
      actor: string;
      body: string;
      state?: string;
    }
  >;
  emptyDraftReads: Set<number>;
}

interface SessionFacts {
  prs: Map<string, { target: ReviewPublicationTarget; revision: number }>;
  receipts: Map<string, PublicationReceipt>;
  currentViews: Map<string, CurrentReviewView>;
}

function targetKey(target: ReviewPublicationTarget): string {
  return `${target.host}/${target.repository}/${target.pr}`;
}

function targetFromUrl(value: unknown): ReviewPublicationTarget | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      return undefined;
    const match = /^\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
    if (!match || !/^[\w.-]+\/[\w.-]+$/.test(match[1]!)) return undefined;
    const pr = Number(match[2]);
    return Number.isSafeInteger(pr) && pr > 0
      ? {
          host: url.hostname.toLowerCase(),
          repository: match[1]!.toLowerCase(),
          pr,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function literalWords(command: string): string[] | undefined {
  const boundaries = scanShellLexBoundaries(command);
  if (
    boundaries.boundaries.length ||
    boundaries.finalState.quote ||
    boundaries.finalState.danglingEscape
  )
    return undefined;
  const scan = scanShellLexWords(command);
  if (scan.finalState.quote || scan.finalState.danglingEscape) return undefined;
  const words: string[] = [];
  for (const { raw } of scan.words) {
    let quote: "'" | '"' | undefined;
    let word = "";
    for (let i = 0; i < raw.length; i++) {
      const char = raw[i]!;
      if (char === quote) {
        quote = undefined;
        continue;
      }
      if (!quote && (char === "'" || char === '"')) {
        quote = char;
        continue;
      }
      if (quote !== "'" && (char === "$" || char === "`")) return undefined;
      if (!quote && /[<>;&|()*?{}]/.test(char)) return undefined;
      if (char === "\\" && quote !== "'") {
        const next = raw[++i];
        if (next === undefined) return undefined;
        if (!quote || /["\\$`\n]/.test(next)) {
          word += next === "\n" ? "" : next;
          continue;
        }
        word += "\\" + next;
        continue;
      }
      word += char;
    }
    if (quote) return undefined;
    words.push(word);
  }
  return words[0] === "gh" ? words : undefined;
}

function targetFromEndpoint(
  endpoint: string,
  host: string,
): ReviewPublicationTarget | undefined {
  const match =
    /^repos\/([\w.-]+\/[\w.-]+)\/(?:pulls|issues)\/(\d+)(?:\/|$)/.exec(
      endpoint,
    );
  const pr = Number(match?.[2]);
  return match && Number.isSafeInteger(pr) && pr > 0
    ? { host, repository: match[1]!.toLowerCase(), pr }
    : undefined;
}

function parseGhAction(
  command: string,
  defaultHost = "github.com",
): ParsedGhAction | undefined {
  if (!/^[\w.-]+$/.test(defaultHost)) return undefined;
  const words = literalWords(command);
  if (!words) return undefined;
  const args = words.slice(1);
  const payloadFiles: string[] = [];
  const fields: Record<string, unknown> = {};
  const seenOptions = new Set<string>();
  const headerNames = new Set<string>();
  let host = defaultHost.toLowerCase();
  let repository: string | undefined;
  let method: string | undefined;
  let endpoint: string | undefined;
  let prArg: string | undefined;
  let operation: string;
  let reviewEvent: string | undefined;
  let receiptEligible = true;
  let paginate = false;
  let slurp = false;
  if (args[0] === "api") operation = "api";
  else if (
    args[0] === "pr" &&
    ["comment", "review", "view"].includes(args[1] ?? "")
  )
    operation = args[1]!;
  else return undefined;
  const start = operation === "api" ? 1 : 2;
  for (let index = start; index < args.length; index++) {
    const token = args[index]!;
    if (!token.startsWith("-")) {
      if (operation === "api") {
        if (endpoint) return undefined;
        endpoint = token.replace(/^\//, "");
      } else {
        if (prArg) return undefined;
        prArg = token;
      }
      continue;
    }
    const equals = token.indexOf("=");
    const flag = equals > 0 ? token.slice(0, equals) : token;
    const optionKey =
      (
        {
          "-R": "--repo",
          "-X": "--method",
          "-b": "--body",
          "-H": "--header",
        } as Record<string, string>
      )[flag] ?? flag;
    if (
      [
        "--hostname",
        "--repo",
        "-R",
        "--method",
        "-X",
        "--body-file",
        "--input",
        "--body",
        "-b",
      ].includes(flag) &&
      seenOptions.has(optionKey)
    )
      return undefined;
    if (
      [
        "--hostname",
        "--repo",
        "-R",
        "--method",
        "-X",
        "--body-file",
        "--input",
        "--body",
        "-b",
      ].includes(flag)
    )
      seenOptions.add(optionKey);
    const value = () => (equals > 0 ? token.slice(equals + 1) : args[++index]);
    if (flag === "--hostname" && operation === "api") {
      const parsed = value();
      if (!parsed || !/^[\w.-]+$/.test(parsed)) return undefined;
      host = parsed.toLowerCase();
    } else if (["--repo", "-R"].includes(flag) && operation !== "api") {
      const parsed = value();
      if (!parsed || !/^[\w.-]+\/[\w.-]+$/.test(parsed)) return undefined;
      repository = parsed.toLowerCase();
    } else if (["--method", "-X"].includes(flag) && operation === "api") {
      if (method) return undefined;
      method = value()?.toUpperCase();
    } else if (["--body-file", "--input"].includes(flag)) {
      if ((flag === "--input") !== (operation === "api")) return undefined;
      const file = value();
      if (!file || file === "-" || payloadFiles.length) return undefined;
      payloadFiles.push(file);
    } else if (["--body", "-b"].includes(flag) && operation !== "api") {
      const body = value();
      if (body === undefined || fields.body !== undefined) return undefined;
      fields.body = body;
    } else if (
      ["--raw-field", "-f", "--field", "-F"].includes(flag) &&
      operation === "api"
    ) {
      const field = value();
      const split = field?.indexOf("=") ?? -1;
      if (!field || split < 1) return undefined;
      const key = field.slice(0, split);
      const content = field.slice(split + 1);
      if (
        !/^(body|event|commit_id|path|line|side|start_line|start_side|in_reply_to|comments)(?:\[\w*\])*$/.test(
          key,
        ) ||
        fields[key] !== undefined
      )
        return undefined;
      if (["--field", "-F"].includes(flag) && content.startsWith("@")) {
        const file = content.slice(1);
        if (!file || file === "-") return undefined;
        payloadFiles.push(file);
      }
      fields[key] = content;
    } else if (["--header", "-H"].includes(flag) && operation === "api") {
      const header = value();
      const match = /^(Accept|X-GitHub-Api-Version):\s*([^\r\n]*)$/i.exec(
        header ?? "",
      );
      if (
        !match ||
        /[\r\n]/.test(header ?? "") ||
        headerNames.has(match[1]!.toLowerCase())
      )
        return undefined;
      headerNames.add(match[1]!.toLowerCase());
    } else if (
      ["--comment", "--approve", "--request-changes"].includes(flag) &&
      operation === "review"
    ) {
      if (reviewEvent) return undefined;
      reviewEvent = flag;
    } else if (flag === "--json" && operation === "view") {
      if (!value()) return undefined;
    } else if (flag === "--paginate" && operation === "api" && !paginate) {
      paginate = true;
    } else if (flag === "--slurp" && operation === "api" && !slurp) {
      slurp = true;
    } else if (["--jq", "--template", "-q", "-t"].includes(flag)) {
      if (!value()) return undefined;
      receiptEligible = false;
    } else return undefined;
  }
  if (seenOptions.has("--input") && Object.keys(fields).length)
    return undefined;
  if (operation !== "api") {
    const urlTarget = targetFromUrl(prArg);
    const pr = Number(prArg);
    const target =
      urlTarget ??
      (repository && Number.isSafeInteger(pr) && pr > 0
        ? { host, repository, pr }
        : undefined);
    if (
      !target ||
      (urlTarget && repository && urlTarget.repository !== repository)
    )
      return undefined;
    if (operation === "view")
      return {
        target,
        kind: "read",
        method: "GET",
        payloadFiles,
        receiptEligible,
      };
    if (operation === "review" && !reviewEvent) return undefined;
    if (
      operation === "comment" &&
      fields.body === undefined &&
      !payloadFiles.length
    )
      return undefined;
    return {
      target,
      kind: operation === "comment" ? "comment" : "review",
      method: "POST",
      payloadFiles,
      payload: fields,
      receiptEligible: false,
    };
  }
  if (
    !endpoint ||
    !/^repos\/[\w.-]+\/[\w.-]+\/(?:pulls|issues)\//.test(endpoint) ||
    /[?#%]/.test(endpoint)
  )
    return undefined;
  method ??= Object.keys(fields).length || payloadFiles.length ? "POST" : "GET";
  const target = targetFromEndpoint(endpoint, host);
  if ((paginate || slurp) && method !== "GET") return undefined;
  if (method === "GET")
    return {
      target,
      endpoint,
      host,
      id: (() => {
        const parts = endpoint.split("/");
        const resource = Math.max(
          parts.lastIndexOf("comments"),
          parts.lastIndexOf("reviews"),
        );
        const value = Number(parts[resource + 1]);
        return resource >= 0 && Number.isSafeInteger(value) ? value : undefined;
      })(),
      kind: "read",
      method,
      payloadFiles,
      receiptEligible,
      completePages: paginate && slurp,
    };
  const id = Number(
    /\/(?:comments|reviews)\/(\d+)(?:\/events)?$/.exec(endpoint)?.[1],
  );
  if (
    method === "POST" &&
    /^repos\/[\w.-]+\/[\w.-]+\/(?:issues\/\d+\/comments|pulls\/\d+\/(?:comments|reviews)|pulls\/\d+\/comments\/\d+\/replies)$/.test(
      endpoint,
    )
  ) {
    return {
      target,
      endpoint,
      host,
      kind: endpoint.includes("/reviews") ? "review" : "comment",
      id: id || undefined,
      method,
      payloadFiles,
      payload: fields,
      receiptEligible,
    };
  }
  if (
    method === "PATCH" &&
    /^repos\/[\w.-]+\/[\w.-]+\/(?:issues\/comments\/\d+|pulls\/comments\/\d+|pulls\/\d+\/reviews\/\d+)$/.test(
      endpoint,
    )
  ) {
    return {
      target,
      endpoint,
      host,
      kind: "edit_comment",
      id,
      method,
      payloadFiles,
      payload: fields,
      receiptEligible,
    };
  }
  if (
    method === "POST" &&
    /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/reviews\/\d+\/events$/.test(endpoint)
  ) {
    return {
      target,
      endpoint,
      host,
      kind: "submit_review",
      id,
      method,
      payloadFiles,
      payload: fields,
      receiptEligible,
    };
  }
  return undefined;
}

export function isReviewPublicationCommand(command: string): boolean {
  const action = parseGhAction(command);
  return Boolean(action && action.kind !== "read");
}

/** Diagnostic only. This broad match never grants publication authority. */
export function isReviewPublicationCandidate(command: string): boolean {
  return (
    /\bgh\s+pr\s+(?:comment|review)\b/i.test(command) ||
    (/\bgh\s+api\b/i.test(command) &&
      (/(?:^|\s)(?:--method|-X)(?:=|\s+)(?:POST|PATCH|PUT|DELETE)\b/i.test(
        command,
      ) ||
        /(?:^|\s)(?:--input|--raw-field|--field|-f|-F)(?:=|\s)/.test(command)))
  );
}

function scopeInputs(
  snapshot: ReviewPublicationSessionSnapshot,
): Array<{ text: string; id: string }> | undefined {
  if (snapshot.humanDecisions.incomplete || snapshot.queuedHumanInputs.length)
    return undefined;
  const inputs: Array<{ text: string; id: string }> = [];
  for (const entry of snapshot.humanDecisions.entries) {
    if (entry.kind === "instruction") {
      if (entry.truncated) return undefined;
      inputs.push({ text: entry.text, id: entry.inputId });
      continue;
    }
    for (const question of entry.evidence.binding.questions) {
      const answer = entry.evidence.answers[question.id];
      const affirmative =
        answer === true ||
        (typeof answer === "string" &&
          /^(yes|approve|publish|post)$/i.test(answer));
      const refusal =
        answer === false ||
        (typeof answer === "string" &&
          /^(no|refuse|do not|don't)$/i.test(answer));
      if (
        entry.evidence.notes[question.id]?.trim() ||
        (!affirmative && !refusal)
      )
        return undefined;
      const directive = `${entry.evidence.binding.context} ${question.context ?? ""} ${question.question}`;
      const publicationQuestion =
        /\b(?:review|publish|post|submit|comment)\b/i.test(directive) &&
        !/\b(?:not|no|never|skip|avoid|without|instead|only|don't)\b/i.test(
          directive,
        );
      if (affirmative && !publicationQuestion) return undefined;
      inputs.push({
        text:
          affirmative && publicationQuestion
            ? /^\s*review\b/i.test(directive)
              ? directive
              : `Review ${directive}`
            : refusal
              ? `No: ${directive}`
              : directive,
        id: `${entry.evidence.binding.questionRequestId}:${question.id}`,
      });
    }
  }
  return inputs;
}

function authorisedTarget(
  inputs: Array<{ text: string; id: string }>,
  target: ReviewPublicationTarget,
): string[] | undefined {
  const authorised = new Map<
    string,
    { target: ReviewPublicationTarget; sourceIds: string[] }
  >();
  for (const input of inputs) {
    const text = input.text.trim();
    if (
      /^no\b/i.test(text) ||
      /\b(?:do not|don't|never|without|no|not|skip|avoid)\b[\s\S]{0,60}\b(?:post\w*|publish\w*|comment\w*|approv\w*|submit\w*|leave)\b|\b(?:report|read)[ -]only\b|\b(?:only|just)\s+(?:summari[sz]e|report|findings|read|inspect)\b/i.test(
        text,
      )
    )
      return undefined;

    // Only a complete, clear continuation preserves authority without naming
    // targets. Words such as "them" or "the review" inside another instruction
    // are not consent, and reset/stop/ambiguous instructions clear the scope.
    if (
      /^(?:please\s+)?(?:continue|resume|carry on|go ahead)(?:\s+(?:with\s+)?(?:the\s+)?(?:review|reviews|same PR|them|those))?[.!]?$/i.test(
        text,
      )
    )
      continue;
    const direct =
      /^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?review\b/i.test(text);
    const additive =
      /^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?also\s+review\b/i.test(
        text,
      );
    const ready =
      /^(?:PR|pull request)\s*#?\d+(?:\s*(?:,|and|&)\s*(?:(?:PR|pull request)\s*#?|#)?\d+)*\s+(?:is|are)\s+ready\s+for\s+review(?:[.!]|\s*$|\r?\n)/i.test(
        text,
      );
    if (
      (!direct && !additive && !ready) ||
      /\b(?:stop|pause|cancel|hold off|wait|forget|reset|clear|instead)\b/i.test(
        text,
      )
    ) {
      authorised.clear();
      continue;
    }

    const previous = [...authorised.values()].map(({ target: item }) => item);
    if (direct) authorised.clear();
    // Only the leading review-target list grants scope. References in later
    // explanation ("it supersedes #10", "depends on PR 8") are not requests.
    const subject = text
      .replace(
        /^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:also\s+)?review\s+/i,
        "",
      )
      .replace(/^(?:GitHub\s+)?pull requests?\s+(?=https:\/\/)/i, "")
      .replace(/^GitHub\s+(?=https:\/\/)/i, "")
      .replace(/^[\w.-]+\/[\w.-]+\s+(?=(?:PR|pull request|#))/i, "");
    const urlPattern = String.raw`https:\/\/[^\s<>"'),;]+`;
    const numberedPattern = String.raw`(?:(?:PR|pull request)\s*#?|#)\d+`;
    const list =
      new RegExp(
        `^(?:${urlPattern}|${numberedPattern})(?:\\s*(?:,|and\\b|&)\\s*(?:${urlPattern}|(?:(?:PR|pull request)\\s*#?|#)?\\d+))*`,
        "i",
      ).exec(subject)?.[0] ?? "";
    const urls = list.match(new RegExp(urlPattern, "g")) ?? [];
    const found = urls
      .map((url) => targetFromUrl(url.replace(/[.,;:!?]+$/, "")))
      .filter((item): item is ReviewPublicationTarget => Boolean(item));
    const numbers = [
      ...list.replace(new RegExp(urlPattern, "g"), "").matchAll(/\d+/g),
    ].map((match) => Number(match[0]));
    const withoutUrls = text.replace(/https:\/\/[^\s<>"')]+/g, "");
    if (numbers.length) {
      const repos = [
        ...new Set(
          [...withoutUrls.matchAll(/\b([\w.-]+\/[\w.-]+)\b/g)].map((match) =>
            match[1]!.toLowerCase(),
          ),
        ),
      ];
      const inherited = found.length ? found : previous;
      const origins = [
        ...new Map(
          inherited.map((item) => [`${item.host}/${item.repository}`, item]),
        ).values(),
      ];
      const origin =
        repos.length === 1
          ? {
              host:
                origins.length === 1 && origins[0]!.repository === repos[0]
                  ? origins[0]!.host
                  : "github.com",
              repository: repos[0]!,
            }
          : repos.length === 0 && origins.length === 1
            ? origins[0]
            : undefined;
      if (
        !origin ||
        numbers.some((pr) => !Number.isSafeInteger(pr) || pr <= 0)
      ) {
        authorised.clear();
        continue;
      }
      found.push(
        ...numbers.map((pr) => ({
          host: origin.host,
          repository: origin.repository,
          pr,
        })),
      );
    }
    if (!found.length || found.length > MAX_RECEIPTS) {
      authorised.clear();
      continue;
    }
    for (const item of found) {
      const key = targetKey(item);
      const sourceIds = authorised.get(key)?.sourceIds ?? [];
      if (!sourceIds.includes(input.id)) sourceIds.push(input.id);
      authorised.set(key, { target: item, sourceIds });
    }
    if (authorised.size > MAX_RECEIPTS) return undefined;
  }
  return authorised.get(targetKey(target))?.sourceIds;
}

function capturePayloadFiles(
  action: ParsedGhAction,
  request: ReviewPublicationRequest,
):
  | Pick<ReviewPublicationContext, "payloadFiles" | "payloadPreviews">
  | { error: "payload_unavailable" | "unsupported_payload" } {
  const files: ReviewPublicationContext["payloadFiles"] = [];
  const previews: NonNullable<ReviewPublicationContext["payloadPreviews"]> = [];
  let bytes = 0;
  for (const reference of action.payloadFiles) {
    try {
      const resolved = fs.realpathSync(path.resolve(request.cwd, reference));
      if (
        !isCommandPathInsideWorkspace(resolved, [
          ...request.workspaceRoots,
          os.tmpdir(),
          ...(process.platform === "win32" ? [] : [SHARED_TEMP_ROOT]),
        ])
      )
        return { error: "payload_unavailable" };
      const stat = fs.statSync(resolved);
      bytes += stat.size;
      if (!stat.isFile() || bytes > MAX_PAYLOAD_BYTES)
        return { error: "payload_unavailable" };
      const fd = fs.openSync(resolved, "r");
      let content: Buffer;
      try {
        const buffer = Buffer.alloc(stat.size + 1);
        const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (read !== stat.size) return { error: "payload_unavailable" };
        content = buffer.subarray(0, read);
      } finally {
        fs.closeSync(fd);
      }
      if (
        action.endpoint &&
        action.payloadFiles.length === 1 &&
        !Object.values(action.payload ?? {}).some(
          (value) => typeof value === "string" && value.startsWith("@"),
        )
      ) {
        let payload: unknown;
        try {
          payload = JSON.parse(content.toString("utf8"));
        } catch {
          return { error: "unsupported_payload" };
        }
        if (
          !payload ||
          typeof payload !== "object" ||
          Array.isArray(payload) ||
          Object.keys(payload).some(
            (key) =>
              ![
                "body",
                "event",
                "commit_id",
                "comments",
                "path",
                "line",
                "side",
                "start_line",
                "start_side",
                "in_reply_to",
              ].includes(key),
          )
        )
          return { error: "unsupported_payload" };
      }
      files.push({
        reference,
        path: resolved,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
      previews.push({ reference, content: content.toString("utf8") });
    } catch {
      return { error: "payload_unavailable" };
    }
  }
  return { payloadFiles: files, payloadPreviews: previews };
}

function receiptFamily(endpoint: string): PublicationReceipt["family"] {
  return endpoint.includes("/reviews")
    ? "review"
    : endpoint.includes("/issues/")
      ? "issue_comment"
      : "review_comment";
}

export function isReviewPublicationContextForInput(
  context: ReviewPublicationContext | undefined,
  input: { command: string; cwd: string; humanInputRevision?: number },
): context is ReviewPublicationContext {
  return Boolean(
    context?.verified &&
    context.version === 1 &&
    context.mode === "builtin_review" &&
    context.command === input.command &&
    context.cwd === input.cwd &&
    context.humanInputRevision === input.humanInputRevision,
  );
}

export function createReviewPublicationHost(options: {
  getSessionSnapshot(
    sessionId: string,
  ): ReviewPublicationSessionSnapshot | undefined;
}): ReviewPublicationHost {
  const sessions = new Map<string, SessionFacts>();
  const prerequisiteAttempts = new Map<string, Set<string>>();
  const factsFor = (sessionId: string) => {
    let facts = sessions.get(sessionId);
    if (!facts) {
      if (sessions.size >= MAX_SESSIONS)
        sessions.delete(sessions.keys().next().value!);
      facts = { prs: new Map(), receipts: new Map(), currentViews: new Map() };
      sessions.set(sessionId, facts);
    }
    return facts;
  };
  const assess = (
    request: ReviewPublicationRequest,
  ): ReviewPublicationPreparation => {
    try {
      const snapshot = options.getSessionSnapshot(request.sessionId);
      if (!snapshot?.builtinReview || !snapshot.foreground)
        return { status: "not_applicable" };
      const action = parseGhAction(
        request.command,
        process.env.GH_HOST || "github.com",
      );
      if (action?.kind === "read") return { status: "not_applicable" };
      if (!action)
        return isReviewPublicationCandidate(request.command)
          ? { status: "unavailable", reason: "unsupported_command" }
          : { status: "not_applicable" };
      if (snapshot.humanInputRevision !== request.humanInputRevision)
        return { status: "unavailable", reason: "stale_human_input" };
      if (
        request.signal?.aborted ||
        request.hasEnvOverrides ||
        request.environmentOpaque ||
        !isCommandPathInsideWorkspace(request.cwd, request.workspaceRoots)
      )
        return { status: "unavailable", reason: "environment_opaque" };
      const inputs = scopeInputs(snapshot);
      if (!inputs)
        return { status: "unavailable", reason: "scope_unavailable" };
      const facts = sessions.get(request.sessionId);
      const receipt =
        action.id && action.endpoint
          ? facts?.receipts.get(
              `${receiptFamily(action.endpoint)}:${action.id}`,
            )
          : undefined;
      const target = action.target ?? receipt?.target;
      if (!target)
        return {
          status: "unavailable",
          reason:
            action.kind === "edit_comment" || action.kind === "submit_review"
              ? "ownership_unverified"
              : "ambiguous_target",
        };

      if (receipt && action.endpoint) {
        const repository = /^repos\/([\w.-]+\/[\w.-]+)\//
          .exec(action.endpoint)?.[1]
          ?.toLowerCase();
        if (
          repository !== receipt.target.repository ||
          action.host !== receipt.target.host
        )
          return { status: "unavailable", reason: "ownership_unverified" };
      }
      const sourceInputIds = authorisedTarget(inputs, target);
      if (!sourceInputIds)
        return { status: "unavailable", reason: "scope_unavailable" };
      const currentView = facts?.currentViews.get(targetKey(target));
      const currentObject =
        currentView && action.id
          ? currentView.objects.get(
              `${receiptFamily(action.endpoint!)}:${action.id}`,
            )
          : undefined;
      if (
        (action.kind === "edit_comment" || action.kind === "submit_review") &&
        (!receipt ||
          !currentView ||
          currentView.revision !== request.humanInputRevision ||
          !currentObject ||
          currentObject.actor !== receipt.actor ||
          currentObject.body !== receipt.body ||
          targetKey(receipt.target) !== targetKey(target) ||
          !receipt.sourceInputIds.some((id) => sourceInputIds.includes(id)) ||
          (action.kind === "submit_review" &&
            (receipt.state !== "PENDING" ||
              currentObject.state !== "PENDING" ||
              receipt.emptyDraft !== true ||
              !currentView.emptyDraftReads.has(action.id!))))
      )
        return { status: "unavailable", reason: "ownership_unverified" };
      const payloadEvidence = capturePayloadFiles(action, request);
      if ("error" in payloadEvidence)
        return { status: "unavailable", reason: payloadEvidence.error };
      let payload = action.payload ?? {};
      if (
        action.endpoint &&
        action.payloadFiles.length &&
        !Object.keys(payload).length
      ) {
        payload = JSON.parse(
          payloadEvidence.payloadPreviews![0]!.content,
        ) as Record<string, unknown>;
      }
      if (
        action.kind === "edit_comment" &&
        Object.keys(payload).some((key) => key !== "body")
      )
        return { status: "unavailable", reason: "unsupported_payload" };
      if (
        action.kind === "submit_review" &&
        (Object.keys(payload).some((key) => !["body", "event"].includes(key)) ||
          !["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(
            String(payload.event),
          ))
      )
        return { status: "unavailable", reason: "unsupported_payload" };
      if (
        action.kind === "review" &&
        payload.event !== undefined &&
        !["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(
          String(payload.event),
        )
      )
        return { status: "unavailable", reason: "unsupported_payload" };
      if (
        action.kind === "comment" &&
        payload.body === undefined &&
        !action.payloadFiles.length
      )
        return { status: "unavailable", reason: "unsupported_payload" };
      const prObservation = facts?.prs.get(targetKey(target));
      if (
        !prObservation ||
        (prObservation.revision !== request.humanInputRevision &&
          !["comment", "review"].includes(action.kind))
      ) {
        const unavailable = {
          status: "unavailable",
          reason: "pr_observation_missing",
        } as const;
        if (
          !request.allowPrerequisite ||
          !["comment", "review"].includes(action.kind)
        )
          return unavailable;
        let attempts = prerequisiteAttempts.get(request.sessionId);
        if (!attempts) {
          if (prerequisiteAttempts.size >= MAX_SESSIONS)
            prerequisiteAttempts.delete(
              prerequisiteAttempts.keys().next().value!,
            );
          attempts = new Set();
          prerequisiteAttempts.set(request.sessionId, attempts);
        }
        const key = `${targetKey(target)}\u0000${request.humanInputRevision}`;
        if (attempts.has(key) || attempts.size >= MAX_RECEIPTS)
          return unavailable;
        attempts.add(key);
        const url = `https://${target.host}/${target.repository}/pull/${target.pr}`;
        return {
          ...unavailable,
          prerequisite: {
            command: `gh pr view ${url} --json number,url,headRefOid`,
          },
        };
      }
      return {
        status: "verified",
        context: {
          version: 1,
          mode: "builtin_review",
          command: request.command,
          cwd: request.cwd,
          humanInputRevision: snapshot.humanInputRevision,
          target,
          kind: action.kind,
          sourceInputIds,
          verified: true,
          ...payloadEvidence,
          workspaceRoots: [...request.workspaceRoots],
          ...(action.kind === "submit_review"
            ? { pendingReviewBody: currentObject!.body }
            : {}),
        },
      };
    } catch {
      return { status: "unavailable", reason: "collection_failed" };
    }
  };
  const prepare = (
    request: ReviewPublicationRequest,
  ): ReviewPublicationContext | undefined => {
    const result = assess({ ...request, allowPrerequisite: false });
    return result.status === "verified" ? result.context : undefined;
  };
  return {
    prepare,
    assess,
    isCurrent(sessionId, context) {
      const current = prepare({
        sessionId,
        command: context.command,
        cwd: context.cwd,
        workspaceRoots: context.workspaceRoots,
        humanInputRevision: context.humanInputRevision,
      });
      return Boolean(
        current &&
        current.pendingReviewBody === context.pendingReviewBody &&
        targetKey(current.target) === targetKey(context.target) &&
        JSON.stringify(current.sourceInputIds) ===
          JSON.stringify(context.sourceInputIds) &&
        JSON.stringify(current.payloadFiles) ===
          JSON.stringify(context.payloadFiles),
      );
    },
    observe(request) {
      try {
        const attempted = parseGhAction(
          request.command,
          process.env.GH_HOST || "github.com",
        );
        const executedContext =
          attempted?.kind !== "read" ? prepare(request) : undefined;
        const existingFacts = sessions.get(request.sessionId);
        if (attempted?.kind !== "read") existingFacts?.currentViews.clear();
        const draftRead =
          /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/reviews\/(\d+)\/comments$/.exec(
            attempted?.endpoint ?? "",
          );
        if (draftRead) {
          for (const view of existingFacts?.currentViews.values() ?? [])
            view.emptyDraftReads.delete(Number(draftRead[1]));
        }
        if (attempted?.kind === "read" && attempted.id && attempted.endpoint) {
          const facts = sessions.get(request.sessionId);
          const key = `${receiptFamily(attempted.endpoint)}:${attempted.id}`;
          for (const view of facts?.currentViews.values() ?? [])
            view.objects.delete(key);
        }
        const snapshot = options.getSessionSnapshot(request.sessionId);
        const { result } = request;
        if (
          !snapshot?.builtinReview ||
          !snapshot.foreground ||
          request.hasEnvOverrides ||
          request.environmentOpaque ||
          request.signal?.aborted ||
          request.humanInputRevision === undefined ||
          request.humanInputRevision !== snapshot.humanInputRevision ||
          result.exit_code !== 0 ||
          result.output_transformed === true ||
          result.is_running ||
          result.timed_out ||
          result.termination_reason ||
          result.output_complete !== true ||
          result.output_finalized !== true ||
          !result.output ||
          result.output.length > MAX_RESPONSE_CHARS
        )
          return;
        const action = parseGhAction(
          request.command,
          process.env.GH_HOST || "github.com",
        );
        if (!action?.receiptEligible) return;
        const data: unknown = JSON.parse(result.output);
        const facts = factsFor(request.sessionId);
        if (Array.isArray(data)) {
          const match =
            /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/reviews\/(\d+)\/comments$/.exec(
              action.endpoint ?? "",
            );
          const reviewId = Number(match?.[1]);
          if (!match || !action.target || action.host !== action.target.host)
            return;
          const view = facts.currentViews.get(targetKey(action.target));
          if (!view || view.revision !== request.humanInputRevision) return;
          view.emptyDraftReads.delete(reviewId);
          if (
            action.completePages &&
            data.length > 0 &&
            data.every((page) => Array.isArray(page) && page.length === 0)
          )
            view.emptyDraftReads.add(reviewId);
          return;
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) return;
        const value = data as Record<string, unknown>;
        const urlTarget = targetFromUrl(value.html_url ?? value.url);
        const urlMatches = Boolean(
          urlTarget &&
          action.target &&
          targetKey(urlTarget) === targetKey(action.target),
        );
        const hasUrl = value.html_url !== undefined || value.url !== undefined;
        // `gh pr view <pr> --repo <repo> --json <fields>` already names the
        // exact PR in its arguments, and a successful JSON object proves it
        // resolved on this host. Agents rarely request url/number, so accept
        // any field set, but reject identity fields that disagree.
        const prViewSeen =
          !action.endpoint &&
          Object.keys(value).length > 0 &&
          (hasUrl ? urlMatches : true) &&
          (value.number === undefined || value.number === action.target?.pr);
        const apiPullSeen =
          action.endpoint !== undefined &&
          /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+$/.test(action.endpoint) &&
          urlMatches &&
          value.number === action.target?.pr;
        if (
          action.kind === "read" &&
          action.target &&
          (prViewSeen || apiPullSeen)
        ) {
          if (facts.prs.size >= MAX_RECEIPTS)
            facts.prs.delete(facts.prs.keys().next().value!);
          facts.prs.set(targetKey(action.target), {
            target: action.target,
            revision: request.humanInputRevision,
          });
          return;
        }
        if (action.kind === "read" && action.id && action.endpoint) {
          const family = receiptFamily(action.endpoint);
          const receipt = facts.receipts.get(`${family}:${action.id}`);
          const endpointParts = action.endpoint.split("/");
          const repository =
            `${endpointParts[1]}/${endpointParts[2]}`.toLowerCase();
          const actor = (value.user as { login?: unknown } | undefined)?.login;
          if (
            !receipt ||
            action.host !== receipt.target.host ||
            repository !== receipt.target.repository ||
            (action.target &&
              targetKey(action.target) !== targetKey(receipt.target)) ||
            value.id !== action.id ||
            typeof actor !== "string" ||
            typeof value.body !== "string"
          )
            return;
          let view = facts.currentViews.get(targetKey(receipt.target));
          if (!view || view.revision !== request.humanInputRevision) {
            if (facts.currentViews.size >= MAX_CURRENT_VIEWS)
              facts.currentViews.delete(
                facts.currentViews.keys().next().value!,
              );
            view = {
              revision: request.humanInputRevision,
              target: receipt.target,
              objects: new Map(),
              emptyDraftReads: new Set(),
            };
            facts.currentViews.set(targetKey(receipt.target), view);
          }
          const objectKey = `${family}:${action.id}`;
          if (
            view.objects.size >= MAX_CURRENT_OBJECTS &&
            !view.objects.has(objectKey)
          )
            return;
          view.objects.set(objectKey, {
            family,
            id: action.id,
            actor,
            body: value.body,
            ...(typeof value.state === "string"
              ? { state: value.state.toUpperCase() }
              : {}),
          });
          return;
        }
        const context = executedContext;
        if (
          !context ||
          !action.endpoint ||
          !["comment", "review", "edit_comment"].includes(action.kind)
        )
          return;
        const id = value.id;
        const actor = (value.user as { login?: unknown } | undefined)?.login;
        if (
          typeof id !== "number" ||
          !Number.isSafeInteger(id) ||
          id <= 0 ||
          (action.kind === "edit_comment" && id !== action.id) ||
          typeof actor !== "string" ||
          typeof value.body !== "string"
        )
          return;
        const state =
          typeof value.state === "string"
            ? value.state.toUpperCase()
            : undefined;
        const family = receiptFamily(action.endpoint);
        if (facts.receipts.size >= MAX_RECEIPTS)
          facts.receipts.delete(facts.receipts.keys().next().value!);
        facts.receipts.set(`${family}:${id}`, {
          target: context.target,
          id,
          family,
          actor,
          body: value.body,
          state,
          emptyDraft:
            family === "review" &&
            state === "PENDING" &&
            action.payloadFiles.length === 0 &&
            !Object.keys(action.payload ?? {}).some((key) =>
              key.startsWith("comments"),
            ),
          sourceInputIds: context.sourceInputIds,
        });
      } catch {
        // Receipt evidence is optional and never affects command completion.
      }
    },
  };
}
