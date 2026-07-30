import type {
  AgentBudget,
  SpawnBackgroundRequest,
} from "../core/capabilities/background.js";

export type FleetWorkflowKind =
  | "structured_diff_review"
  | "browser_verification"
  | "best_of_n"
  | "persistent_goal";

export interface FleetWorkflowRequest {
  kind: FleetWorkflowKind;
  task: string;
  message: string;
  candidates?: Array<{ model?: string; provider?: string }>;
  goalId?: string;
  budget?: AgentBudget;
}

export interface FleetWorkflowPlan {
  workflowId: string;
  goalId?: string;
  delegations: SpawnBackgroundRequest[];
}

export interface FleetWorkflowOutcome {
  workflowId: string;
  kind: FleetWorkflowKind;
  completed: boolean;
  candidates: Array<{
    sessionId: string;
    result: FleetResultEnvelope;
    worktreePath?: string;
    worktreeBranch?: string;
    score?: number;
  }>;
  winnerSessionId?: string;
  summary: string;
}

/** Builds higher-autonomy workflows exclusively from normal fleet delegations. */
export function planFleetWorkflow(
  request: FleetWorkflowRequest,
): FleetWorkflowPlan {
  const workflowId = globalThis.crypto.randomUUID();
  const goalId =
    request.kind === "persistent_goal"
      ? request.goalId?.trim() || `goal:${workflowId}`
      : request.goalId?.trim() || undefined;
  const base: SpawnBackgroundRequest = {
    task: request.task,
    message: request.message,
    goalId,
    budget: request.budget,
  };
  if (request.kind === "structured_diff_review") {
    return {
      workflowId,
      goalId,
      delegations: [
        {
          ...base,
          mode: "review",
          taskClass: "review_code",
          permissionProfile: "review-only",
          expectedResult: "review_findings",
        },
      ],
    };
  }
  if (request.kind === "browser_verification") {
    return {
      workflowId,
      goalId,
      delegations: [
        {
          ...base,
          mode: "code",
          taskClass: "verification",
          permissionProfile: "workspace-safe",
          expectedResult: "verification",
        },
      ],
    };
  }
  if (request.kind === "best_of_n") {
    const candidates = request.candidates?.length
      ? request.candidates
      : [{}, {}];
    return {
      workflowId,
      goalId,
      delegations: candidates.map((candidate, index) => ({
        ...base,
        task: `${request.task} · candidate ${index + 1}`,
        mode: "code",
        model: candidate.model,
        provider: candidate.provider,
        expectedResult: "patch",
      })),
    };
  }
  return {
    workflowId,
    goalId,
    delegations: [
      {
        ...base,
        mode: "code",
        taskClass: "general",
        permissionProfile: "workspace-safe",
        budget: request.budget
          ? { ...request.budget, scope: "goal" }
          : undefined,
      },
    ],
  };
}

export type FleetResultEnvelope =
  | { type: "text"; text: string }
  | {
      type: "review_findings";
      findings: Array<{
        severity: "critical" | "high" | "medium" | "low";
        message: string;
        path?: string;
        line?: number;
      }>;
      /** What was actually reviewed, e.g. a commit range or file list. */
      reviewedScope?: string;
      /** True when the requested diff was empty or missing, so an empty findings list is not a clean review. */
      emptyDiff?: boolean;
    }
  | { type: "patch"; summary: string; files: string[]; verification?: string }
  | {
      type: "verification";
      passed: boolean;
      summary: string;
      screenshots?: string[];
      logs?: string[];
    };

const MAX_FLEET_RESULT_FENCES = 32;
const MAX_FLEET_RESULT_FENCE_BODY_CHARS = 1_000_000;

interface MarkdownFence {
  character: "`" | "~";
  length: number;
  accepted: boolean;
  body: string[];
  bodyChars: number;
}

type ExpectedFleetResult = Exclude<
  SpawnBackgroundRequest["expectedResult"],
  "text" | undefined
>;

export interface FleetEnvelopeParseOptions {
  /** Absolute workspace roots used to normalize absolute finding paths. */
  workspaceRoots?: readonly string[];
}

type CandidateOutcome =
  | { ok: true; envelope: FleetResultEnvelope }
  | { ok: false; reason: string };

const SEVERITY_SYNONYMS: Record<
  string,
  "critical" | "high" | "medium" | "low"
> = {
  critical: "critical",
  blocker: "critical",
  fatal: "critical",
  p0: "critical",
  high: "high",
  major: "high",
  error: "high",
  p1: "high",
  medium: "medium",
  moderate: "medium",
  warning: "medium",
  warn: "medium",
  p2: "medium",
  low: "low",
  minor: "low",
  info: "low",
  informational: "low",
  suggestion: "low",
  nit: "low",
  note: "low",
  style: "low",
  p3: "low",
};

function normalizeEnvelopeType(value: unknown): string | undefined {
  return typeof value === "string"
    ? value.trim().toLowerCase().replaceAll("-", "_")
    : undefined;
}

/**
 * Coerce a finding path toward workspace-relative form: strip a matching
 * workspace-root prefix from absolute paths. Paths that stay absolute or
 * traverse upward are dropped (the finding keeps its message) rather than
 * invalidating the whole envelope.
 */
function normalizeFindingPath(
  raw: unknown,
  workspaceRoots: readonly string[],
): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const candidate = raw.trim().replaceAll("\\", "/");
  if (isWorkspaceRelativeArtifact(candidate)) return candidate;
  const comparisonKey = (value: string): string =>
    process.platform === "win32" ? value.toLowerCase() : value;
  for (const root of workspaceRoots) {
    const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/, "");
    if (
      comparisonKey(candidate).startsWith(`${comparisonKey(normalizedRoot)}/`)
    ) {
      const relative = candidate.slice(normalizedRoot.length + 1);
      if (isWorkspaceRelativeArtifact(relative)) return relative;
    }
  }
  return undefined;
}

/**
 * Tolerant interpretation of a review_findings candidate. Agents routinely
 * deviate in ways that do not reduce the review's substance — synonym
 * severities ("warning", "nit"), absolute paths, zero/float line numbers —
 * and rejecting the entire envelope for those loses structured integration.
 * Normalize what can be normalized; only structural absence (no findings
 * array, findings without a message) fails the candidate.
 */
function interpretReviewFindingsCandidate(
  value: Record<string, unknown>,
  options: FleetEnvelopeParseOptions,
): CandidateOutcome {
  if (!Array.isArray(value.findings)) {
    return { ok: false, reason: "findings is not an array" };
  }
  const findings: Array<{
    severity: "critical" | "high" | "medium" | "low";
    message: string;
    path?: string;
    line?: number;
  }> = [];
  for (const [index, rawFinding] of value.findings.entries()) {
    if (!rawFinding || typeof rawFinding !== "object") {
      return { ok: false, reason: `findings[${index}] is not an object` };
    }
    const item = rawFinding as Record<string, unknown>;
    if (typeof item.message !== "string" || !item.message.trim()) {
      return {
        ok: false,
        reason: `findings[${index}].message is missing or empty`,
      };
    }
    const severity =
      SEVERITY_SYNONYMS[String(item.severity).trim().toLowerCase()] ?? "medium";
    const path = normalizeFindingPath(item.path, options.workspaceRoots ?? []);
    const line =
      typeof item.line === "number" || typeof item.line === "string"
        ? Number(item.line)
        : undefined;
    const validLine =
      line !== undefined && Number.isInteger(line) && line > 0
        ? line
        : undefined;
    findings.push({
      severity,
      message: item.message,
      ...(path ? { path } : {}),
      ...(validLine !== undefined ? { line: validLine } : {}),
    });
  }
  const emptyDiff =
    typeof value.emptyDiff === "boolean"
      ? value.emptyDiff
      : typeof value.emptyDiff === "string" &&
          ["true", "yes"].includes(value.emptyDiff.trim().toLowerCase())
        ? true
        : typeof value.emptyDiff === "string" &&
            ["false", "no"].includes(value.emptyDiff.trim().toLowerCase())
          ? false
          : undefined;
  return {
    ok: true,
    envelope: {
      type: "review_findings",
      findings,
      ...(typeof value.reviewedScope === "string"
        ? { reviewedScope: value.reviewedScope }
        : {}),
      ...(emptyDiff !== undefined ? { emptyDiff } : {}),
    },
  };
}

function interpretFleetResultCandidate(
  expected: ExpectedFleetResult,
  value: unknown,
  options: FleetEnvelopeParseOptions,
): CandidateOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "candidate is not a JSON object" };
  }
  const record = value as Record<string, unknown>;
  const type = normalizeEnvelopeType(record.type);
  if (type !== expected) {
    return {
      ok: false,
      reason: `candidate type is ${JSON.stringify(record.type)}, expected "${expected}"`,
    };
  }
  if (expected === "review_findings") {
    return interpretReviewFindingsCandidate(record, options);
  }
  const normalized = { ...record, type };
  if (isFleetResultEnvelope(normalized)) {
    return { ok: true, envelope: normalized as FleetResultEnvelope };
  }
  return {
    ok: false,
    reason: `candidate has type "${expected}" but does not match the ${expected} envelope schema`,
  };
}

function parseExpectedFleetResult(
  expected: ExpectedFleetResult,
  text: string,
  options: FleetEnvelopeParseOptions,
): CandidateOutcome | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return interpretFleetResultCandidate(expected, parsed, options);
  } catch {
    return undefined;
  }
}

function extractFleetResultFenceBodies(text: string): {
  bodies: string[];
  overflowed: boolean;
} {
  const bodies: string[] = [];
  let fence: MarkdownFence | undefined;
  const flushFence = (current: MarkdownFence): boolean => {
    if (
      current.accepted &&
      current.body.length > 0 &&
      current.bodyChars <= MAX_FLEET_RESULT_FENCE_BODY_CHARS
    ) {
      bodies.push(current.body.join("\n"));
      if (bodies.length > MAX_FLEET_RESULT_FENCES) return false;
    }
    return true;
  };

  for (const line of text.split(/\r?\n/)) {
    if (fence) {
      const closer = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if (
        closer?.[1]?.[0] === fence.character &&
        closer[1].length >= fence.length
      ) {
        if (!flushFence(fence)) return { bodies: [], overflowed: true };
        fence = undefined;
      } else if (fence.accepted) {
        fence.bodyChars += line.length + 1;
        if (fence.bodyChars <= MAX_FLEET_RESULT_FENCE_BODY_CHARS) {
          fence.body.push(line);
        }
      }
      continue;
    }

    const opener = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/);
    if (!opener?.[1]) continue;
    const rawInfo = opener[2]?.trim() ?? "";
    // Accept bare fences, json-family info strings (json, jsonc, json5),
    // and fences whose opener line already carries the payload — models
    // frequently emit "```json {...}" or "```{...}" on one line.
    const infoMatch = rawInfo.match(/^(?:json[a-z0-9]*)?\s*(.*)$/i);
    const inlinePayload = infoMatch?.[1] ?? "";
    const accepted =
      rawInfo === "" ||
      /^json[a-z0-9]*$/i.test(rawInfo) ||
      ((/^json[a-z0-9]*\s/i.test(rawInfo) || rawInfo.startsWith("{")) &&
        inlinePayload.startsWith("{"));
    const character = opener[1][0] as "`" | "~";
    // A one-line fence ("```json {...}```") closes on its opener line.
    const inlineClose = inlinePayload.match(/^(.*?)(`{3,}|~{3,})[ \t]*$/);
    if (accepted && inlineClose && inlineClose[2][0] === character) {
      const payload = inlineClose[1].trim();
      if (payload) {
        bodies.push(payload);
        if (bodies.length > MAX_FLEET_RESULT_FENCES) {
          return { bodies: [], overflowed: true };
        }
      }
      continue;
    }
    fence = {
      character,
      length: opener[1].length,
      accepted,
      body: accepted && inlinePayload ? [inlinePayload] : [],
      bodyChars: inlinePayload ? inlinePayload.length + 1 : 0,
    };
  }

  // A final unclosed fence still contributes: truncation or a stream cut can
  // eat the closing fence of the envelope the agent actually produced.
  if (fence && !flushFence(fence)) return { bodies: [], overflowed: true };

  return { bodies, overflowed: false };
}

const MAX_BRACE_SCAN_CANDIDATES = 8;

/** Extract a balanced JSON object starting at `start`, string-aware. */
function extractBalancedJsonObject(
  text: string,
  start: number,
): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  const limit = Math.min(
    text.length,
    start + MAX_FLEET_RESULT_FENCE_BODY_CHARS,
  );
  for (let index = start; index < limit; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

export interface FleetEnvelopeParseResult {
  envelope: FleetResultEnvelope;
  /** Why no candidate was accepted, when the expected envelope is missing. */
  issue?: string;
}

export function parseFleetResultEnvelopeDetailed(
  expected: SpawnBackgroundRequest["expectedResult"],
  text: string,
  options: FleetEnvelopeParseOptions = {},
): FleetEnvelopeParseResult {
  if (!expected || expected === "text") {
    return { envelope: { type: "text", text } };
  }

  const failures: string[] = [];
  const record = (outcome: CandidateOutcome | undefined): void => {
    if (outcome && !outcome.ok && !failures.includes(outcome.reason)) {
      failures.push(outcome.reason);
    }
  };

  const exact = parseExpectedFleetResult(expected, text, options);
  if (exact?.ok) return { envelope: exact.envelope };
  record(exact);

  const fenced = extractFleetResultFenceBodies(text);
  if (!fenced.overflowed) {
    // Prefer the last valid candidate: when an agent repeats or revises the
    // envelope, the final occurrence is its answer.
    let lastValid: FleetResultEnvelope | undefined;
    for (const body of fenced.bodies) {
      const outcome = parseExpectedFleetResult(expected, body.trim(), options);
      if (outcome?.ok) lastValid = outcome.envelope;
      else record(outcome);
    }
    if (lastValid) return { envelope: lastValid };
  }

  // Last resort, only when no json-labeled fence produced a candidate at all:
  // balanced JSON objects announcing a "type" field in plain text, newest
  // first. This rescues envelopes behind a truncated or mislabeled opening
  // fence without second-guessing messages whose fenced JSON simply failed.
  if (fenced.overflowed || fenced.bodies.length === 0) {
    const starts: number[] = [];
    for (const match of text.matchAll(/\{\s*"type"\s*:/g)) {
      starts.push(match.index);
    }
    for (const start of starts.slice(-MAX_BRACE_SCAN_CANDIDATES).reverse()) {
      const candidate = extractBalancedJsonObject(text, start);
      if (!candidate) continue;
      const outcome = parseExpectedFleetResult(expected, candidate, options);
      if (outcome?.ok) return { envelope: outcome.envelope };
      record(outcome);
    }
  }

  return {
    envelope: { type: "text", text },
    issue: failures.length
      ? `Envelope candidates were found but rejected: ${failures.slice(0, 3).join("; ")}`
      : `No ${expected} envelope candidate was found in the final output`,
  };
}

export function parseFleetResultEnvelope(
  expected: SpawnBackgroundRequest["expectedResult"],
  text: string,
  options: FleetEnvelopeParseOptions = {},
): FleetResultEnvelope {
  return parseFleetResultEnvelopeDetailed(expected, text, options).envelope;
}

export function isFleetResultEnvelope(
  value: unknown,
): value is FleetResultEnvelope {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  if (result.type === "text") return typeof result.text === "string";
  if (result.type === "patch") {
    return (
      typeof result.summary === "string" &&
      isStringArray(result.files) &&
      result.files.every(isWorkspaceRelativeArtifact) &&
      (result.verification === undefined ||
        typeof result.verification === "string")
    );
  }
  if (result.type === "verification") {
    return (
      typeof result.passed === "boolean" &&
      typeof result.summary === "string" &&
      (result.screenshots === undefined ||
        (isStringArray(result.screenshots) &&
          result.screenshots.every(isWorkspaceRelativeArtifact))) &&
      (result.logs === undefined || isStringArray(result.logs))
    );
  }
  if (result.type === "review_findings") {
    return (
      (result.reviewedScope === undefined ||
        typeof result.reviewedScope === "string") &&
      (result.emptyDiff === undefined ||
        typeof result.emptyDiff === "boolean") &&
      Array.isArray(result.findings) &&
      result.findings.every((finding) => {
        if (!finding || typeof finding !== "object") return false;
        const item = finding as Record<string, unknown>;
        return (
          ["critical", "high", "medium", "low"].includes(
            String(item.severity),
          ) &&
          typeof item.message === "string" &&
          (item.path === undefined ||
            (typeof item.path === "string" &&
              isWorkspaceRelativeArtifact(item.path))) &&
          (item.line === undefined ||
            (typeof item.line === "number" &&
              Number.isInteger(item.line) &&
              item.line > 0))
        );
      })
    );
  }
  return false;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isWorkspaceRelativeArtifact(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !/^[a-zA-Z]:\//.test(normalized) &&
    !normalized.split("/").includes("..")
  );
}

export function scoreFleetCandidate(result: FleetResultEnvelope): number {
  if (result.type === "patch") {
    return 100 + result.files.length * 5 + (result.verification ? 25 : 0);
  }
  if (result.type === "verification") {
    return (
      (result.passed ? 100 : 0) +
      (result.screenshots?.length ?? 0) * 5 +
      (result.logs?.length ?? 0)
    );
  }
  if (result.type === "review_findings") {
    if (result.emptyDiff) return 0;
    return Math.max(0, 50 - result.findings.length);
  }
  return Math.min(25, result.text.trim().length / 100);
}

/** Convert a validated background result into readable coordinator/UI text. */
export function formatFleetResultEnvelope(result: FleetResultEnvelope): string {
  if (result.type === "text") return result.text;
  if (result.type === "patch") {
    const lines = [result.summary];
    if (result.files.length > 0) {
      lines.push(
        "",
        "**Files**",
        ...result.files.map((file) => `- \`${file}\``),
      );
    }
    if (result.verification) {
      lines.push("", "**Verification**", result.verification);
    }
    return lines.join("\n");
  }
  if (result.type === "verification") {
    const lines = [
      `**Verification ${result.passed ? "passed" : "failed"}**`,
      "",
      result.summary,
    ];
    if (result.screenshots?.length) {
      lines.push(
        "",
        "**Screenshots**",
        ...result.screenshots.map((file) => `- \`${file}\``),
      );
    }
    if (result.logs?.length) {
      lines.push("", "**Evidence**", ...result.logs.map((log) => `- ${log}`));
    }
    return lines.join("\n");
  }

  const lines: string[] = [];
  if (result.emptyDiff) {
    lines.push("**Review could not resolve a change set.**");
  } else if (result.findings.length === 0) {
    lines.push("**Review found no issues.**");
  } else {
    lines.push(
      `**Review found ${result.findings.length} issue${result.findings.length === 1 ? "" : "s"}.**`,
    );
  }
  if (result.reviewedScope) {
    lines.push("", `**Reviewed scope:** ${result.reviewedScope}`);
  }
  if (result.findings.length > 0) {
    lines.push("", "**Findings**");
    for (const finding of result.findings) {
      const location = finding.path
        ? ` — \`${finding.path}${finding.line ? `:${finding.line}` : ""}\``
        : "";
      lines.push(
        `- **${finding.severity.toUpperCase()}**${location}: ${finding.message}`,
      );
    }
  }
  return lines.join("\n");
}

export function withFleetResultInstruction(
  expected: SpawnBackgroundRequest["expectedResult"],
  message: string,
): string {
  if (!expected || expected === "text") return message;
  const shapes = {
    review_findings:
      '{"type":"review_findings","findings":[{"severity":"critical|high|medium|low","message":"...","path":"optional","line":1}],"reviewedScope":"what was actually reviewed, e.g. a commit range or file list","emptyDiff":false}',
    patch:
      '{"type":"patch","summary":"...","files":["..."],"verification":"optional"}',
    verification:
      '{"type":"verification","passed":true,"summary":"...","screenshots":["optional paths"],"logs":["optional evidence"]}',
  } as const;
  const guidance =
    expected === "review_findings"
      ? " Before reviewing, resolve the exact change set you were asked to review and describe it in reviewedScope. If that change set is empty or cannot be found (for example the changes were already committed, stashed, or reverted), set emptyDiff to true and explain what you checked in reviewedScope — never return an empty findings list that is indistinguishable from a clean review."
      : "";
  return `${message}\n\nReturn the final answer as JSON matching this exact result envelope: ${shapes[expected]}${guidance} End your final message with exactly one \`\`\`json fenced block containing only this envelope — no prose after the closing fence, and do not repeat the envelope elsewhere.`;
}
