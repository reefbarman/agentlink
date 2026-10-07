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

export interface ReviewPublicationRequest {
  sessionId: string;
  command: string;
  cwd: string;
  workspaceRoots: string[];
  humanInputRevision?: number;
  hasEnvOverrides?: boolean;
  environmentOpaque?: boolean;
  signal?: AbortSignal;
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
        "--header",
        "-H",
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
        "--header",
        "-H",
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
      if (!/^(Accept|X-GitHub-Api-Version):/i.test(value() ?? ""))
        return undefined;
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
            ? `Review ${directive}`
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
  let source: string | undefined;
  let publishingRestricted = false;
  for (const input of inputs) {
    if (
      /^\s*no\b/i.test(input.text) ||
      /\b(?:do not|don't|never|without|no|not|skip|avoid)\b[\s\S]{0,60}\b(?:post\w*|publish\w*|comment\w*|approv\w*|submit\w*|leave)\b|\b(?:report|read)[ -]only\b|\b(?:only|just)\s+(?:summari[sz]e|report|findings)\b/i.test(
        input.text,
      )
    ) {
      source = undefined;
      publishingRestricted = true;
      continue;
    }
    if (publishingRestricted) return undefined;
    if (
      !/^\s*(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?review\b/i.test(
        input.text,
      )
    ) {
      source = undefined;
      continue;
    }
    const urls = input.text.match(/https:\/\/[^\s<>"')]+/g) ?? [];
    const targets = urls
      .map(targetFromUrl)
      .filter((item): item is ReviewPublicationTarget => Boolean(item));
    const named = new RegExp(
      `(?:^|[^\\w./-])${target.repository.replace(/\./g, "\\.")}(?:$|[^\\w./-])`,
      "i",
    ).test(input.text);
    const numbered =
      /\b(?:PR|pull request)\s*#?(\d+)\b/i.exec(input.text)?.[1] ===
      String(target.pr);
    source =
      targets.some((item) => targetKey(item) === targetKey(target)) ||
      (target.host === "github.com" && named && numbered)
        ? input.id
        : undefined;
  }
  return source && source === inputs.at(-1)?.id ? [source] : undefined;
}

function capturePayloadFiles(
  action: ParsedGhAction,
  request: ReviewPublicationRequest,
):
  | Pick<ReviewPublicationContext, "payloadFiles" | "payloadPreviews">
  | undefined {
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
        ])
      )
        return undefined;
      const stat = fs.statSync(resolved);
      bytes += stat.size;
      if (!stat.isFile() || bytes > MAX_PAYLOAD_BYTES) return undefined;
      const fd = fs.openSync(resolved, "r");
      let content: Buffer;
      try {
        const buffer = Buffer.alloc(stat.size + 1);
        const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (read !== stat.size) return undefined;
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
        const payload: unknown = JSON.parse(content.toString("utf8"));
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
          return undefined;
      }
      files.push({
        reference,
        path: resolved,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
      previews.push({ reference, content: content.toString("utf8") });
    } catch {
      return undefined;
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
  const prepare = (
    request: ReviewPublicationRequest,
  ): ReviewPublicationContext | undefined => {
    try {
      const snapshot = options.getSessionSnapshot(request.sessionId);
      if (
        !snapshot?.builtinReview ||
        !snapshot.foreground ||
        request.signal?.aborted ||
        request.hasEnvOverrides ||
        request.environmentOpaque ||
        !isCommandPathInsideWorkspace(request.cwd, request.workspaceRoots) ||
        snapshot.humanInputRevision !== request.humanInputRevision
      )
        return undefined;
      const inputs = scopeInputs(snapshot);
      if (!inputs) return undefined;
      const action = parseGhAction(
        request.command,
        process.env.GH_HOST || "github.com",
      );
      if (!action || action.kind === "read") return undefined;
      const facts = sessions.get(request.sessionId);
      const receipt =
        action.id && action.endpoint
          ? facts?.receipts.get(
              `${receiptFamily(action.endpoint)}:${action.id}`,
            )
          : undefined;
      const target = action.target ?? receipt?.target;
      if (
        !target ||
        facts?.prs.get(targetKey(target))?.revision !==
          request.humanInputRevision
      )
        return undefined;

      if (receipt && action.endpoint) {
        const repository = /^repos\/([\w.-]+\/[\w.-]+)\//
          .exec(action.endpoint)?.[1]
          ?.toLowerCase();
        if (
          repository !== receipt.target.repository ||
          action.host !== receipt.target.host
        )
          return undefined;
      }
      const sourceInputIds = authorisedTarget(inputs, target);
      if (!sourceInputIds) return undefined;
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
        return undefined;
      const payloadEvidence = capturePayloadFiles(action, request);
      if (!payloadEvidence) return undefined;
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
        return undefined;
      if (
        action.kind === "submit_review" &&
        (Object.keys(payload).some((key) => !["body", "event"].includes(key)) ||
          !["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(
            String(payload.event),
          ))
      )
        return undefined;
      if (
        action.kind === "review" &&
        payload.event !== undefined &&
        !["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(
          String(payload.event),
        )
      )
        return undefined;
      return {
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
      };
    } catch {
      return undefined;
    }
  };
  return {
    prepare,
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
        if (
          action.kind === "read" &&
          urlTarget &&
          action.target &&
          targetKey(urlTarget) === targetKey(action.target) &&
          value.number === action.target.pr &&
          (action.endpoint
            ? /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+$/.test(action.endpoint)
            : true)
        ) {
          if (facts.prs.size >= MAX_RECEIPTS)
            facts.prs.delete(facts.prs.keys().next().value!);
          facts.prs.set(targetKey(urlTarget), {
            target: urlTarget,
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
