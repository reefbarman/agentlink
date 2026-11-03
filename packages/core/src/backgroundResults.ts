import type { FleetResultEnvelope } from "@agentlink/protocol/fleet-result";
import { setTaskStatusToolDefinition } from "./interactionTools.js";
import type { CoreModelToolDefinition as ToolDefinition } from "./modelRuntime.js";
import { z } from "zod";

/**
 * VS Code's structured background results: the `expectedResult` envelope
 * schemas, the background `set_task_status` that returns one, the tolerant
 * parse of an envelope printed in final text, and the coordinator-facing
 * formatting. Hosts decide when a child finished; these keep what counts as
 * a valid result, and what the parent reads, the same on every surface.
 * Browser-safe.
 */

// --- Envelope schemas --------------------------------------------------------

const artifactPath = z
  .string()
  .min(1)
  .regex(
    /^(?![\\/])(?![a-zA-Z]:[\\/])(?![\s\S]*(?:^|[\\/])\.\.(?:[\\/]|$))/,
    "Use a non-empty workspace-relative path without '..' segments",
  )
  .describe("Non-empty workspace-relative path without '..' segments");

const emptyDiff = z
  .boolean()
  .describe(
    "Set true when the requested live diff or range is empty or unavailable; the runtime attributes the normalized target automatically.",
  );

export function isWorkspaceRelativeArtifact(value: string): boolean {
  return artifactPath.safeParse(value).success;
}

/** Shared by advertised tool schemas and result validation. Keep legacy extra fields. */
export const fleetResultSchemas = {
  text: z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
  review_findings: z
    .object({
      type: z.literal("review_findings"),
      findings: z.array(
        z
          .object({
            severity: z.enum(["critical", "high", "medium", "low"]),
            message: z.string(),
            path: artifactPath.optional(),
            line: z.number().int().positive().optional(),
          })
          .passthrough(),
      ),
      reviewedScope: z
        .string()
        .describe(
          "Optional override when the reviewed scope materially differs from the runtime target",
        )
        .optional(),
      checked: z
        .array(z.string())
        .describe(
          "Optional short notes on what you checked and the evidence (file:line), including items that were fine",
        )
        .optional(),
      limitations: z
        .array(z.string())
        .describe(
          "Checks you could not run or scope you could not cover, such as a command blocked by policy",
        )
        .optional(),
      emptyDiff: emptyDiff.optional(),
    })
    .passthrough(),
  patch: z
    .object({
      type: z.literal("patch"),
      summary: z.string(),
      files: z.array(artifactPath),
      verification: z.string().optional(),
    })
    .passthrough(),
  verification: z
    .object({
      type: z.literal("verification"),
      passed: z.boolean(),
      summary: z.string(),
      screenshots: z.array(artifactPath).optional(),
      logs: z.array(z.string()).optional(),
    })
    .passthrough(),
};

export type FleetResultType = keyof typeof fleetResultSchemas;

/** VS Code's `expectedResult` values for `spawn_background_agent`. */
export type BackgroundExpectedResult = FleetResultType;

const fleetResultSchema = z.discriminatedUnion("type", [
  fleetResultSchemas.text,
  fleetResultSchemas.review_findings,
  fleetResultSchemas.patch,
  fleetResultSchemas.verification,
]);

export function getFleetResultSchema(expected?: FleetResultType) {
  if (expected === "review_findings") {
    // Legacy persisted reviews may omit this; new expected review completions may not.
    return fleetResultSchemas.review_findings.extend({
      emptyDiff,
    });
  }
  return expected ? fleetResultSchemas[expected] : fleetResultSchema;
}

export function validateFleetResult(
  value: unknown,
  expected?: FleetResultType,
): Array<{ path: string; message: string }> {
  const parsed = getFleetResultSchema(expected).safeParse(value);
  if (parsed.success) return [];
  // Bound the response and never include submitted values or unknown key names.
  return parsed.error.issues.slice(0, 8).map((issue) => ({
    path: ["result", ...issue.path].join("."),
    message: issue.message,
  }));
}

export function isFleetResultEnvelope(
  value: unknown,
): value is FleetResultEnvelope {
  return validateFleetResult(value).length === 0;
}

/** Keeps prose-only findings and blocked validation out of a clean verdict. */
const REVIEW_FINDINGS_COMPLETENESS_GUIDANCE =
  "Every issue you identify, including ones you mention in prose, must be a findings entry; an empty findings list means you found nothing. List checks or commands you could not run (for example blocked by policy) in limitations.";

// --- Background set_task_status ---------------------------------------------

/**
 * VS Code's `set_task_status` for a background agent: the base tool plus a
 * `result` envelope, typed to the delegated `expectedResult` when there is one.
 */
export function backgroundSetTaskStatusTool(
  expectedResult?: BackgroundExpectedResult,
  options: { readonly askUser?: boolean } = {},
): ToolDefinition {
  const base = setTaskStatusToolDefinition({
    askUser: options.askUser ?? true,
  });
  const { $schema: _, ...resultSchema } = z.toJSONSchema(
    getFleetResultSchema(expectedResult),
  );
  const resultGuidance = expectedResult
    ? `This background task expects a structured ${expectedResult} result; include it in the result field when completing the task instead of printing serialized JSON in assistant text.${expectedResult === "review_findings" ? ` ${REVIEW_FINDINGS_COMPLETENESS_GUIDANCE}` : ""}`
    : "For coordinator-facing information or summaries, you may return a structured result instead of serializing data into assistant text.";
  return {
    ...base,
    description: `${base.description} ${resultGuidance} The result field is the coordinator-facing output, so summary may be omitted and should not duplicate it.`,
    input_schema: {
      ...base.input_schema,
      properties: {
        ...base.input_schema.properties,
        result: resultSchema,
      },
    },
  };
}

/** What a background `set_task_status` returns when its `result` is refused. */
export interface BackgroundTaskStatusResultRejection {
  readonly error: string;
  readonly issues?: ReadonlyArray<{ path: string; message: string }>;
}

/**
 * VS Code's check of a background `set_task_status` `result`. A refusal is
 * returned to the agent as an ordinary tool result (not an error), so it can
 * correct the envelope and call again; the status is not recorded.
 */
export function checkBackgroundTaskStatusResult(args: {
  readonly status: string;
  readonly result: unknown;
  readonly expectedResult?: BackgroundExpectedResult;
}): BackgroundTaskStatusResultRejection | undefined {
  const { status, result, expectedResult } = args;
  if (
    status === "completed" &&
    isFleetResultEnvelope(result) &&
    result.type === "text" &&
    !result.text.trim()
  ) {
    return {
      error:
        "Completion requires non-empty text in set_task_status.result.text",
    };
  }
  const requiredResult = status === "completed" ? expectedResult : undefined;
  if (requiredResult || result !== undefined) {
    const issues = validateFleetResult(result, requiredResult);
    if (issues.length) {
      return {
        error: requiredResult
          ? `Background completion requires a valid ${requiredResult} result in set_task_status.result`
          : "Invalid structured result",
        issues,
      };
    }
  }
  return undefined;
}

// --- Failure explanations ----------------------------------------------------

/** Why a run that owed a final text result is not a completed one. */
export const MISSING_TEXT_RESULT_ISSUE =
  "The agent stopped without a completed final text result. Any partial output is evidence only, not a completed review.";

/**
 * VS Code's `expectedResultIssue` for an `incomplete_expected_result`: no
 * final text, a provider stop, or a final message without the expected
 * envelope (with the parse issue, when one was found and rejected).
 */
export function describeExpectedResultIssue(args: {
  readonly expected: BackgroundExpectedResult | undefined;
  readonly missingTextResult: boolean;
  readonly providerStopReason?: string;
  /** The envelope type the final message parsed as. */
  readonly parsedType: FleetResultEnvelope["type"];
  readonly parseIssue?: string;
}): string {
  if (args.missingTextResult) return MISSING_TEXT_RESULT_ISSUE;
  if (args.providerStopReason) {
    return `The provider stopped before finalizing the result (${args.providerStopReason}). Partial output is not a completed result.`;
  }
  return `Expected a "${args.expected}" envelope; the final message parsed as ${
    args.parsedType === "text"
      ? "plain text without a valid envelope"
      : `a "${args.parsedType}" envelope`
  }.${args.parseIssue ? ` ${args.parseIssue}.` : ""} The raw final output is preserved in partialOutput.`;
}

// --- Envelopes printed in final text -----------------------------------------

const MAX_FLEET_RESULT_FENCES = 32;
const MAX_FLEET_RESULT_FENCE_BODY_CHARS = 1_000_000;

interface MarkdownFence {
  character: "`" | "~";
  length: number;
  accepted: boolean;
  body: string[];
  bodyChars: number;
}

type ExpectedFleetResult = Exclude<BackgroundExpectedResult, "text">;

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
  // Browser-safe: browser surfaces validate results without a `process`.
  const comparisonKey = (value: string): string =>
    globalThis.process?.platform === "win32" ? value.toLowerCase() : value;
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
  const checked = normalizeReviewChecked(value.checked);
  const limitations = normalizeReviewChecked(value.limitations);
  return {
    ok: true,
    envelope: {
      type: "review_findings",
      findings,
      ...(typeof value.reviewedScope === "string"
        ? { reviewedScope: value.reviewedScope }
        : {}),
      ...(checked.length > 0 ? { checked } : {}),
      ...(limitations.length > 0 ? { limitations } : {}),
      ...(emptyDiff !== undefined ? { emptyDiff } : {}),
    },
  };
}

export const MAX_REVIEW_CHECKED_ITEMS = 40;
export const MAX_REVIEW_CHECKED_ITEM_CHARS = 600;

/**
 * Keep the reviewer's coverage or limitation notes bounded. Accepts strings,
 * or objects with an item/check plus evidence/note, and drops anything else.
 */
function normalizeReviewChecked(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];
  const checked: string[] = [];
  for (const entry of raw) {
    if (checked.length >= MAX_REVIEW_CHECKED_ITEMS) break;
    let text: string | undefined;
    if (typeof entry === "string") {
      text = entry;
    } else if (entry && typeof entry === "object") {
      const item = entry as Record<string, unknown>;
      const label = [item.item, item.check, item.area].find(
        (part): part is string => typeof part === "string" && !!part.trim(),
      );
      const detail = [item.evidence, item.note, item.result].find(
        (part): part is string => typeof part === "string" && !!part.trim(),
      );
      text =
        label && detail ? `${label.trim()}: ${detail.trim()}` : label || detail;
    }
    const trimmed = text?.replace(/\s+/g, " ").trim();
    if (!trimmed) continue;
    checked.push(
      trimmed.length > MAX_REVIEW_CHECKED_ITEM_CHARS
        ? `${trimmed.slice(0, MAX_REVIEW_CHECKED_ITEM_CHARS - 1)}…`
        : trimmed,
    );
  }
  return checked;
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
  /** The agent's prose outside the accepted envelope, when there was any. */
  outsideText?: string;
}

/** Remove the accepted envelope (and its now-empty fence) from the final text. */
function textOutsideEnvelope(text: string, candidate: string): string {
  const index = text.lastIndexOf(candidate);
  if (index < 0) return "";
  return (text.slice(0, index) + text.slice(index + candidate.length))
    .replace(/^ {0,3}(`{3,}|~{3,})[^\r\n`~]*?\s*\1[ \t]*$/gm, "")
    .trim();
}

function acceptedEnvelope(
  text: string,
  candidate: string,
  envelope: FleetResultEnvelope,
): FleetEnvelopeParseResult {
  const outsideText = textOutsideEnvelope(text, candidate);
  return { envelope, ...(outsideText ? { outsideText } : {}) };
}

export function parseFleetResultEnvelopeDetailed(
  expected: BackgroundExpectedResult | undefined,
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
    let lastValid: { envelope: FleetResultEnvelope; body: string } | undefined;
    for (const body of fenced.bodies) {
      const outcome = parseExpectedFleetResult(expected, body.trim(), options);
      if (outcome?.ok) lastValid = { envelope: outcome.envelope, body };
      else record(outcome);
    }
    if (lastValid)
      return acceptedEnvelope(text, lastValid.body, lastValid.envelope);
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
      if (outcome?.ok)
        return acceptedEnvelope(text, candidate, outcome.envelope);
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
  expected: BackgroundExpectedResult | undefined,
  text: string,
  options: FleetEnvelopeParseOptions = {},
): FleetResultEnvelope {
  return parseFleetResultEnvelopeDetailed(expected, text, options).envelope;
}

// --- Coordinator-facing text -------------------------------------------------

export interface FleetResultFormatOptions {
  /**
   * The agent stopped before completing (blocked, interrupted, cancelled).
   * Empty review findings then mean "not finished", never "no issues".
   */
  incomplete?: boolean;
  /**
   * The reviewer's own prose outside the structured result (its summary or
   * surrounding text). Shown with a clean review so a finding stated only in
   * prose is not hidden behind "no issues".
   */
  reviewerNotes?: string;
}

export const MAX_REVIEWER_NOTES_CHARS = 2_000;

/** Convert a validated background result into readable coordinator/UI text. */
export function formatFleetResultEnvelope(
  result: FleetResultEnvelope,
  options: FleetResultFormatOptions = {},
): string {
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
  } else if (options.incomplete) {
    lines.push(
      result.findings.length === 0
        ? "**Review did not complete; this is not a clean result.**"
        : `**Review did not complete; ${result.findings.length} issue${result.findings.length === 1 ? "" : "s"} found before it stopped.**`,
    );
  } else if (result.findings.length === 0) {
    lines.push(
      result.limitations?.length
        ? "**Review found no issues in what it could verify; some checks did not run.**"
        : "**Review found no issues.**",
    );
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
  if (result.checked?.length) {
    lines.push("", "**Checked**", ...result.checked.map((item) => `- ${item}`));
  }
  if (result.limitations?.length) {
    lines.push(
      "",
      "**Not verified**",
      ...result.limitations.map((item) => `- ${item}`),
    );
  }
  const notes = options.reviewerNotes?.trim();
  if (notes && result.findings.length === 0 && !result.emptyDiff) {
    lines.push(
      "",
      "**Reviewer notes outside the structured result** (check these for issues not listed as findings)",
      notes.length > MAX_REVIEWER_NOTES_CHARS
        ? `${notes.slice(0, MAX_REVIEWER_NOTES_CHARS - 1)}…`
        : notes,
    );
  }
  return lines.join("\n");
}

/**
 * The envelope instruction VS Code appends for agents without AgentLink's
 * `set_task_status` (ACP agents), which must print the result instead.
 */
export function withFleetResultInstruction(
  expected: BackgroundExpectedResult | undefined,
  message: string,
): string {
  if (!expected || expected === "text") return message;
  const shapes = {
    review_findings:
      '{"type":"review_findings","findings":[{"severity":"critical|high|medium|low","message":"...","path":"optional","line":1}],"checked":["what you verified and the evidence (file:line)"],"limitations":["checks you could not run, if any"],"emptyDiff":false}',
    patch:
      '{"type":"patch","summary":"...","files":["..."],"verification":"optional"}',
    verification:
      '{"type":"verification","passed":true,"summary":"...","screenshots":["optional paths"],"logs":["optional evidence"]}',
  } as const;
  const guidance =
    expected === "review_findings"
      ? ` List the main things you checked in checked (short notes with file:line evidence, including areas that were fine) so a clean result shows its coverage. ${REVIEW_FINDINGS_COMPLETENESS_GUIDANCE} Set emptyDiff=true only when the requested live diff or range is empty or unavailable. The runtime already knows the target, so include reviewedScope only if you materially reviewed something different.`
      : "";
  return `${message}\n\nEnd with one JSON object matching this result envelope: ${shapes[expected]}${guidance} Do not repeat it or add prose after it.`;
}
