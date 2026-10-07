import type {
  ClassifiedCommand,
  CommandRiskCode,
} from "./commandTierClassifier.js";
import {
  DEFAULT_GUARDIAN_REVIEW_ATTEMPTS,
  DEFAULT_GUARDIAN_REVIEW_ATTEMPT_TIMEOUT_MS,
  DEFAULT_GUARDIAN_REVIEW_TIMEOUT_MS,
  GUARDIAN_INVALID_RESPONSE_RETRY_INSTRUCTION,
  isGuardianAttemptTimeoutError,
  runGuardianReviewAttempts,
} from "./guardianReview.js";

import type { AgentMessage } from "../agent/types.js";
import type { CommandReviewEvidence } from "./commandReviewEvidence.js";
import type { HumanDecisionRecordSnapshot } from "../agent/HumanDecisionRecord.js";
import type { InlineCommandFilePreview } from "../util/commandInlineFiles.js";
import type { MessageParam } from "../agent/providers/types.js";
import type { ModelProvider } from "../agent/providers/types.js";
import type { TerminalExecutionSecuritySummary } from "@agentlink/protocol/terminal-security";
import { createHash } from "crypto";
import {
  GUARDIAN_REVIEW_SYSTEM_PROMPT,
  getGuardianPolicy,
} from "./guardianPolicy.js";
import {
  completeGuardianCoverage,
  reportGuardianObservation,
  unknownGuardianCoverage,
  type GuardianEvidenceSourceMetadata,
  type GuardianProjectionManifest,
  type GuardianReviewObservation,
} from "./guardianReviewEvidence.js";
import {
  isReviewPublicationContextForInput,
  type ReviewPublicationContext,
} from "./reviewPublicationPolicy.js";

export const DEFAULT_COMMAND_REVIEW_TIMEOUT_MS =
  DEFAULT_GUARDIAN_REVIEW_TIMEOUT_MS;
export const MAX_COMMAND_REVIEW_ATTEMPTS = DEFAULT_GUARDIAN_REVIEW_ATTEMPTS;
const MAX_REASON_LENGTH = 500;
const MAX_CONTEXT_ENTRIES = 12;
const MAX_CONTEXT_ENTRY_LENGTH = 2_000;
const MAX_CONTEXT_LENGTH = 12_000;

export interface CommandAutoApprovalEligibilityInput {
  classified: ClassifiedCommand;
  cwd: string;
  workspaceRoots: string[];
  inlineFiles?: readonly InlineCommandFilePreview[];
  security?: TerminalExecutionSecuritySummary;
  hasEnvOverrides: boolean;
  forceRequested: boolean;
}

export type CommandAutoApprovalEligibility =
  | { eligible: true }
  | { eligible: false; reason: string };

export interface CommandApprovalReviewInput {
  sessionId: string;
  command: string;
  cwd: string;
  workspaceRoots: string[];
  reason?: string;
  userObjective?: string;
  context?: CommandReviewContextEntry[];
  classified: ClassifiedCommand;
  security?: TerminalExecutionSecuritySummary;
  inlineFiles?: readonly InlineCommandFilePreview[];
  evidence?: CommandReviewEvidence;
  signal?: AbortSignal;
  /** Host-generated before dispatch so primary and shadow results can be joined. */
  reviewId?: string;
  toolCallId?: string;
  /** Session human-input revision the supplied context reflects. */
  humanInputRevision?: number;
  evidenceMetadata?: GuardianEvidenceSourceMetadata;
  observe?: (observation: GuardianReviewObservation) => void;
  reviewPublicationContext?: ReviewPublicationContext;
}

export interface CommandReviewContextEntry {
  role: "user" | "assistant" | "tool";
  content: string;
  directUserInstruction?: boolean;
  humanDecisionEvidence?: boolean;
  /** Direct human submission queued mid-run and not yet in the transcript. */
  queuedHumanInput?: boolean;
}

const MAX_HUMAN_DECISION_ENTRIES = 8;
const MAX_HUMAN_DECISION_LENGTH = 8_000;

const HUMAN_DECISION_OMITTED_CONTENT = JSON.stringify({
  evidenceOmitted:
    "Older verified human input was omitted from review evidence or is no longer available. Earlier restrictions may still apply; do not infer consent from its absence, and clarify when it could matter.",
});

type HumanDecisionQuestionEvidence = NonNullable<
  AgentMessage["humanQuestionAnswers"]
>[number];

export type CommandReviewRisk = "low" | "medium" | "high" | "critical";
export type CommandReviewUserAuthorization =
  | "unknown"
  | "low"
  | "medium"
  | "high";
export type CommandReviewStatus =
  | "reviewed"
  | "unavailable"
  | "timed_out"
  | "cancelled"
  | "invalid";

export interface CommandApprovalReviewResult {
  outcome: "allow" | "deny";
  risk: CommandReviewRisk;
  userAuthorization: CommandReviewUserAuthorization;
  rationale: string;
  model: string;
  status: CommandReviewStatus;
}

export interface CommandApprovalReviewer {
  review(
    input: CommandApprovalReviewInput,
  ): Promise<CommandApprovalReviewResult>;
}

export interface CommandApprovalReviewerContext {
  provider: ModelProvider;
  sessionModel: string;
}

export interface CommandReviewCircuitDecision {
  explicitDenial: boolean;
  interrupted: boolean;
  consecutiveDenials: number;
  denialsInRecentWindow: number;
}

export interface CommandReviewTurnCircuit {
  readonly interrupted: boolean;
  record(result: CommandApprovalReviewResult): CommandReviewCircuitDecision;
  hasRejectedRecovery(actionKey: string): boolean;
  rejectRecovery(actionKey: string): void;
}

export function commandReviewActionKey(input: {
  command: string;
  cwd: string;
  security?: TerminalExecutionSecuritySummary;
}): string {
  return JSON.stringify({
    command: input.command,
    cwd: normalizeForCompare(input.cwd),
    route: input.security?.route ?? null,
    requiredAuthority: input.security?.requiredAuthority ?? null,
    permissionIntent: input.security?.permissionIntent ?? null,
    executionPreset: input.security?.executionPresetSnapshot ?? null,
  });
}

export interface RetainedCommandReviewDenials {
  has(sessionId: string, actionKey: string): boolean;
  retain(sessionId: string, actionKey: string): void;
  clear(sessionId: string, actionKey: string): void;
  clearSession(sessionId: string): void;
  list(sessionId: string): string[];
}

export function createCommandReviewTurnCircuit(): CommandReviewTurnCircuit {
  const recentDenials: boolean[] = [];
  const rejectedRecoveries = new Set<string>();
  let consecutiveDenials = 0;
  let interrupted = false;
  return {
    get interrupted() {
      return interrupted;
    },
    hasRejectedRecovery: (actionKey) => rejectedRecoveries.has(actionKey),
    rejectRecovery: (actionKey) => {
      rejectedRecoveries.add(actionKey);
    },
    record(result) {
      const explicitDenial =
        result.status === "reviewed" && result.outcome === "deny";
      consecutiveDenials = explicitDenial ? consecutiveDenials + 1 : 0;
      recentDenials.push(explicitDenial);
      if (recentDenials.length > 50) recentDenials.shift();
      const denialsInRecentWindow = recentDenials.filter(Boolean).length;
      interrupted ||= consecutiveDenials >= 3 || denialsInRecentWindow >= 10;
      return {
        explicitDenial,
        interrupted,
        consecutiveDenials,
        denialsInRecentWindow,
      };
    },
  };
}

export function createRetainedCommandReviewDenials(
  maxEntriesPerSession = 10,
): RetainedCommandReviewDenials {
  const bySession = new Map<string, Map<string, true>>();
  const entriesFor = (sessionId: string): Map<string, true> => {
    let entries = bySession.get(sessionId);
    if (!entries) {
      entries = new Map();
      bySession.set(sessionId, entries);
    }
    return entries;
  };
  return {
    has: (sessionId, actionKey) =>
      bySession.get(sessionId)?.has(actionKey) ?? false,
    retain(sessionId, actionKey) {
      const entries = entriesFor(sessionId);
      entries.delete(actionKey);
      entries.set(actionKey, true);
      while (entries.size > maxEntriesPerSession) {
        const oldest = entries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    clear(sessionId, actionKey) {
      const entries = bySession.get(sessionId);
      entries?.delete(actionKey);
      if (entries?.size === 0) bySession.delete(sessionId);
    },
    clearSession(sessionId) {
      bySession.delete(sessionId);
    },
    list: (sessionId) => [...(bySession.get(sessionId)?.keys() ?? [])],
  };
}

export interface CommandApprovalReviewerFactoryOptions {
  resolveContext(
    sessionId: string,
    signal: AbortSignal,
  ):
    | CommandApprovalReviewerContext
    | undefined
    | Promise<CommandApprovalReviewerContext | undefined>;
  timeoutMs?: number;
  attemptTimeoutMs?: number;
}

/**
 * Risk codes that approve-for-me mode treats as routine development workflow:
 * recognized read/inspect commands, version checks, project toolchain runs
 * (build/test/lint/format), workspace-bounded file operations, and routine Git
 * publishing (stage, unstage, commit, branch, fetch/pull, non-force push, gh pr create).
 * Force pushes, ref deletion, other network effects, unrecognized executables
 * or operations, and
 * destructive or privileged commands are deliberately excluded and keep the
 * full Guardian model review.
 */
export const ROUTINE_APPROVE_FOR_ME_RISK_CODES: ReadonlySet<CommandRiskCode> =
  new Set([
    "read_only",
    "version_check",
    "project_toolchain",
    "workspace_mutation",
    "git_workflow",
  ]);

const ROUTINE_GIT_NATIVE_RISK_CODES: ReadonlySet<CommandRiskCode> = new Set([
  "read_only",
  "version_check",
  "git_workflow",
]);

/**
 * Routine Git workflow needs native execution because the sandbox keeps Git
 * metadata read-only and SSH remotes cannot use the managed network. Permit the
 * native route only for commands made of Git workflow plus read-only steps.
 */
export function isRoutineGitWorkflowNativeCommand(
  classified: ClassifiedCommand,
): boolean {
  return (
    classified.tier !== "dangerous" &&
    classified.perSubCommand.some(
      ({ result }) => result.code === "git_workflow",
    ) &&
    classified.perSubCommand.every(({ result }) =>
      ROUTINE_GIT_NATIVE_RISK_CODES.has(result.code),
    )
  );
}

export function isRoutineApproveForMeCommand(
  classified: ClassifiedCommand,
): boolean {
  return (
    classified.tier !== "dangerous" &&
    classified.perSubCommand.length > 0 &&
    classified.perSubCommand.every(({ result }) =>
      ROUTINE_APPROVE_FOR_ME_RISK_CODES.has(result.code),
    )
  );
}

export function getCommandAutoApprovalEligibility(
  input: CommandAutoApprovalEligibilityInput,
): CommandAutoApprovalEligibility {
  return input.classified.perSubCommand.length > 0
    ? { eligible: true }
    : { eligible: false, reason: "No command to review" };
}

export function parseCommandApprovalReviewResponse(
  text: string,
): Pick<
  CommandApprovalReviewResult,
  "outcome" | "risk" | "userAuthorization" | "rationale" | "status"
> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed)) return invalidReviewResponse();
    const allowedKeys = new Set([
      "outcome",
      "risk_level",
      "user_authorization",
      "rationale",
    ]);
    if (Object.keys(parsed).some((key) => !allowedKeys.has(key))) {
      return invalidReviewResponse();
    }
    if (parsed.outcome !== "allow" && parsed.outcome !== "deny") {
      return invalidReviewResponse();
    }
    if (parsed.risk_level !== undefined && !isReviewRisk(parsed.risk_level)) {
      return invalidReviewResponse();
    }
    if (
      parsed.user_authorization !== undefined &&
      !isReviewUserAuthorization(parsed.user_authorization)
    ) {
      return invalidReviewResponse();
    }
    if (
      parsed.rationale !== undefined &&
      typeof parsed.rationale !== "string"
    ) {
      return invalidReviewResponse();
    }
    const rationale =
      typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
    if (rationale.length > MAX_REASON_LENGTH) return invalidReviewResponse();
    return {
      outcome: parsed.outcome,
      risk: parsed.risk_level ?? "low",
      userAuthorization: parsed.user_authorization ?? "unknown",
      rationale:
        rationale ||
        (parsed.outcome === "allow"
          ? "Guardian allowed the action"
          : "Guardian denied the action"),
      status: "reviewed",
    };
  } catch {
    return invalidReviewResponse();
  }
}

export function createCommandApprovalReviewer(
  options: CommandApprovalReviewerFactoryOptions,
): CommandApprovalReviewer {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_REVIEW_TIMEOUT_MS;

  return {
    async review(input) {
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
      const signal = input.signal
        ? AbortSignal.any([input.signal, timeoutController.signal])
        : timeoutController.signal;
      let model = "";
      let attempts = 0;
      let reportedUsageAttempts = 0;
      let observedDefaultedFields: Array<"risk" | "authorization"> | undefined;
      let reviewPublicationActive = false;
      let observedPolicy = getGuardianPolicy(false);
      const usage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
      let usageReported = false;
      let usageEstimated = false;
      let inputTokenBreakdownReported = true;

      try {
        const context = await awaitWithAbort(
          Promise.resolve(options.resolveContext(input.sessionId, signal)),
          signal,
        );
        model = context?.sessionModel ?? "";
        if (!context || !isRoutable(context.provider, context.sessionModel)) {
          reportGuardianObservation(input.observe, {
            policyVersion: observedPolicy.version,
            policyFingerprint: observedPolicy.fingerprint,
            adapterVersion: "primary-command-v1",
            requestedModel: model,
            modelProvenance: "not_reported",
            attempts,
            projection: buildPrimaryGuardianProjection(input),
            usage: { reportedAttempts: 0, coverage: "not_reported" },
          });
          return unavailableReviewResult(model);
        }

        model = context.sessionModel;
        const capabilities = context.provider.getCapabilities(model);
        const reasoningEffort = capabilities.reasoningEfforts?.includes("low")
          ? "low"
          : "none";
        let retryingInvalidResponse = false;

        const policyContext = isReviewPublicationContextForInput(
          input.reviewPublicationContext,
          input,
        )
          ? input.reviewPublicationContext
          : undefined;
        observedPolicy = getGuardianPolicy(policyContext !== undefined);
        reviewPublicationActive = policyContext !== undefined;
        const policy = observedPolicy;
        const decision = await runGuardianReviewAttempts({
          signal,
          maxAttempts: MAX_COMMAND_REVIEW_ATTEMPTS,
          attemptTimeoutMs:
            options.attemptTimeoutMs ??
            DEFAULT_GUARDIAN_REVIEW_ATTEMPT_TIMEOUT_MS,
          async run(_attempt, attemptSignal) {
            attempts += 1;
            const result = await context.provider.complete({
              model,
              systemPrompt: policy.systemPrompt,
              messages: [
                {
                  role: "user",
                  content:
                    serializeReviewData(input, policyContext) +
                    (retryingInvalidResponse
                      ? GUARDIAN_INVALID_RESPONSE_RETRY_INSTRUCTION
                      : ""),
                },
              ],
              maxTokens: 384,
              temperature: 0,
              reasoningEffort,
              signal: attemptSignal,
            });
            const reportedUsage = result.usage;
            if (
              reportedUsage &&
              ((reportedUsage.inputTokens !== undefined &&
                reportedUsage.inputTokens > 0) ||
                (reportedUsage.outputTokens !== undefined &&
                  reportedUsage.outputTokens > 0) ||
                (reportedUsage.cacheReadTokens !== undefined &&
                  reportedUsage.cacheReadTokens > 0) ||
                (reportedUsage.cacheCreationTokens !== undefined &&
                  reportedUsage.cacheCreationTokens > 0) ||
                reportedUsage.estimated === true)
            ) {
              usageReported = true;
              reportedUsageAttempts += 1;
              usage.inputTokens += reportedUsage.inputTokens ?? 0;
              usage.outputTokens += reportedUsage.outputTokens ?? 0;
              usage.cacheReadTokens += reportedUsage.cacheReadTokens ?? 0;
              usage.cacheCreationTokens +=
                reportedUsage.cacheCreationTokens ?? 0;
              usageEstimated ||= reportedUsage.estimated === true;
              inputTokenBreakdownReported &&=
                reportedUsage.inputTokenBreakdownReported === true;
            }
            const parsed = parseCommandApprovalReviewResponse(result.text);
            retryingInvalidResponse = parsed.status === "invalid";
            if (parsed.status === "reviewed") {
              observedDefaultedFields = getDefaultedFields(result.text);
            }
            return parsed;
          },
          shouldRetry: (result) => result.status === "invalid",
        });
        reportGuardianObservation(input.observe, {
          policyVersion: policy.version,
          policyFingerprint: policy.fingerprint,
          adapterVersion: "primary-command-v1",
          requestedModel: model,
          modelProvenance: "not_reported",
          attempts,
          projection: buildPrimaryGuardianProjection(
            input,
            policyContext !== undefined,
          ),
          usage: {
            ...(usageReported ? usage : {}),
            reportedAttempts: reportedUsageAttempts,
            coverage: usageReported
              ? reportedUsageAttempts < attempts
                ? "partial"
                : "reported"
              : "not_reported",
            ...(usageReported
              ? { estimated: usageEstimated, inputTokenBreakdownReported }
              : {}),
          },
          defaultedFields: observedDefaultedFields,
        });
        return { ...decision, model };
      } catch (error) {
        reportGuardianObservation(input.observe, {
          policyVersion: observedPolicy.version,
          policyFingerprint: observedPolicy.fingerprint,
          adapterVersion: "primary-command-v1",
          requestedModel: model,
          modelProvenance: "not_reported",
          attempts,
          projection: buildPrimaryGuardianProjection(
            input,
            reviewPublicationActive,
          ),
          usage: {
            ...(usageReported
              ? {
                  ...usage,
                  estimated: usageEstimated,
                  inputTokenBreakdownReported,
                }
              : {}),
            reportedAttempts: reportedUsageAttempts,
            coverage: usageReported ? "partial" : "not_reported",
          },
        });
        const timedOut =
          timeoutController.signal.aborted ||
          isGuardianAttemptTimeoutError(error);
        return {
          outcome: "deny",
          risk: "high",
          userAuthorization: "unknown",
          rationale: input.signal?.aborted
            ? "Command review was cancelled"
            : timedOut
              ? "Command review timed out"
              : "Command review was unavailable",
          model,
          status: input.signal?.aborted
            ? "cancelled"
            : timedOut
              ? "timed_out"
              : "unavailable",
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function buildPrimaryGuardianProjection(
  input: CommandApprovalReviewInput,
  reviewPublication = false,
): GuardianProjectionManifest {
  const unknown = unknownGuardianCoverage();
  const coverage = {
    command: { ...completeGuardianCoverage(), state: "complete" as const },
    context: input.evidenceMetadata?.context ?? unknown,
    human_authority: input.evidenceMetadata?.humanAuthority ?? unknown,
    scripts: input.evidenceMetadata?.scripts ?? unknown,
    inline_files: input.inlineFiles?.length
      ? {
          ...completeGuardianCoverage(input.inlineFiles.length),
          ...(input.inlineFiles.some((file) => file.truncated)
            ? {
                state: "partial" as const,
                reasons: ["source_truncated" as const],
              }
            : {}),
        }
      : { ...unknownGuardianCoverage(), state: "not_applicable" as const },
    deletion_targets:
      input.evidenceMetadata?.deletionTargets ??
      (input.evidence
        ? completeGuardianCoverage(input.evidence.deletionTargets.length)
        : unknown),
    classification: input.classified.perSubCommand.length
      ? completeGuardianCoverage(input.classified.perSubCommand.length)
      : unknown,
    confinement: input.security ? completeGuardianCoverage() : unknown,
    review_publication: reviewPublication
      ? completeGuardianCoverage()
      : { ...unknownGuardianCoverage(), state: "not_applicable" as const },
  };
  return {
    version: 1,
    kind: reviewPublication ? "primary_review_publication" : "primary_legacy",
    commandExact: true,
    coverage,
  };
}

function getDefaultedFields(
  response: string,
): Array<"risk" | "authorization"> | undefined {
  try {
    const parsed: unknown = JSON.parse(response);
    if (!isPlainObject(parsed)) return undefined;
    const fields: Array<"risk" | "authorization"> = [];
    if (parsed.risk_level === undefined) fields.push("risk");
    if (parsed.user_authorization === undefined) fields.push("authorization");
    return fields.length ? fields : undefined;
  } catch {
    return undefined;
  }
}

function serializeReviewData(
  input: CommandApprovalReviewInput,
  reviewPublicationContext?: ReviewPublicationContext,
): string {
  return [
    "<untrusted-command-review-data>",
    JSON.stringify({
      command: input.command,
      cwd: input.cwd,
      workspaceRoots: input.workspaceRoots,
      reason: input.reason ?? null,
      userObjective: input.userObjective ?? null,
      latestUserInstruction: latestUserInstruction(input.context),
      recentContext: input.context ?? [],
      confinement: input.security
        ? {
            route: input.security.route,
            executionSurface: input.security.executionSurface,
            confinement: input.security.confinement,
            routeReason: input.security.routeReason,
            requiredAuthority: input.security.requiredAuthority,
            commandApprovalPolicySnapshot:
              input.security.commandApprovalPolicySnapshot,
            commandExecutionPolicySnapshot:
              input.security.commandExecutionPolicySnapshot,
            executionPolicy: input.security.executionPolicy,
            sandbox: input.security.sandbox
              ? {
                  attestationVersion: input.security.sandbox.attestationVersion,
                  policyVersion: input.security.sandbox.policyVersion,
                  profileId: input.security.sandbox.profileId,
                  backend: input.security.sandbox.backend,
                  architecture: input.security.sandbox.architecture,
                  capabilities: input.security.sandbox.capabilities,
                  capabilityRequest:
                    input.security.sandbox.capabilityRequest ?? null,
                }
              : null,
          }
        : null,
      referencedScripts: input.evidence?.referencedScripts ?? [],
      deletionTargets: input.evidence?.deletionTargets ?? [],
      deletionTargetsOmitted: input.evidence?.deletionTargetsOmitted ?? 0,
      ...(reviewPublicationContext
        ? {
            reviewPublicationContext: {
              version: reviewPublicationContext.version,
              mode: reviewPublicationContext.mode,
              target: reviewPublicationContext.target,
              kind: reviewPublicationContext.kind,
              verified: reviewPublicationContext.verified,
              payloadPreviews: reviewPublicationContext.payloadPreviews ?? [],
              ...(reviewPublicationContext.pendingReviewBody !== undefined
                ? {
                    pendingReviewBody:
                      reviewPublicationContext.pendingReviewBody,
                  }
                : {}),
            },
          }
        : {}),
      inlineFiles:
        input.inlineFiles?.map((file) => ({
          name: file.name,
          ext: file.ext ?? null,
          bytes: file.bytes,
          sha256: file.sha256,
          executable: file.executable,
          truncated: file.truncated,
          content: file.preview,
        })) ?? [],
      classification: {
        tier: input.classified.tier,
        subcommands: input.classified.perSubCommand.map(
          ({ command, result }) => ({
            command,
            tier: result.tier,
            code: result.code,
            executable: result.executable ?? null,
          }),
        ),
      },
    }),
    "</untrusted-command-review-data>",
  ].join("\n");
}

type IndexedContextEntry = CommandReviewContextEntry & {
  index: number;
  /** Source transcript link for a direct instruction. */
  humanInputId?: string;
  /** Stable identity of one human decision across transcript and record. */
  decisionKey?: string;
};

/**
 * Bounded review context: a recent window of transcript activity plus a
 * separately budgeted, chronologically merged set of human decisions. When a
 * private human decision record is supplied, verified decisions and typed
 * instructions that fell out of the recent window (including condensed
 * history) are restored from it.
 */
export function buildCommandReviewContextWithMetadata(
  messages: readonly AgentMessage[],
  sessionId?: string,
  queuedHumanInputs: readonly string[] = [],
  humanDecisionRecord?: HumanDecisionRecordSnapshot,
): {
  context: CommandReviewContextEntry[];
  metadata: GuardianEvidenceSourceMetadata;
} {
  const context = buildCommandReviewContext(
    messages,
    sessionId,
    queuedHumanInputs,
    humanDecisionRecord,
  );
  const inputEntries = messages.flatMap((message) =>
    isDirectUserInstruction(message) && message.humanInputId
      ? [{ id: message.humanInputId, content: contentText(message.content) }]
      : [],
  );
  const selectedInstructions = context.filter(
    (entry) => entry.directUserInstruction,
  );
  const includedIds = inputEntries
    .filter(({ content }) =>
      selectedInstructions.some((entry) => content.includes(entry.content)),
    )
    .map(({ id }) => id);
  const recordOnlyCount =
    humanDecisionRecord?.entries.filter(
      (recorded) =>
        !messages.some((message) =>
          recorded.kind === "instruction"
            ? message.humanInputId === recorded.inputId
            : message.humanQuestionAnswers?.some(
                (answer) =>
                  answer.binding.questionRequestId ===
                    recorded.evidence.binding.questionRequestId &&
                  answer.binding.toolCallId ===
                    recorded.evidence.binding.toolCallId,
              ),
        ),
    ).length ?? 0;
  const sourceCount =
    messages.reduce(
      (count, message, index) =>
        count +
        messageToContextEntries(message, index, sessionId, messages[index - 1])
          .length,
      0,
    ) +
    queuedHumanInputs.length +
    recordOnlyCount;
  const includedCount = Math.min(sourceCount, context.length);
  let omittedCount = Math.max(0, sourceCount - includedCount);
  const truncated = inputEntries.some(({ content }) =>
    selectedInstructions.some(
      (entry) => content.includes(entry.content) && entry.content !== content,
    ),
  );
  omittedCount = Math.max(
    omittedCount,
    inputEntries.length - includedIds.length,
  );
  const authoritySourceCount =
    messages.filter(isDirectUserInstruction).length +
    queuedHumanInputs.length +
    messages.reduce(
      (count, message, index) =>
        count +
        messageToContextEntries(
          message,
          index,
          sessionId,
          messages[index - 1],
        ).filter((entry) => entry.humanDecisionEvidence).length,
      0,
    ) +
    recordOnlyCount;
  const authorityIncludedCount = context.filter(
    (entry) => entry.directUserInstruction || entry.humanDecisionEvidence,
  ).length;
  const authorityOmittedCount = Math.max(
    0,
    authoritySourceCount - authorityIncludedCount,
  );
  return {
    context,
    metadata: {
      context: {
        state: omittedCount || truncated ? "partial" : "complete",
        reasons: [
          ...(truncated ? ["source_truncated" as const] : []),
          ...(omittedCount ? ["projection_budget" as const] : []),
          ...(humanDecisionRecord?.incomplete
            ? ["source_unknown" as const]
            : []),
        ],
        sourceCount,
        includedCount,
        omittedCount,
      },
      humanAuthority: {
        state:
          humanDecisionRecord?.incomplete || authorityOmittedCount > 0
            ? "partial"
            : "complete",
        reasons: [
          ...(authorityOmittedCount ? ["projection_budget" as const] : []),
          ...(humanDecisionRecord?.incomplete
            ? ["source_unknown" as const]
            : []),
        ],
        sourceCount: authoritySourceCount,
        includedCount: authorityIncludedCount,
        omittedCount: authorityOmittedCount,
      },
      sourceInputIds: includedIds,
      ...(humanDecisionRecord
        ? { humanDecisionRecordIncomplete: humanDecisionRecord.incomplete }
        : {}),
    },
  };
}

export function buildCommandReviewContext(
  messages: readonly AgentMessage[],
  sessionId?: string,
  queuedHumanInputs: readonly string[] = [],
  humanDecisionRecord?: HumanDecisionRecordSnapshot,
): CommandReviewContextEntry[] {
  const entries: IndexedContextEntry[] = [
    ...messages.flatMap((message, messageIndex) =>
      messageToContextEntries(
        message,
        messageIndex,
        sessionId,
        messages[messageIndex - 1],
      ),
    ),
    ...queuedHumanInputs.map((content, queueIndex) => ({
      role: "user" as const,
      content,
      directUserInstruction: true,
      queuedHumanInput: true,
      index: (messages.length + queueIndex) * 1_000,
    })),
  ];
  const recent = selectRecentContext(
    entries.filter((entry) => !entry.humanDecisionEvidence),
  );
  const decisions = selectHumanDecisions(
    entries.filter((entry) => entry.humanDecisionEvidence),
    recent,
    messages,
    humanDecisionRecord,
  );
  return [...recent, ...decisions]
    .sort((a, b) => a.index - b.index)
    .map(
      ({
        role,
        content,
        directUserInstruction,
        humanDecisionEvidence,
        queuedHumanInput,
      }) => ({
        role,
        content,
        ...(directUserInstruction ? { directUserInstruction: true } : {}),
        ...(humanDecisionEvidence ? { humanDecisionEvidence: true } : {}),
        ...(queuedHumanInput ? { queuedHumanInput: true } : {}),
      }),
    );
}

function selectRecentContext(
  entries: readonly IndexedContextEntry[],
): IndexedContextEntry[] {
  const selected: IndexedContextEntry[] = [];
  let latestDirectEntryIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.directUserInstruction) {
      latestDirectEntryIndex = index;
      break;
    }
  }
  const latestDirectContent =
    latestDirectEntryIndex >= 0
      ? truncateContextEntry(entries[latestDirectEntryIndex]!.content)
      : "";
  let directEntryPending = latestDirectEntryIndex >= 0;
  let totalLength = 0;

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry) continue;
    const content = truncateContextEntry(entry.content);
    if (!content) continue;
    const isLatestDirectEntry = i === latestDirectEntryIndex;
    if (
      !isLatestDirectEntry &&
      directEntryPending &&
      (selected.length >= MAX_CONTEXT_ENTRIES - 1 ||
        totalLength + content.length + latestDirectContent.length >
          MAX_CONTEXT_LENGTH)
    ) {
      continue;
    }
    if (selected.length >= MAX_CONTEXT_ENTRIES) break;
    if (totalLength + content.length > MAX_CONTEXT_LENGTH) {
      const remaining = MAX_CONTEXT_LENGTH - totalLength;
      if (remaining < 80) break;
      selected.push({ ...entry, content: content.slice(-remaining) });
      break;
    }
    selected.push({ ...entry, content });
    totalLength += content.length;
    if (isLatestDirectEntry) directEntryPending = false;
  }
  return selected;
}

/** Unlocated record entries sort before every transcript entry, by sequence. */
const UNLOCATED_RECORD_INDEX_BASE = -1e12;

/**
 * Merge transcript and record human decisions chronologically, then keep the
 * newest that fit a dedicated budget. Selection is newest-first and stops at
 * the first entry that does not fit, so an older decision never survives
 * while a newer one is dropped; anything omitted is replaced by one marker.
 */
function selectHumanDecisions(
  transcriptDecisions: readonly IndexedContextEntry[],
  recent: readonly IndexedContextEntry[],
  messages: readonly AgentMessage[],
  record: HumanDecisionRecordSnapshot | undefined,
): IndexedContextEntry[] {
  const candidates = new Map<string, IndexedContextEntry>();
  transcriptDecisions.forEach((entry, position) => {
    candidates.set(entry.decisionKey ?? `transcript:${position}`, entry);
  });
  if (record) {
    const inWindow = new Set(
      recent.flatMap((entry) =>
        entry.humanInputId ? [entry.humanInputId] : [],
      ),
    );
    const located = locateRecordSources(messages);
    for (const recorded of record.entries) {
      const unlocated = UNLOCATED_RECORD_INDEX_BASE + recorded.sequence;
      if (recorded.kind === "instruction") {
        if (inWindow.has(recorded.inputId)) continue;
        const key = `instruction:${recorded.inputId}`;
        const content = safeJson({
          recordSequence: recorded.sequence,
          humanInstruction: recorded.text,
          ...(recorded.truncated ? { humanInstructionTruncated: true } : {}),
        });
        candidates.set(key, {
          role: "user",
          content:
            content.length <= MAX_CONTEXT_ENTRY_LENGTH
              ? content
              : safeJson({
                  recordSequence: recorded.sequence,
                  evidenceOmitted:
                    "A recorded human instruction exceeded the evidence budget. Earlier restrictions may apply; clarify before relying on its absence.",
                }),
          humanDecisionEvidence: true,
          decisionKey: key,
          index: located.instructions.get(recorded.inputId) ?? unlocated,
        });
        continue;
      }
      const base =
        located.questions.get(recordQuestionLocation(recorded.evidence)) ??
        unlocated;
      for (const entry of questionDecisionEntries(recorded.evidence, base)) {
        if (!candidates.has(entry.decisionKey!)) {
          candidates.set(entry.decisionKey!, entry);
        }
      }
    }
  }

  const ordered = [...candidates.values()].sort((a, b) => b.index - a.index);
  const totalLength = ordered.reduce(
    (total, entry) => total + entry.content.length,
    0,
  );
  const incomplete = record?.incomplete === true;
  if (
    !incomplete &&
    ordered.length <= MAX_HUMAN_DECISION_ENTRIES &&
    totalLength <= MAX_HUMAN_DECISION_LENGTH
  ) {
    return ordered;
  }
  const selected: IndexedContextEntry[] = [];
  let length = 0;
  for (const entry of ordered) {
    if (
      selected.length >= MAX_HUMAN_DECISION_ENTRIES - 1 ||
      length + entry.content.length + HUMAN_DECISION_OMITTED_CONTENT.length >
        MAX_HUMAN_DECISION_LENGTH
    ) {
      break;
    }
    selected.push(entry);
    length += entry.content.length;
  }
  const oldestIncluded = selected.at(-1)?.index;
  selected.push({
    role: "tool",
    content: HUMAN_DECISION_OMITTED_CONTENT,
    humanDecisionEvidence: true,
    index:
      oldestIncluded === undefined
        ? UNLOCATED_RECORD_INDEX_BASE
        : oldestIncluded - 1e-6,
  });
  return selected;
}

function recordQuestionLocation(evidence: {
  binding: { questionRequestId: string; toolCallId: string };
}): string {
  return `${evidence.binding.questionRequestId}\u0000${evidence.binding.toolCallId}`;
}

/** Transcript positions of record sources still present in history. */
function locateRecordSources(messages: readonly AgentMessage[]): {
  instructions: Map<string, number>;
  questions: Map<string, number>;
} {
  const instructions = new Map<string, number>();
  const questions = new Map<string, number>();
  messages.forEach((message, messageIndex) => {
    if (message.humanInputId) {
      instructions.set(message.humanInputId, messageIndex * 1_000);
    }
    if (!message.humanQuestionAnswers?.length) return;
    for (const evidence of message.humanQuestionAnswers) {
      const blockIndex = Array.isArray(message.content)
        ? message.content.findIndex(
            (block) =>
              block.type === "tool_result" &&
              block.tool_use_id === evidence.binding.toolCallId,
          )
        : -1;
      questions.set(
        recordQuestionLocation(evidence),
        messageIndex * 1_000 + Math.max(blockIndex, 0),
      );
    }
  });
  return { instructions, questions };
}

function questionDecisionEntries(
  evidence: HumanDecisionQuestionEvidence,
  index: number,
): IndexedContextEntry[] {
  const binding = evidence.binding;
  const entries: IndexedContextEntry[] = [];
  for (const [questionIndex, question] of binding.questions.entries()) {
    const answer = evidence.answers[question.id];
    const note = evidence.notes[question.id];
    if (answer === undefined && !note) continue;
    const content = safeJson({
      questionRequestId: binding.questionRequestId,
      toolCallId: binding.toolCallId,
      agentAuthoredSubject: { context: binding.context, question },
      humanAnswer: answer ?? null,
      ...(note ? { humanNote: note } : {}),
    });
    // Never clip away the literal subject or a refusal and leave apparent consent.
    const boundedContent =
      content.length <= MAX_CONTEXT_ENTRY_LENGTH
        ? content
        : safeJson({
            questionRequestId: binding.questionRequestId,
            toolCallId: binding.toolCallId,
            evidenceOmitted:
              "Literal human decision exceeded the evidence budget. Current consent is unknown; clarify rather than relying on older conflicting evidence.",
          });
    entries.push({
      role: "tool",
      content: boundedContent,
      humanDecisionEvidence: true,
      decisionKey: `question:${binding.questionRequestId}:${binding.toolCallId}:${question.id}`,
      index: index + (questionIndex + 1) / 1000,
    });
  }
  return entries;
}

/**
 * Task context for reviewers: the newest visible, non-synthetic user text.
 * Summaries, resume context and hidden continuations never become the
 * objective. Agent-delegated prompts may still supply background-task context;
 * the policy treats the objective as context, never as authorization.
 */
export function selectCommandReviewObjective(
  messages: readonly AgentMessage[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (
      message?.role === "user" &&
      typeof message.content === "string" &&
      !message.isSummary &&
      !message.isResumeContext &&
      message.uiHint?.userMessage?.hidden !== true &&
      message.content.trim()
    ) {
      return message.content;
    }
  }
  return undefined;
}

/** Stable identity of the legacy primary prompt, retained for existing audit joins. */
export const COMMAND_REVIEW_POLICY_FINGERPRINT = createHash("sha256")
  .update(GUARDIAN_REVIEW_SYSTEM_PROMPT)
  .digest("hex")
  .slice(0, 16);

function contentText(content: AgentMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.find((block) => block.type === "text")?.text ?? "";
}

function latestUserInstruction(
  context: readonly CommandReviewContextEntry[] | undefined,
): string | null {
  for (let index = (context?.length ?? 0) - 1; index >= 0; index -= 1) {
    const entry = context?.[index];
    if (entry?.directUserInstruction && entry.content.trim()) {
      return entry.content;
    }
  }
  return null;
}

function messageToContextEntries(
  message: AgentMessage,
  messageIndex: number,
  sessionId?: string,
  sourceAssistant?: AgentMessage,
): IndexedContextEntry[] {
  const directUserInstruction = isDirectUserInstruction(message);
  const humanInputId =
    directUserInstruction && message.humanInputId
      ? { humanInputId: message.humanInputId }
      : {};
  if (typeof message.content === "string") {
    return message.content.trim()
      ? [
          {
            role: message.role,
            content: message.content,
            index: messageIndex * 1_000,
            ...(directUserInstruction
              ? { directUserInstruction: true, ...humanInputId }
              : {}),
          },
        ]
      : [];
  }

  const entries: IndexedContextEntry[] = [];
  let directInstructionTagged = false;
  for (
    let blockIndex = 0;
    blockIndex < message.content.length;
    blockIndex += 1
  ) {
    const block = message.content[blockIndex];
    if (!block || block.type === "thinking") continue;
    const index = messageIndex * 1_000 + blockIndex;
    if (block.type === "text" && block.text.trim()) {
      const tagDirectInstruction: boolean =
        directUserInstruction && !directInstructionTagged;
      entries.push({
        role: message.role,
        content: block.text,
        index,
        ...(tagDirectInstruction
          ? { directUserInstruction: true, ...humanInputId }
          : {}),
      });
      if (tagDirectInstruction) directInstructionTagged = true;
    } else if (block.type === "tool_use") {
      entries.push({
        role: "tool",
        content: `Tool call ${block.name}: ${safeJson(block.input)}`,
        index,
      });
    } else if (block.type === "tool_result") {
      entries.push({
        role: "tool",
        content: `Tool result ${block.tool_use_id}: ${contentBlockText(block.content)}`,
        index,
      });
      if (
        !sessionId ||
        message.isSummary ||
        message.isResumeContext ||
        message.role !== "user" ||
        sourceAssistant?.role !== "assistant" ||
        sourceAssistant.isSummary ||
        sourceAssistant.isResumeContext ||
        !Array.isArray(sourceAssistant.content) ||
        !sourceAssistant.content.some(
          (call) =>
            call.type === "tool_use" &&
            call.id === block.tool_use_id &&
            call.name === "ask_user",
        )
      )
        continue;
      const askUserCall = sourceAssistant.content.find(
        (call) => call.type === "tool_use" && call.id === block.tool_use_id,
      );
      const askUserInput =
        askUserCall?.type === "tool_use" ? askUserCall.input : undefined;
      for (const evidence of message.humanQuestionAnswers ?? []) {
        const binding = evidence.binding;
        if (
          evidence.source !== "human_ui" ||
          binding.schemaVersion !== 1 ||
          !binding.questionRequestId ||
          binding.sessionId !== sessionId ||
          binding.toolCallId !== block.tool_use_id ||
          !bindingMatchesAskUserInput(binding, askUserInput)
        )
          continue;
        entries.push(...questionDecisionEntries(evidence, index));
      }
    }
  }
  return entries;
}

/**
 * Re-check at review time that persisted evidence still describes the literal
 * ask_user call it is attached to, so copied or edited history cannot rebind
 * an answer to a different subject.
 */
function bindingMatchesAskUserInput(
  binding: {
    context: string;
    questions: ReadonlyArray<{ id: string; question: string }>;
  },
  input: unknown,
): boolean {
  if (!input || typeof input !== "object") return false;
  const { context, questions } = input as {
    context?: unknown;
    questions?: unknown;
  };
  const inputContext = typeof context === "string" ? context.trim() : "";
  if (inputContext !== binding.context.trim()) return false;
  if (
    !Array.isArray(questions) ||
    questions.length !== binding.questions.length
  )
    return false;
  return binding.questions.every((question, index) => {
    const raw = questions[index] as { id?: unknown; question?: unknown } | null;
    return raw?.id === question.id && raw.question === question.question;
  });
}

function isDirectUserInstruction(message: AgentMessage): boolean {
  const userMessage = message.uiHint?.userMessage;
  return (
    message.role === "user" &&
    !message.isSummary &&
    !message.isResumeContext &&
    userMessage?.hidden !== true &&
    (userMessage?.origin === "vscode" || userMessage?.origin === "browser")
  );
}

function contentBlockText(content: string | MessageParam["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (block.type === "text") return [block.text];
      if (block.type === "tool_use") {
        return [`Tool call ${block.name}: ${safeJson(block.input)}`];
      }
      return [];
    })
    .join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function truncateContextEntry(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_CONTEXT_ENTRY_LENGTH) return trimmed;
  const suffixLength = Math.floor(MAX_CONTEXT_ENTRY_LENGTH / 2);
  return `${trimmed.slice(0, MAX_CONTEXT_ENTRY_LENGTH - suffixLength - 20)}\n… omitted …\n${trimmed.slice(-suffixLength)}`;
}

function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function isRoutable(provider: ModelProvider, model: string): boolean {
  const routable =
    provider.listRoutableModelIds?.() ??
    provider.listModels().map(({ id }) => id);
  return routable.includes(model);
}

function unavailableReviewResult(model: string): CommandApprovalReviewResult {
  return {
    outcome: "deny",
    risk: "high",
    userAuthorization: "unknown",
    rationale: "Command review was unavailable",
    model,
    status: "unavailable",
  };
}

function invalidReviewResponse(): Pick<
  CommandApprovalReviewResult,
  "outcome" | "risk" | "userAuthorization" | "rationale" | "status"
> {
  return {
    outcome: "deny",
    risk: "high",
    userAuthorization: "unknown",
    rationale: "Command reviewer returned an invalid response",
    status: "invalid",
  };
}

function isReviewRisk(value: unknown): value is CommandReviewRisk {
  return (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "critical"
  );
}

function isReviewUserAuthorization(
  value: unknown,
): value is CommandReviewUserAuthorization {
  return (
    value === "unknown" ||
    value === "low" ||
    value === "medium" ||
    value === "high"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeForCompare(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}
