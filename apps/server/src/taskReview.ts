import type { ReviewFinding, TaskRun } from "./taskStore.js";

import type { AgentModelReference } from "@agentlink/core";
import type { TaskDiff } from "./taskWorkspace.js";

/**
 * Cross-provider review of a task's exact commit. The reviewer is a
 * separate chat in the task's clone, on a model from a different provider
 * than the implementer, that may read files but not change anything. It
 * ends its answer with a JSON block of findings, parsed here.
 */

const MAX_FINDINGS = 50;
const MAX_REASON_LENGTH = 1_000;
const MAX_FILE_LENGTH = 300;

export interface ReviewResult {
  readonly verdict: "approve" | "changes_requested";
  readonly findings: readonly ReviewFinding[];
}

/**
 * The reviewer for an implementer: the `review` role's model when it is on
 * another provider, otherwise the first configured model that is.
 */
export function pickReviewModel(
  implementer: AgentModelReference,
  options: {
    readonly roleModel?: AgentModelReference | undefined;
    readonly available: readonly AgentModelReference[];
  },
): AgentModelReference | undefined {
  const candidates = [
    ...(options.roleModel ? [options.roleModel] : []),
    ...options.available,
  ];
  return candidates.find(
    (model) => model.providerId !== implementer.providerId,
  );
}

export function reviewPrompt(
  task: TaskRun,
  diff: TaskDiff,
  validation: readonly string[] = [],
): string {
  return [
    "You are reviewing a change made by another AI model for this task. You did not write it. Review it as a careful senior engineer.",
    "",
    "Task objective:",
    task.objective,
    "",
    ...(validation.length > 0
      ? [
          "The repository owner requires these validation commands to pass, and they pass on this commit. Changes needed to satisfy them are in scope, so do not ask for them to be removed:",
          ...validation.map((command) => `$ ${command}`),
          "",
        ]
      : []),
    `The change is ${task.baseCommit ?? "the base"}..${task.headCommit ?? "HEAD"} on branch ${task.branch}, checked out in this folder. You may read any file here for context. Do not edit files, run commands or start other agents: those requests will be refused.`,
    "",
    "Changed files:",
    diff.stat || "(none)",
    "",
    "Diff:",
    "```diff",
    diff.patch,
    "```",
    ...(diff.truncated
      ? ["(The diff was cut short; read the changed files for the rest.)"]
      : []),
    "",
    "Report only real problems: bugs, missing or wrong behaviour against the objective, broken or missing tests for changed behaviour, and security issues. Mark a finding `blocking` only when the change should not be merged as it is; style preferences are `suggestion`s.",
    "",
    "End your answer with exactly one fenced JSON block in this form, and nothing after it:",
    "```json",
    '{"verdict":"approve","findings":[{"severity":"suggestion","file":"src/example.ts","line":12,"reason":"why"}]}',
    "```",
    'Use "changes_requested" when there is at least one blocking finding, otherwise "approve". `file` and `line` are optional.',
  ].join("\n");
}

export const REVIEW_RETRY_PROMPT =
  'Your answer did not end with a readable JSON block. Reply with only the fenced JSON block: {"verdict":"approve"|"changes_requested","findings":[{"severity":"blocking"|"suggestion","file"?:string,"line"?:number,"reason":string}]}';

/** The findings at the end of a reviewer's answer, or undefined. */
export function parseReview(
  text: string | undefined,
): ReviewResult | undefined {
  if (!text) return undefined;
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gu)].map(
    (match) => match[1]!,
  );
  for (const candidate of [...blocks.reverse(), text.trim()]) {
    const parsed = readReview(candidate);
    if (parsed) return parsed;
  }
  return undefined;
}

function readReview(candidate: string): ReviewResult | undefined {
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.findings)) return undefined;
  const findings: ReviewFinding[] = [];
  for (const entry of raw.findings.slice(0, MAX_FINDINGS)) {
    if (!entry || typeof entry !== "object") return undefined;
    const finding = entry as Record<string, unknown>;
    if (finding.severity !== "blocking" && finding.severity !== "suggestion") {
      return undefined;
    }
    if (typeof finding.reason !== "string" || !finding.reason.trim()) {
      return undefined;
    }
    findings.push({
      severity: finding.severity,
      ...(typeof finding.file === "string" && finding.file.trim()
        ? { file: finding.file.trim().slice(0, MAX_FILE_LENGTH) }
        : {}),
      ...(typeof finding.line === "number" &&
      Number.isInteger(finding.line) &&
      finding.line > 0
        ? { line: finding.line }
        : {}),
      reason: finding.reason.trim().slice(0, MAX_REASON_LENGTH),
    });
  }
  // Any blocking finding requests changes, whatever the verdict says.
  const verdict = findings.some((finding) => finding.severity === "blocking")
    ? "changes_requested"
    : raw.verdict === "approve" || raw.verdict === "changes_requested"
      ? raw.verdict
      : undefined;
  if (!verdict) return undefined;
  return { verdict, findings };
}

export function describeFinding(finding: ReviewFinding): string {
  const where = finding.file
    ? `${finding.file}${finding.line ? `:${finding.line}` : ""}: `
    : "";
  return `- [${finding.severity}] ${where}${finding.reason}`;
}
