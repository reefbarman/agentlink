import { randomUUID } from "node:crypto";
import * as path from "path";
import * as os from "os";

import { getConfiguredMasterBypass } from "../adapters/vscode/agentLinkConfig.js";

import { getWorkspaceRoots, tryGetFirstWorkspaceRoot } from "../util/paths.js";
import type {
  CommandExecutionPolicy,
  ManagedNetworkRequest,
  PreparedTerminalExecution,
  TerminalApprovalModeSnapshot,
  TerminalCommandResult,
  TerminalExecutionAttemptSummary,
  TerminalExecutionAuditEvent,
  TerminalExecutionRouteContext,
  TerminalExecutionSecuritySummary,
  TerminalExecuteOptions,
  TerminalProvider,
} from "../core/capabilities/terminal.js";

import type { SandboxViolation } from "../core/sandboxPolicy.js";
import {
  commandRulePolicyFingerprint,
  type CommandRulePolicyEvaluation,
} from "../approvals/commandRulePolicy.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type {
  ApprovalPanelProvider,
  NetworkApprovalResponse,
} from "../approvals/ApprovalPanelProvider.js";
import type { TrackerContext } from "../agent/AgentToolCallTracker.js";
import {
  splitCompoundCommand,
  expandSubCommands,
} from "../approvals/commandSplitter.js";
import {
  classifyCommand,
  isCommandEligibleForReadOnlyExecution,
  isCommandPathInsideWorkspace,
  type ClassifiedCommand,
  type CommandRiskCode,
  type CommandTier,
} from "../approvals/commandTierClassifier.js";
import type { CommandApprovalPolicy } from "../approvals/commandApprovalPolicy.js";
import {
  commandReviewActionKey,
  getCommandAutoApprovalEligibility,
  type CommandReviewContextEntry,
  type CommandApprovalReviewer,
  type CommandReviewTurnCircuit,
  type RetainedCommandReviewDenials,
} from "../approvals/commandApprovalReview.js";
import type {
  CommandReviewSummary,
  NetworkReviewSummary,
  SubCommandEntry,
} from "../approvals/webview/types.js";
import type { NetworkApprovalReviewer } from "../approvals/networkApprovalReview.js";
import { filterOutput, saveOutputTempFile } from "../util/outputFilter.js";
import { validateCommand } from "../util/pipeValidator.js";
import { validateInteractiveCommand } from "../util/interactiveValidator.js";
import { validateProtectedWriteCommand } from "../util/protectedWriteValidator.js";
import {
  scanShellLexBoundaries,
  scanShellLexTokens,
  scanShellLexWords,
  type ShellLexFinalState,
} from "../util/shellLex.js";
import { Semaphore } from "../util/Semaphore.js";
import {
  INLINE_FILE_TOKEN_RE,
  assertNoInvalidInlineFileTokens,
  InlineCommandFileError,
  type InlineCommandFileInput,
  type InlineCommandFilePreview,
  materializeInlineCommandFiles,
} from "../util/commandInlineFiles.js";

/** Serializes the approval-check phase so pending dialogs block other commands. */
const approvalGate = new Semaphore(1);

type CommandApprovalAudit =
  | { by: "readonly_policy" }
  | { by: "master_bypass" }
  | { by: "explicit_rule" }
  | { by: "recent_approval" }
  | { by: "tier"; tier: CommandTier; threshold: "safe" | "sensitive" }
  | {
      by: "model_reviewer";
      model: string;
      tier: CommandTier;
      outcome: "allow";
      risk: "low" | "medium" | "high" | "critical";
      user_authorization: "unknown" | "low" | "medium" | "high";
      rationale: string;
    }
  | { by: "human" }
  | { by: "human_edited" };

import { type ToolResult } from "../shared/types.js";

export interface ExecuteCommandProviders {
  terminalProvider?: TerminalProvider;
  getCommandApprovalPolicy?: (sessionId: string) => CommandApprovalPolicy;
  getCommandApprovalMode?: (sessionId: string) => TerminalApprovalModeSnapshot;
  commandApprovalReviewer?: CommandApprovalReviewer;
  networkApprovalReviewer?: NetworkApprovalReviewer;
  commandReviewTurnCircuit?: CommandReviewTurnCircuit;
  retainedCommandReviewDenials?: RetainedCommandReviewDenials;
  isSessionActive?: (sessionId: string) => boolean;
  toolAbortSignal?: AbortSignal;
  getUserObjective?: (sessionId: string) => string | undefined;
  getReviewContext?: (sessionId: string) => CommandReviewContextEntry[];
  commandExecutionPolicy?: CommandExecutionPolicy;
}

function prepareTerminalExecution(
  provider: TerminalProvider,
  options: TerminalExecuteOptions,
  routeContext: TerminalExecutionRouteContext,
): Promise<PreparedTerminalExecution> {
  if (provider.prepareExecution) {
    return provider.prepareExecution(options, routeContext);
  }
  const descriptor = Object.freeze({
    ...options,
    ...(options.env ? { env: Object.freeze({ ...options.env }) } : {}),
    ...(options.sandboxInlineFiles
      ? {
          sandboxInlineFiles: Object.freeze(
            options.sandboxInlineFiles.map((file) =>
              Object.freeze({ ...file }),
            ),
          ),
        }
      : {}),
  });
  if (routeContext.requiredAuthority !== "native-agent") {
    return Promise.reject(
      new Error(
        "Required Sandbox execution is unavailable. The compatibility provider cannot satisfy the host-owned route.",
      ),
    );
  }
  const security: TerminalExecutionSecuritySummary = {
    auditId: randomUUID(),
    route: "native",
    executionSurface: "vscode-compatibility",
    confinement: "native-unsandboxed",
    routeReason: "unsupported-host",
    ...routeContext,
    executionPolicy: "native-legacy-v1",
    preparedAt: Date.now(),
  };
  let available = true;
  return Promise.resolve({
    security,
    execute: async () => {
      if (!available) {
        throw new Error("Prepared terminal execution is no longer available");
      }
      available = false;
      const result = await provider.executeCommand(descriptor);
      return { ...result, security };
    },
    dispose: () => {
      available = false;
    },
  });
}

function sameDisplayedSecurityBasis(
  left: TerminalExecutionSecuritySummary,
  right: TerminalExecutionSecuritySummary,
): boolean {
  return (
    left.route === right.route &&
    left.executionSurface === right.executionSurface &&
    left.confinement === right.confinement &&
    left.routeReason === right.routeReason &&
    left.approvalPolicySnapshot === right.approvalPolicySnapshot &&
    left.approvalReviewerSnapshot === right.approvalReviewerSnapshot &&
    left.executionPresetSnapshot === right.executionPresetSnapshot &&
    left.requiredAuthority === right.requiredAuthority &&
    left.permissionIntent === right.permissionIntent &&
    left.approvalRequirement === right.approvalRequirement &&
    left.authorityReason === right.authorityReason &&
    left.commandApprovalPolicySnapshot ===
      right.commandApprovalPolicySnapshot &&
    left.commandExecutionPolicySnapshot ===
      right.commandExecutionPolicySnapshot &&
    left.executionPolicy === right.executionPolicy &&
    left.sandbox?.attestationId === right.sandbox?.attestationId &&
    left.sandbox?.attestationVersion === right.sandbox?.attestationVersion &&
    left.sandbox?.policyVersion === right.sandbox?.policyVersion &&
    left.sandbox?.profileId === right.sandbox?.profileId &&
    left.sandbox?.backend === right.sandbox?.backend &&
    left.sandbox?.architecture === right.sandbox?.architecture &&
    JSON.stringify(left.sandbox?.capabilities) ===
      JSON.stringify(right.sandbox?.capabilities) &&
    JSON.stringify(left.sandbox?.grant) ===
      JSON.stringify(right.sandbox?.grant) &&
    JSON.stringify(left.sandbox?.environmentPolicy) ===
      JSON.stringify(right.sandbox?.environmentPolicy)
  );
}

function recordExecutionAudit(
  provider: TerminalProvider,
  type: TerminalExecutionAuditEvent["type"],
  security: TerminalExecutionSecuritySummary,
  detail: Pick<
    TerminalExecutionAuditEvent,
    "approvalBasis" | "failure" | "resultStatus"
  > = {},
): void {
  provider.recordExecutionAudit?.({
    type,
    occurredAt: Date.now(),
    auditId: security.auditId,
    route: security.route,
    routeReason: security.routeReason,
    ...(security.sandbox
      ? {
          attestationId: security.sandbox.attestationId,
          policyVersion: security.sandbox.policyVersion,
          profileId: security.sandbox.profileId,
        }
      : {}),
    ...detail,
  });
}

function approvalModeFor(
  providers: ExecuteCommandProviders,
  sessionId: string,
): TerminalApprovalModeSnapshot {
  const provided = providers.getCommandApprovalMode?.(sessionId);
  if (provided) return Object.freeze({ ...provided });
  const commandApprovalPolicy =
    providers.getCommandApprovalPolicy?.(sessionId) ?? "manual";
  const approveForMe = commandApprovalPolicy === "approve-for-me";
  return Object.freeze({
    commandApprovalPolicy,
    approvalPolicy: "on-request",
    approvalReviewer: approveForMe ? "auto-review" : "user",
    executionPreset: approveForMe ? "workspace-write" : "native-manual",
  });
}

function routeContextFor(
  approvalMode: TerminalApprovalModeSnapshot,
  permissionIntent: "default" | "additional-permissions" | "native-escalation",
  commandExecutionPolicySnapshot?: CommandExecutionPolicy,
  explicitRuleAuthority = false,
): TerminalExecutionRouteContext {
  const executionPresetSnapshot = approvalMode.executionPreset;
  const explicitEscalation = permissionIntent === "native-escalation";
  const additionalPermissions = permissionIntent === "additional-permissions";
  return Object.freeze({
    approvalPolicySnapshot: approvalMode.approvalPolicy,
    approvalReviewerSnapshot: approvalMode.approvalReviewer,
    executionPresetSnapshot,
    requiredAuthority:
      explicitEscalation ||
      explicitRuleAuthority ||
      executionPresetSnapshot === "native-manual"
        ? "native-agent"
        : "sandbox",
    permissionIntent,
    approvalRequirement: explicitEscalation
      ? "explicit-escalation"
      : additionalPermissions
        ? "explicit-permissions"
        : "policy",
    authorityReason: explicitEscalation
      ? "explicit-escalation"
      : additionalPermissions
        ? "additional-permissions"
        : explicitRuleAuthority
          ? "explicit-rule"
          : "approval-policy",
    commandApprovalPolicySnapshot: approvalMode.commandApprovalPolicy,
    ...(commandExecutionPolicySnapshot
      ? { commandExecutionPolicySnapshot }
      : {}),
  });
}

function hasPolicyDrift(
  providers: ExecuteCommandProviders,
  sessionId: string,
  routeContext: TerminalExecutionRouteContext,
): boolean {
  const current = approvalModeFor(providers, sessionId);
  return (
    current.commandApprovalPolicy !==
      routeContext.commandApprovalPolicySnapshot ||
    current.approvalPolicy !== routeContext.approvalPolicySnapshot ||
    current.approvalReviewer !== routeContext.approvalReviewerSnapshot ||
    current.executionPreset !== routeContext.executionPresetSnapshot ||
    providers.commandExecutionPolicy !==
      routeContext.commandExecutionPolicySnapshot
  );
}

function policyDriftResult(
  command: string,
  security?: TerminalExecutionSecuritySummary,
): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "retry_required",
          command,
          reason:
            "Command approval or execution policy changed while this command was pending. Retry to prepare and approve it under the current policy.",
          ...(security ? { security } : {}),
          security_failure: "policy_drift",
          command_sent: false,
        }),
      },
    ],
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function sandboxCapabilityDenial(
  result: TerminalCommandResult,
): SandboxViolation | undefined {
  if (
    result.security?.route !== "sandbox" ||
    result.exit_code === 0 ||
    result.exit_code === null ||
    result.backgrounded ||
    result.is_running ||
    result.timed_out
  ) {
    return undefined;
  }
  return result.sandbox?.violations?.[0];
}

const NATIVE_RETRY_ELIGIBLE_COMMAND_CODES = new Set<CommandRiskCode>([
  "read_only",
  "version_check",
  "project_toolchain",
]);

function isNativeRetryEligibleDenial(
  denial: SandboxViolation,
  classified: ClassifiedCommand,
): boolean {
  return (
    denial.operation !== "network-connect" &&
    denial.operation !== "resource-limit" &&
    classified.perSubCommand.length > 0 &&
    classified.perSubCommand.every(
      ({ result }) =>
        result.tier !== "dangerous" &&
        NATIVE_RETRY_ELIGIBLE_COMMAND_CODES.has(result.code),
    )
  );
}

function executionAttemptSummary(
  attempt: 1 | 2,
  result: TerminalCommandResult,
  denial?: SandboxViolation,
): TerminalExecutionAttemptSummary {
  const processLaunched = result.process_launched ?? "unknown";
  const commandSent = result.command_sent ?? "unknown";
  const status = result.timed_out
    ? "timed_out"
    : result.is_running || result.backgrounded
      ? "running"
      : "completed";
  return {
    attempt,
    status,
    route: result.security?.route ?? (attempt === 1 ? "sandbox" : "native"),
    ...(result.security?.auditId ? { audit_id: result.security.auditId } : {}),
    command_sent: commandSent,
    process_launched: processLaunched,
    retry_safe:
      result.retry_safe ?? (commandSent === false && processLaunched === false),
    may_have_side_effects:
      processLaunched === "unknown" ? "unknown" : processLaunched,
    exit_code: result.exit_code,
    terminal_id: result.terminal_id,
    execution_mode: result.execution_mode,
    ...(denial ? { capability_denial: { ...denial } } : {}),
  };
}

function unlaunchedAttemptSummary(
  attempt: 2,
  security: TerminalExecutionSecuritySummary,
  status: "approval_denied" | "cancelled" | "failed",
  failureStage: "preparation" | "approval" | "launch",
): TerminalExecutionAttemptSummary {
  return {
    attempt,
    status,
    route: security.route,
    audit_id: security.auditId,
    command_sent: false,
    process_launched: false,
    retry_safe: true,
    may_have_side_effects: false,
    failure_stage: failureStage,
  };
}

function commandRulePolicyFor(
  approvalManager: ApprovalManager,
  sessionId: string,
  command: string,
  cwd: string,
): CommandRulePolicyEvaluation {
  const evaluator = (
    approvalManager as ApprovalManager & {
      evaluateCommandRules?: ApprovalManager["evaluateCommandRules"];
    }
  ).evaluateCommandRules;
  if (typeof evaluator === "function") {
    return evaluator.call(approvalManager, sessionId, command, cwd);
  }

  // Compatibility for partial ApprovalManager implementations in adapters and
  // tests. Legacy boolean rules may skip approval, but can never grant native
  // authority because they are not explicit Codex allow decisions.
  const commands = expandSubCommands(splitCompoundCommand(command));
  const segments = (commands.length > 0 ? commands : [command.trim()]).map(
    (segment) => ({
      command: segment,
      decision: approvalManager.isCommandApproved(sessionId, segment, cwd)
        ? ("legacy_allow" as const)
        : ("unmatched" as const),
      matches: [],
      explicitlyAllowed: false,
    }),
  );
  const allSegmentsApprovedByRule =
    segments.length > 0 &&
    segments.every((segment) => segment.decision === "legacy_allow");
  return {
    decision: allSegmentsApprovedByRule ? "legacy_allow" : "unmatched",
    segments,
    allSegmentsExplicitlyAllowed: false,
    allSegmentsApprovedByRule,
  };
}

async function reviewManagedNetworkRequest(
  request: ManagedNetworkRequest,
  signal: AbortSignal,
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  providers: ExecuteCommandProviders,
  approvalMode: TerminalApprovalModeSnapshot,
): Promise<"allow-once" | "reject"> {
  if (
    signal.aborted ||
    isCommandApprovalCancelled(request.sessionId, providers)
  ) {
    return "reject";
  }
  const initialPolicy = approvalManager.evaluateNetworkRules(
    request.sessionId,
    request,
  );
  if (initialPolicy.decision === "forbidden") return "reject";
  if (initialPolicy.decision === "allow") return "allow-once";

  let review: NetworkReviewSummary | undefined;
  // Explicit prompt rules preserve human authority even in Approve for Me mode.
  if (
    initialPolicy.decision !== "prompt" &&
    approvalMode.approvalReviewer === "auto-review"
  ) {
    const reviewer = providers.networkApprovalReviewer;
    if (!reviewer) return "reject";
    const result = await reviewer.review({
      request,
      userObjective: providers.getUserObjective?.(request.sessionId),
      context: providers.getReviewContext?.(request.sessionId),
      signal,
    });
    review = result;
    if (result.status !== "reviewed" || result.outcome !== "allow") {
      return "reject";
    }
    const currentPolicy = approvalManager.evaluateNetworkRules(
      request.sessionId,
      request,
    );
    return !signal.aborted &&
      !isCommandApprovalCancelled(request.sessionId, providers) &&
      !hasNetworkApprovalModeDrift(
        providers,
        request.sessionId,
        approvalMode,
      ) &&
      currentPolicy.key === initialPolicy.key &&
      currentPolicy.decision === initialPolicy.decision
      ? "allow-once"
      : "reject";
  }

  const response = await approvalPanel.enqueueNetworkApproval({
    request,
    review,
    signal,
  }).promise;
  if (
    signal.aborted ||
    isCommandApprovalCancelled(request.sessionId, providers) ||
    hasNetworkApprovalModeDrift(providers, request.sessionId, approvalMode) ||
    response.decision === "reject"
  ) {
    return "reject";
  }
  const currentPolicy = approvalManager.evaluateNetworkRules(
    request.sessionId,
    request,
  );
  if (
    currentPolicy.key !== initialPolicy.key ||
    currentPolicy.decision !== initialPolicy.decision
  ) {
    return "reject";
  }
  const scope = networkRuleScope(response);
  if (
    scope &&
    !approvalManager.addNetworkRule(
      request.sessionId,
      { pattern: currentPolicy.key, mode: "exact", decision: "allow" },
      scope,
    )
  ) {
    return "reject";
  }
  return "allow-once";
}

function hasNetworkApprovalModeDrift(
  providers: ExecuteCommandProviders,
  sessionId: string,
  expected: TerminalApprovalModeSnapshot,
): boolean {
  const current = approvalModeFor(providers, sessionId);
  return (
    current.commandApprovalPolicy !== expected.commandApprovalPolicy ||
    current.approvalPolicy !== expected.approvalPolicy ||
    current.approvalReviewer !== expected.approvalReviewer ||
    current.executionPreset !== expected.executionPreset
  );
}

function networkRuleScope(
  response: NetworkApprovalResponse,
): "session" | "project" | "global" | undefined {
  switch (response.decision) {
    case "allow-session":
      return "session";
    case "allow-project":
      return "project";
    case "allow-global":
      return "global";
    default:
      return undefined;
  }
}

function unavailableExecuteCommandResult(command: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error:
            "Command execution is unavailable in this runtime. Provide a TerminalProvider to enable execute_command.",
          command,
          command_sent: false,
        }),
      },
    ],
  };
}

export async function handleExecuteCommand(
  params: {
    command: string;
    cwd?: string;
    terminal_id?: string;
    terminal_name?: string;
    split_from?: string;
    background?: boolean;
    timeout?: number;
    env?: Record<string, string>;
    sandbox_permissions?:
      | "use_default"
      | "require_managed_network"
      | "require_escalated";
    files?: InlineCommandFileInput[];
    output_head?: number;
    output_tail?: number;
    output_offset?: number;
    output_grep?: string;
    output_grep_context?: number;
    force?: boolean;
    force_reason?: string;
    reason?: string;
  },
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
  trackerCtx?: TrackerContext,
  providers: ExecuteCommandProviders = {},
): Promise<ToolResult> {
  try {
    if (!params.command || params.command.trim().length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Command cannot be empty",
              command_sent: false,
            }),
          },
        ],
      };
    }

    if (!providers.terminalProvider) {
      return unavailableExecuteCommandResult(params.command);
    }

    const workspaceRoot = tryGetFirstWorkspaceRoot();

    // Resolve cwd
    let cwd = workspaceRoot ?? os.homedir();
    if (params.cwd) {
      cwd = path.isAbsolute(params.cwd)
        ? params.cwd
        : path.resolve(cwd, params.cwd);
    }

    const workspaceRoots = getWorkspaceRoots();
    const nativeEscalation = params.sandbox_permissions === "require_escalated";
    const managedNetwork =
      params.sandbox_permissions === "require_managed_network";
    if ((nativeEscalation || managedNetwork) && !params.reason?.trim()) {
      return rejectedCommandResult(
        params.command,
        `sandbox_permissions="${params.sandbox_permissions}" requires a non-empty reason explaining why the additional authority is needed.`,
      );
    }
    const approvalMode = approvalModeFor(providers, sessionId);
    const initialRulePolicy = commandRulePolicyFor(
      approvalManager,
      sessionId,
      params.command,
      cwd,
    );
    if (initialRulePolicy.decision === "forbidden") {
      return rejectedCommandResult(
        params.command,
        "Command execution is forbidden by an applicable command policy rule.",
      );
    }
    const initialRulePolicyFingerprint =
      commandRulePolicyFingerprint(initialRulePolicy);
    const explicitRuleAuthority =
      !nativeEscalation &&
      !managedNetwork &&
      !params.files?.length &&
      !params.env &&
      !params.force &&
      !params.force_reason &&
      approvalMode.commandApprovalPolicy === "approve-for-me" &&
      initialRulePolicy.allSegmentsExplicitlyAllowed;
    const routeContext = routeContextFor(
      approvalMode,
      nativeEscalation
        ? "native-escalation"
        : managedNetwork
          ? "additional-permissions"
          : "default",
      providers.commandExecutionPolicy,
      explicitRuleAuthority,
    );
    const readOnlyPolicy =
      routeContext.commandExecutionPolicySnapshot === "read-only";
    if (readOnlyPolicy) {
      const rejectionReason = getReadOnlyCommandRejectionReason(
        params,
        cwd,
        workspaceRoots,
      );
      if (rejectionReason) {
        return rejectedCommandResult(params.command, rejectionReason);
      }
      if (routeContext.commandApprovalPolicySnapshot !== "approve-for-me") {
        return rejectedCommandResult(
          params.command,
          "Read-only command execution requires Approve for Me because Sandbox terminals are disabled under the current command approval policy.",
        );
      }
    }

    // Master bypass check
    const masterBypass = getConfiguredMasterBypass();

    let commandToRun = params.command;
    let commandEditedByUser = false;
    let inlineRun: ReturnType<typeof materializeInlineCommandFiles> | undefined;
    let inlineFiles: InlineCommandFilePreview[] | undefined;
    let commandFinalizationDeferred = false;
    let preparedExecution: PreparedTerminalExecution | undefined;
    let inlineCleanupComplete = false;
    const cleanupInlineRun = () => {
      if (inlineCleanupComplete) return;
      inlineCleanupComplete = true;
      inlineRun?.cleanup();
    };
    let commitApprovalMutations: (() => void) | undefined;
    let approvalFollowUp: string | undefined;
    let approvalAudit: CommandApprovalAudit | undefined = readOnlyPolicy
      ? { by: "readonly_policy" }
      : !nativeEscalation && !managedNetwork && masterBypass
        ? { by: "master_bypass" }
        : undefined;
    let autoApprovedByTier:
      | { tier: CommandTier; threshold: "safe" | "sensitive" }
      | undefined;

    if (params.files && params.files.length > 0) {
      if (process.platform === "win32") {
        return rejectedCommandResult(
          params.command,
          "execute_command files require a POSIX shell in this version; cmd.exe and PowerShell are not supported yet.",
        );
      }
      try {
        inlineRun = materializeInlineCommandFiles(params.command, params.files);
        if (inlineRun) {
          commandToRun = inlineRun.command;
          inlineFiles = inlineRun.previews;
        }
      } catch (err) {
        if (err instanceof InlineCommandFileError) {
          return rejectedCommandResult(params.command, err.message);
        }
        throw err;
      }
    }

    try {
      // Reject malformed shell syntax before masterBypass or force=true can skip
      // the normal command approval path.
      const malformedCommandReason =
        validateMalformedShellCommand(commandToRun);
      if (malformedCommandReason) {
        return malformedCommandResult(commandToRun, malformedCommandReason, {
          ...(commandToRun !== params.command && {
            commandTemplate: params.command,
          }),
        });
      }

      // Reject protected instruction/memory writes before masterBypass or force=true
      // can skip the normal command approval path.
      const protectedWriteViolation = validateProtectedWriteCommand(
        commandToRun,
        cwd,
      );
      if (protectedWriteViolation) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "rejected",
                command: commandToRun,
                ...(commandToRun !== params.command && {
                  command_template: params.command,
                }),
                reason: protectedWriteViolation.message,
                protected_path: protectedWriteViolation.protectedPath,
                command_sent: false,
              }),
            },
          ],
        };
      }

      // Reject disallowed command patterns (direct head/tail/cat/grep, piped filtering)
      const commandViolation = validateCommand(commandToRun);
      if (commandViolation) {
        // force=true can only bypass "direct" violations (shell expansion false positives),
        // never "pipe" violations — those have dedicated output_* params with no false positives.
        const canBypass =
          params.force &&
          commandViolation.type === "direct" &&
          params.force_reason;

        if (!canBypass) {
          const reason =
            params.force && commandViolation.type === "pipe"
              ? commandViolation.message +
                "\n\nforce=true cannot bypass pipe filtering rejections. Use the output_grep/output_head/output_tail parameters instead."
              : params.force && !params.force_reason
                ? commandViolation.message +
                  "\n\nforce=true requires a force_reason explaining why the rejection is a false positive."
                : commandViolation.message;

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "rejected",
                  command: commandToRun,
                  ...(commandToRun !== params.command && {
                    command_template: params.command,
                  }),
                  reason,
                  command_sent: false,
                }),
              },
            ],
          };
        }
      }

      // Reject known interactive commands (editors, REPLs, TUI apps, etc.)
      const interactiveViolation = validateInteractiveCommand(commandToRun);
      if (interactiveViolation) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "rejected",
                command: commandToRun,
                ...(commandToRun !== params.command && {
                  command_template: params.command,
                }),
                reason: interactiveViolation.message,
                command_sent: false,
              }),
            },
          ],
        };
      }

      const terminalOptions = (): TerminalExecuteOptions => ({
        command: commandToRun,
        cwd,
        terminal_id: params.terminal_id,
        terminal_name: params.terminal_name,
        split_from: params.split_from,
        background: params.background,
        timeout: params.timeout ? params.timeout * 1000 : undefined,
        env: params.env,
        sandboxSessionId: sessionId,
        sandboxCapabilityRequest: managedNetwork
          ? { unrestrictedPublicNetwork: true }
          : undefined,
        onManagedNetworkRequest: managedNetwork
          ? (request, signal) =>
              reviewManagedNetworkRequest(
                request,
                signal,
                approvalManager,
                approvalPanel,
                providers,
                approvalMode,
              )
          : undefined,
        sandboxInlineFiles: inlineFiles?.map((file) => ({
          name: file.name,
          path: file.path,
          bytes: file.bytes,
          sha256: file.sha256,
        })),
        onTerminalAssigned: trackerCtx
          ? (tid) => trackerCtx.setTerminalId(tid)
          : undefined,
        onCommandFinalizationDeferred: inlineRun
          ? () => {
              commandFinalizationDeferred = true;
            }
          : undefined,
        onCommandFinalized: inlineRun ? cleanupInlineRun : undefined,
      });
      preparedExecution = await prepareTerminalExecution(
        providers.terminalProvider,
        terminalOptions(),
        routeContext,
      );

      if (
        nativeEscalation ||
        managedNetwork ||
        (!masterBypass && !readOnlyPolicy)
      ) {
        // Gate: only one command goes through approval at a time, so pending
        // dialogs aren't buried by terminals from auto-approved commands.
        const releaseGate = await approvalGate.acquire();
        try {
          const subCommands = splitCompoundCommand(params.command);
          const approvalResult = await approveSubCommands(
            subCommands,
            params.command,
            approvalManager,
            approvalPanel,
            sessionId,
            params.reason,
            cwd,
            workspaceRoots,
            {
              displayCommand: commandToRun,
              inlineFiles,
              requireHumanApproval: inlineFiles !== undefined,
              requireFreshReview: nativeEscalation || managedNetwork,
              rulePolicy: initialRulePolicy,
              ruleFastPathAllowed:
                !inlineFiles &&
                !managedNetwork &&
                !params.env &&
                !params.force &&
                !params.force_reason,
              hasEnvOverrides: Boolean(
                params.env && Object.keys(params.env).length > 0,
              ),
              forceRequested: Boolean(params.force || params.force_reason),
              routeContext,
              providers,
              security: preparedExecution.security,
            },
          );

          if (approvalResult.policyDrift) {
            const driftedPreparation = preparedExecution;
            preparedExecution = undefined;
            driftedPreparation.dispose();
            recordExecutionAudit(
              providers.terminalProvider,
              "preparation_revoked",
              driftedPreparation.security,
              { failure: "policy_drift", resultStatus: "policy_drift" },
            );
            return policyDriftResult(
              params.command,
              driftedPreparation.security,
            );
          }

          if (approvalResult.cancelled) {
            recordExecutionAudit(
              providers.terminalProvider,
              "execution_cancelled",
              preparedExecution.security,
              { resultStatus: "approval_cancelled" },
            );
            return cancelledCommandResult(
              params.command,
              preparedExecution.security,
            );
          }

          if (!approvalResult.approved) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    status: approvalResult.reviewCircuitInterrupted
                      ? "review_interrupted"
                      : "rejected_by_user",
                    command: params.command,
                    reason: approvalResult.reviewCircuitInterrupted
                      ? "Automatic command review stopped after repeated denials in this turn. Use a materially safer approach or ask the user."
                      : approvalResult.reason,
                    security: preparedExecution.security,
                    command_sent: false,
                  }),
                },
              ],
            };
          }

          if (approvalResult.editedCommand) {
            commandEditedByUser = true;
            commandToRun = approvalResult.editedCommand;
            try {
              assertNoInvalidInlineFileTokens(commandToRun);
              if (commandToRun.match(INLINE_FILE_TOKEN_RE)) {
                throw new InlineCommandFileError(
                  "unresolved_token",
                  "Edited command contains an unresolved $AL_FILE(name) token.",
                );
              }
            } catch (err) {
              if (err instanceof InlineCommandFileError) {
                return rejectedCommandResult(commandToRun, err.message);
              }
              throw err;
            }
            const editedValidation = validateCommandBeforeExecution(
              commandToRun,
              cwd,
              params.command,
            );
            if (editedValidation) return editedValidation;
            const displayedSecurity = preparedExecution.security;
            preparedExecution.dispose();
            preparedExecution = await prepareTerminalExecution(
              providers.terminalProvider,
              terminalOptions(),
              routeContext,
            );
            if (
              !sameDisplayedSecurityBasis(
                displayedSecurity,
                preparedExecution.security,
              )
            ) {
              return rejectedCommandResult(
                commandToRun,
                "The prepared execution security basis changed after the command edit. Review and approve the command again.",
              );
            }
          }

          commitApprovalMutations = approvalResult.commitMutations;
          approvalFollowUp = approvalResult.followUp;
          approvalAudit = approvalResult.approval;
          if (approvalAudit) {
            recordExecutionAudit(
              providers.terminalProvider,
              "approval_decided",
              preparedExecution.security,
              {
                approvalBasis: approvalAudit.by,
                resultStatus: "approved",
              },
            );
          }
          autoApprovedByTier = approvalResult.autoApprovedByTier;
        } finally {
          releaseGate();
        }
      }

      const currentRulePolicy = commandRulePolicyFor(
        approvalManager,
        sessionId,
        params.command,
        cwd,
      );
      if (
        !commandEditedByUser &&
        commandRulePolicyFingerprint(currentRulePolicy) !==
          initialRulePolicyFingerprint
      ) {
        const driftedPreparation = preparedExecution;
        preparedExecution = undefined;
        driftedPreparation.dispose();
        recordExecutionAudit(
          providers.terminalProvider,
          "preparation_revoked",
          driftedPreparation.security,
          { failure: "policy_drift", resultStatus: "rule_policy_drift" },
        );
        return policyDriftResult(commandToRun, driftedPreparation.security);
      }
      if (hasPolicyDrift(providers, sessionId, routeContext)) {
        const driftedPreparation = preparedExecution;
        preparedExecution = undefined;
        driftedPreparation.dispose();
        recordExecutionAudit(
          providers.terminalProvider,
          "preparation_revoked",
          driftedPreparation.security,
          { failure: "policy_drift", resultStatus: "policy_drift" },
        );
        return policyDriftResult(commandToRun, driftedPreparation.security);
      }
      if (isCommandApprovalCancelled(sessionId, providers)) {
        recordExecutionAudit(
          providers.terminalProvider,
          "execution_cancelled",
          preparedExecution.security,
          { resultStatus: "session_cancelled" },
        );
        return cancelledCommandResult(commandToRun, preparedExecution.security);
      }
      if (approvalAudit && (masterBypass || readOnlyPolicy)) {
        recordExecutionAudit(
          providers.terminalProvider,
          "approval_fast_path_selected",
          preparedExecution.security,
          {
            approvalBasis: approvalAudit.by,
            resultStatus: "approved",
          },
        );
      }

      commitApprovalMutations?.();
      const execution = preparedExecution;
      preparedExecution = undefined;
      let result = await execution.execute();
      result.security = execution.security;

      const capabilityDenial = sandboxCapabilityDenial(result);
      if (capabilityDenial) {
        const retryLineageId = randomUUID();
        const firstAttempt = executionAttemptSummary(
          1,
          result,
          capabilityDenial,
        );
        const retryClassification = classifyCommand(commandToRun, {
          cwd,
          workspaceRoots,
        });
        const retryUnsupportedReason = !isNativeRetryEligibleDenial(
          capabilityDenial,
          retryClassification,
        )
          ? capabilityDenial.operation === "network-connect"
            ? "Managed network capability review is required; native retry was not attempted."
            : capabilityDenial.operation === "resource-limit"
              ? "Resource-limit denials are not retried outside the sandbox."
              : `Native retry was not attempted because the command is not a recognized read-only, version, or project-toolchain operation (${
                  retryClassification.perSubCommand
                    .map(({ command, result }) => `${command}: ${result.code}`)
                    .join("; ") || "no classified command"
                }).`
          : routeContext.commandApprovalPolicySnapshot !== "approve-for-me"
            ? "Automatic native retry requires Approve for Me."
            : readOnlyPolicy
              ? "Read-only execution policy does not permit native retry."
              : inlineFiles
                ? "Commands with temporary inline files cannot be replayed after sandbox completion."
                : commandEditedByUser
                  ? "Commands edited during approval require a new explicit invocation before native retry."
                  : params.terminal_id ||
                      params.terminal_name ||
                      params.split_from
                    ? "Commands pinned to a terminal target cannot switch execution authority automatically."
                    : undefined;

        if (retryUnsupportedReason) {
          result.capability_denial = { ...capabilityDenial };
          result.retry_lineage_id = retryLineageId;
          result.retry_outcome = "not_attempted";
          result.retry_reason = retryUnsupportedReason;
          result.execution_attempts = [firstAttempt];
          result.retry_safe = firstAttempt.retry_safe;
        } else {
          const retryRouteContext = routeContextFor(
            approvalModeFor(providers, sessionId),
            "native-escalation",
            providers.commandExecutionPolicy,
          );
          const retryReason = `The sandbox denied ${capabilityDenial.operation}${
            capabilityDenial.target ? ` for ${capabilityDenial.target}` : ""
          }: ${capabilityDenial.reason}`;
          let retryExecution: PreparedTerminalExecution;
          try {
            retryExecution = await prepareTerminalExecution(
              providers.terminalProvider,
              terminalOptions(),
              retryRouteContext,
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      status: "retry_failed",
                      command: commandToRun,
                      cwd,
                      error: message,
                      command_sent: firstAttempt.command_sent,
                      process_launched: firstAttempt.process_launched,
                      retry_safe: false,
                      failure_stage: "preparation",
                      capability_denial: { ...capabilityDenial },
                      retry_lineage_id: retryLineageId,
                      retry_outcome: "failed",
                      execution_attempts: [
                        firstAttempt,
                        {
                          attempt: 2,
                          status: "failed",
                          route: "native",
                          command_sent: false,
                          process_launched: false,
                          retry_safe: true,
                          may_have_side_effects: false,
                          failure_stage: "preparation",
                        },
                      ],
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }

          try {
            const releaseGate = await approvalGate.acquire();
            let retryApproval: Awaited<ReturnType<typeof approveSubCommands>>;
            try {
              retryApproval = await approveSubCommands(
                splitCompoundCommand(commandToRun),
                commandToRun,
                approvalManager,
                approvalPanel,
                sessionId,
                retryReason,
                cwd,
                workspaceRoots,
                {
                  displayCommand: commandToRun,
                  requireFreshReview: true,
                  hasEnvOverrides: Boolean(
                    params.env && Object.keys(params.env).length > 0,
                  ),
                  forceRequested: Boolean(params.force || params.force_reason),
                  routeContext: retryRouteContext,
                  providers,
                  security: retryExecution.security,
                },
              );
            } finally {
              releaseGate();
            }

            if (retryApproval.approval) {
              recordExecutionAudit(
                providers.terminalProvider,
                "approval_decided",
                retryExecution.security,
                {
                  approvalBasis: retryApproval.approval.by,
                  resultStatus: "approved",
                },
              );
            }
            const retryStatus = retryApproval.cancelled
              ? "cancelled"
              : "approval_denied";
            if (
              retryApproval.policyDrift ||
              retryApproval.cancelled ||
              !retryApproval.approved ||
              retryApproval.editedCommand
            ) {
              const reason = retryApproval.policyDrift
                ? "Command approval or execution policy changed before the native retry."
                : retryApproval.cancelled
                  ? "Native retry approval was cancelled."
                  : retryApproval.editedCommand
                    ? "A native retry must use the exact command from the sandbox attempt; edited retries are not executed automatically."
                    : retryApproval.reviewCircuitInterrupted
                      ? "Automatic command review stopped after repeated denials in this turn."
                      : (retryApproval.reason ??
                        "Native retry was not approved.");
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      {
                        status: retryApproval.policyDrift
                          ? "retry_required"
                          : retryApproval.reviewCircuitInterrupted
                            ? "review_interrupted"
                            : retryStatus === "cancelled"
                              ? "cancelled"
                              : "rejected_by_user",
                        command: commandToRun,
                        cwd,
                        reason,
                        security: retryExecution.security,
                        command_sent: firstAttempt.command_sent,
                        process_launched: firstAttempt.process_launched,
                        retry_safe: false,
                        failure_stage: "approval",
                        capability_denial: { ...capabilityDenial },
                        retry_lineage_id: retryLineageId,
                        retry_outcome:
                          retryStatus === "cancelled"
                            ? "cancelled"
                            : "approval_denied",
                        execution_attempts: [
                          firstAttempt,
                          unlaunchedAttemptSummary(
                            2,
                            retryExecution.security,
                            retryStatus,
                            "approval",
                          ),
                        ],
                      },
                      null,
                      2,
                    ),
                  },
                ],
              };
            }

            if (
              hasPolicyDrift(providers, sessionId, retryRouteContext) ||
              isCommandApprovalCancelled(sessionId, providers)
            ) {
              const policyDrift = hasPolicyDrift(
                providers,
                sessionId,
                retryRouteContext,
              );
              recordExecutionAudit(
                providers.terminalProvider,
                policyDrift ? "preparation_revoked" : "execution_cancelled",
                retryExecution.security,
                policyDrift
                  ? { failure: "policy_drift", resultStatus: "policy_drift" }
                  : { resultStatus: "session_cancelled" },
              );
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      {
                        status: policyDrift ? "retry_required" : "cancelled",
                        command: commandToRun,
                        cwd,
                        reason:
                          "Native retry was cancelled before execution because the session or policy changed.",
                        security: retryExecution.security,
                        command_sent: firstAttempt.command_sent,
                        process_launched: firstAttempt.process_launched,
                        retry_safe: false,
                        failure_stage: "approval",
                        capability_denial: { ...capabilityDenial },
                        retry_lineage_id: retryLineageId,
                        retry_outcome: "cancelled",
                        execution_attempts: [
                          firstAttempt,
                          unlaunchedAttemptSummary(
                            2,
                            retryExecution.security,
                            "cancelled",
                            "approval",
                          ),
                        ],
                      },
                      null,
                      2,
                    ),
                  },
                ],
              };
            }

            retryApproval.commitMutations?.();
            let retryResult: TerminalCommandResult;
            try {
              retryResult = await retryExecution.execute();
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      {
                        status: "retry_failed",
                        command: commandToRun,
                        cwd,
                        error: message,
                        security: retryExecution.security,
                        command_sent: firstAttempt.command_sent,
                        process_launched: firstAttempt.process_launched,
                        retry_safe: false,
                        failure_stage: "launch",
                        capability_denial: { ...capabilityDenial },
                        retry_lineage_id: retryLineageId,
                        retry_outcome: "failed",
                        execution_attempts: [
                          firstAttempt,
                          {
                            attempt: 2,
                            status: "failed",
                            route: retryExecution.security.route,
                            audit_id: retryExecution.security.auditId,
                            command_sent: "unknown",
                            process_launched: "unknown",
                            retry_safe: false,
                            may_have_side_effects: "unknown",
                            failure_stage: "launch",
                          },
                        ],
                      },
                      null,
                      2,
                    ),
                  },
                ],
              };
            }
            retryResult.security = retryExecution.security;
            retryResult.approval = retryApproval.approval;
            retryResult.follow_up = retryApproval.followUp;
            retryResult.capability_denial = { ...capabilityDenial };
            retryResult.retry_lineage_id = retryLineageId;
            retryResult.retry_outcome = "completed";
            retryResult.retry_safe = false;
            retryResult.execution_attempts = [
              firstAttempt,
              executionAttemptSummary(2, retryResult),
            ];
            result = retryResult;
          } finally {
            retryExecution.dispose();
          }
        }
      }

      // Raw shell-integration output duplicates `output` and includes ANSI/control
      // sequences. Keep it inside the terminal provider instead of sending both
      // representations through the model-facing tool result.
      delete result.terminal_raw_output;

      // Apply output filtering and temp file saving. Background and timed-out
      // commands may have a larger exact spool than the bounded display tail.
      const retainedOutput = providers.terminalProvider.getRetainedOutput?.(
        result.terminal_id,
      );
      if (retainedOutput) {
        result.output = retainedOutput.output;
        result.output_complete = retainedOutput.complete;
        result.output_finalized = retainedOutput.finalized;
        result.output_total_bytes = retainedOutput.total_bytes;
        result.output_retained_bytes = retainedOutput.retained_bytes;
        result.output_dropped_bytes = retainedOutput.dropped_bytes;
      } else if (result.output_complete === undefined) {
        result.output_complete = true;
        result.output_finalized = !result.is_running;
      }
      if (result.output_captured && result.output) {
        const fullOutput = result.output;
        const filterOptions = {
          output_head: params.output_head,
          output_tail: params.output_tail,
          output_offset: params.output_offset,
          output_grep: params.output_grep,
          output_grep_context: params.output_grep_context,
        };
        const { filtered, totalLines, linesShown } = filterOutput(
          fullOutput,
          filterOptions,
        );

        result.total_lines = totalLines;
        result.lines_shown = linesShown;
        result.total_lines_scope =
          result.output_finalized === false || result.output_complete === false
            ? "retained"
            : "complete";

        if (result.output_finalized === false) {
          result.output_warning =
            "Terminal output is still running or was closed before finalization. Filtering applies to retained output so far; no final output file is available.";
        } else if (result.output_complete === false) {
          result.output_warning = `⚠️ Terminal output exceeded the bounded capture limit. ${result.output_dropped_bytes === undefined ? "Some output" : formatBytes(result.output_dropped_bytes)} was not retained; filtering applies only to the retained tail and no full-output file is available.`;
        } else if (linesShown < totalLines) {
          const outputFile = saveOutputTempFile(fullOutput);
          if (outputFile) {
            result.output_file = outputFile;
            result.output_warning =
              "⚠️ Output was truncated. Full output saved to output_file — use read_file(output_file) to access it. Do NOT re-run this command.";
          }
        }

        result.output = filtered;
      } else if (!result.output_captured && !result.output) {
        result.output =
          "Command execution was sent to the terminal, but no output was captured.";
      }

      if (inlineFiles) {
        result.inline_files = inlineFiles.map((file) => ({
          name: file.name,
          bytes: file.bytes,
          sha256: file.sha256,
        }));
        result.command_template = params.command;
        result.command = commandToRun;
      }

      // If the user edited the command, include modification info
      if (commandEditedByUser) {
        result.command_modified = true;
        result.original_command = params.command;
        result.command = commandToRun;
      }

      if (approvalAudit && result.retry_outcome !== "completed") {
        result.approval = approvalAudit;
      }

      if (autoApprovedByTier && result.retry_outcome !== "completed") {
        result.auto_approved = {
          by: "tier",
          tier: autoApprovedByTier.tier,
          threshold: autoApprovedByTier.threshold,
        };
      }

      if (approvalFollowUp && result.retry_outcome !== "completed") {
        result.follow_up = approvalFollowUp;
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } finally {
      preparedExecution?.dispose();
      if (!commandFinalizationDeferred) {
        cleanupInlineRun();
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const lowerMessage = message.toLowerCase();
    const newlineRegexHint =
      lowerMessage.includes("ripgrep error") &&
      lowerMessage.includes("regex") &&
      lowerMessage.includes("newline")
        ? 'Your regex appears to contain a literal newline. Remove the literal newline from the command string and use escaped \\n with multiline mode instead (e.g. pattern: "foo\\nbar", plus --multiline).'
        : undefined;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: message,
            ...(newlineRegexHint && { hint: newlineRegexHint }),
            command: params.command,
          }),
        },
      ],
    };
  }
}

function getReadOnlyCommandRejectionReason(
  params: Parameters<typeof handleExecuteCommand>[0],
  cwd: string,
  workspaceRoots: string[],
): string | undefined {
  const unsupported = [
    ["terminal_id", params.terminal_id],
    ["terminal_name", params.terminal_name],
    ["split_from", params.split_from],
    ["background", params.background],
    ["timeout", params.timeout],
    ["env", params.env],
    ["files", params.files],
    ["sandbox_permissions", params.sandbox_permissions],
    ["force", params.force],
    ["force_reason", params.force_reason],
  ].find(([, value]) => value !== undefined);
  if (unsupported) {
    return `Read-only command execution does not allow the ${unsupported[0]} parameter`;
  }
  if (!isCommandPathInsideWorkspace(cwd, workspaceRoots)) {
    return "Read-only command execution requires a working directory inside the workspace";
  }

  const eligibility = isCommandEligibleForReadOnlyExecution(params.command, {
    cwd,
    workspaceRoots,
  });
  if (!eligibility.eligible) {
    return `Read-only command execution rejected ${eligibility.reason}`;
  }
  return undefined;
}

function cancelledCommandResult(
  command: string,
  security?: TerminalExecutionSecuritySummary,
): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "cancelled",
          command,
          reason: "Command approval was cancelled before execution",
          ...(security ? { security } : {}),
          command_sent: false,
        }),
      },
    ],
  };
}

function rejectedCommandResult(command: string, reason: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "rejected",
          command,
          reason,
          command_sent: false,
        }),
      },
    ],
  };
}

function isMalformedShellState(state: ShellLexFinalState): boolean {
  return state.quote !== null || state.danglingEscape;
}

function validateMalformedShellCommand(command: string): string | null {
  const finalStates = [
    scanShellLexBoundaries(command).finalState,
    scanShellLexWords(command).finalState,
    scanShellLexTokens(command, {
      escapeInSingleQuotes: true,
      operators: [">>", ">", "<"],
    }).finalState,
  ];

  if (!finalStates.some(isMalformedShellState)) return null;

  return "Command has malformed shell syntax: close any open quotes and remove dangling trailing escapes before running.";
}

function malformedCommandResult(
  command: string,
  reason: string,
  extra: { commandTemplate?: string; originalCommand?: string } = {},
): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "rejected",
          command,
          ...(extra.commandTemplate && {
            command_template: extra.commandTemplate,
          }),
          ...(extra.originalCommand && {
            original_command: extra.originalCommand,
          }),
          reason,
          command_sent: false,
        }),
      },
    ],
  };
}

/**
 * Approve sub-commands by showing a single dialog with the full command.
 *
 * - Split compound command, expand wrappers into separate sub-commands
 * - Build enriched entries with existing matching rules
 * - Run/Edit/Reject applies to the whole command at once
 * - Always-visible per-sub-command rule editor with per-row scope
 */
async function approveSubCommands(
  subCommands: string[],
  fullCommand: string,
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
  reason: string | undefined,
  cwd: string,
  workspaceRoots: string[],
  options?: {
    displayCommand?: string;
    inlineFiles?: InlineCommandFilePreview[];
    requireHumanApproval?: boolean;
    requireFreshReview?: boolean;
    rulePolicy?: ReturnType<ApprovalManager["evaluateCommandRules"]>;
    ruleFastPathAllowed?: boolean;
    hasEnvOverrides?: boolean;
    forceRequested?: boolean;
    routeContext: TerminalExecutionRouteContext;
    providers?: ExecuteCommandProviders;
    security?: TerminalExecutionSecuritySummary;
  },
): Promise<{
  approved: boolean;
  reason?: string;
  editedCommand?: string;
  followUp?: string;
  approval?: CommandApprovalAudit;
  autoApprovedByTier?: { tier: CommandTier; threshold: "safe" | "sensitive" };
  cancelled?: boolean;
  policyDrift?: boolean;
  reviewCircuitInterrupted?: boolean;
  commitMutations?: () => void;
}> {
  // Expand wrappers: ["cd /foo", "sudo npm install"] → ["cd /foo", "sudo", "npm install"]
  const expanded = expandSubCommands(subCommands);

  const reviewProviders = options?.providers;
  const actionKey = commandReviewActionKey({
    command: fullCommand,
    cwd,
    security: options?.security,
  });
  const retainedDenial =
    reviewProviders?.retainedCommandReviewDenials?.has(sessionId, actionKey) ??
    false;
  const circuitInterrupted =
    reviewProviders?.commandReviewTurnCircuit?.interrupted ?? false;

  // Check if all expanded sub-commands are already approved. Recent one-time
  // approvals are checked after project attribution is captured by enqueue.
  const rulePolicy =
    options?.rulePolicy ??
    commandRulePolicyFor(approvalManager, sessionId, fullCommand, cwd);
  if (rulePolicy.decision === "forbidden") {
    return {
      approved: false,
      reason:
        "Command execution is forbidden by an applicable command policy rule.",
    };
  }
  const allApproved =
    options?.ruleFastPathAllowed !== false &&
    rulePolicy.decision !== "prompt" &&
    rulePolicy.allSegmentsApprovedByRule;
  if (
    !options?.requireHumanApproval &&
    !options?.requireFreshReview &&
    !retainedDenial &&
    allApproved
  ) {
    return { approved: true, approval: { by: "explicit_rule" } };
  }

  const classificationCommand = options?.inlineFiles?.length
    ? (options.displayCommand ?? fullCommand)
    : fullCommand;
  const tierInfo = classifyCommand(classificationCommand, {
    cwd,
    workspaceRoots,
  });
  const policy =
    options?.routeContext.commandApprovalPolicySnapshot ?? "manual";
  const threshold = policy === "sensitive" ? "sensitive" : "safe";
  const deterministicallyApproved =
    rulePolicy.decision !== "prompt" &&
    !options?.requireHumanApproval &&
    !retainedDenial &&
    !options?.requireFreshReview &&
    ((tierInfo.tier === "safe" && policy !== "manual") ||
      (tierInfo.tier === "sensitive" && policy === "sensitive"));
  if (deterministicallyApproved) {
    return {
      approved: true,
      approval: { by: "tier", tier: tierInfo.tier, threshold },
      autoApprovedByTier: { tier: tierInfo.tier, threshold },
    };
  }

  const inlineFiles = options?.inlineFiles;
  const hasEnvOverrides = Boolean(options?.hasEnvOverrides);
  const forceRequested = Boolean(options?.forceRequested);
  let commandReview: CommandReviewSummary | undefined;
  let humanOnlyReason: string | undefined;
  if (circuitInterrupted) {
    return { approved: false, reviewCircuitInterrupted: true };
  }
  if (policy === "approve-for-me" && reviewProviders?.commandApprovalReviewer) {
    const eligibility = getCommandAutoApprovalEligibility({
      classified: tierInfo,
      cwd,
      workspaceRoots,
      inlineFiles,
      security: options?.security,
      hasEnvOverrides,
      forceRequested,
    });
    if (!eligibility.eligible) {
      humanOnlyReason = eligibility.reason;
    } else {
      const reviewedCommand = fullCommand;
      if (options?.security && reviewProviders.terminalProvider) {
        recordExecutionAudit(
          reviewProviders.terminalProvider,
          "review_started",
          options.security,
        );
      }
      const review = await reviewProviders.commandApprovalReviewer.review({
        sessionId,
        command: reviewedCommand,
        cwd,
        workspaceRoots,
        reason,
        userObjective: reviewProviders.getUserObjective?.(sessionId),
        context: reviewProviders.getReviewContext?.(sessionId),
        classified: tierInfo,
        security: options?.security,
        inlineFiles,
        signal: reviewProviders.toolAbortSignal,
      });
      if (options?.security && reviewProviders.terminalProvider) {
        recordExecutionAudit(
          reviewProviders.terminalProvider,
          "review_completed",
          options.security,
          { resultStatus: review.status },
        );
      }
      if (
        options?.routeContext &&
        hasPolicyDrift(reviewProviders, sessionId, options.routeContext)
      ) {
        return { approved: false, policyDrift: true };
      }
      const sessionActive =
        reviewProviders.isSessionActive?.(sessionId) ??
        !reviewProviders.toolAbortSignal?.aborted;
      const circuitDecision =
        reviewProviders.commandReviewTurnCircuit?.record(review);
      if (circuitDecision?.explicitDenial) {
        reviewProviders.retainedCommandReviewDenials?.retain(
          sessionId,
          actionKey,
        );
      }
      if (circuitDecision?.interrupted) {
        return { approved: false, reviewCircuitInterrupted: true };
      }
      const reviewerApproved =
        review.status === "reviewed" && review.outcome === "allow";
      if (
        reviewerApproved &&
        sessionActive &&
        !reviewProviders.toolAbortSignal?.aborted &&
        reviewedCommand === fullCommand
      ) {
        reviewProviders.retainedCommandReviewDenials?.clear(
          sessionId,
          actionKey,
        );
        return {
          approved: true,
          approval: {
            by: "model_reviewer",
            model: review.model,
            tier: tierInfo.tier,
            outcome: "allow",
            risk: review.risk,
            user_authorization: review.userAuthorization,
            rationale: review.rationale.slice(0, 500),
          },
        };
      }
      if (!reviewerApproved) {
        commandReview = {
          status: review.status,
          outcome: review.outcome,
          risk: review.risk,
          userAuthorization: review.userAuthorization,
          rationale: review.rationale.slice(0, 500),
          model: review.model,
        };
      }
    }
  }
  if (isCommandApprovalCancelled(sessionId, reviewProviders)) {
    return { approved: false, cancelled: true };
  }

  const tierByCommand = new Map(
    tierInfo.perSubCommand.map((entry) => [entry.command, entry.result]),
  );

  // Build enriched entries for ALL sub-commands (even already-approved ones)
  const entries: SubCommandEntry[] = expanded.map((cmd) => {
    const match = approvalManager.findMatchingCommandRule(sessionId, cmd, cwd);
    if (match) {
      return {
        command: cmd,
        existingRule: {
          pattern: match.rule.pattern,
          mode: match.rule.mode,
          decision: match.rule.decision,
          scope: match.scope,
        },
        tier: tierByCommand.get(cmd),
      };
    }
    return { command: cmd, tier: tierByCommand.get(cmd) };
  });

  // Show dialog with full command + enriched sub-command entries
  if (options?.security && options.providers?.terminalProvider) {
    recordExecutionAudit(
      options.providers.terminalProvider,
      "human_approval_requested",
      options.security,
    );
  }
  const { promise, commitApprovalRecording = () => {} } =
    approvalPanel.enqueueCommandApproval(
      options?.displayCommand ?? fullCommand,
      fullCommand,
      {
        subCommands: entries,
        inlineFiles: options?.inlineFiles,
        reason,
        cwd,
        commandReview,
        humanOnlyReason,
        security: options?.security,
        sessionId,
        signal: reviewProviders?.toolAbortSignal,
        deferApprovalRecording: true,
        bypassRecentApproval: options?.requireFreshReview,
      },
    );
  const response = await promise;

  if (isCommandApprovalCancelled(sessionId, reviewProviders)) {
    return { approved: false, cancelled: true };
  }
  if (
    options?.routeContext &&
    reviewProviders &&
    hasPolicyDrift(reviewProviders, sessionId, options.routeContext)
  ) {
    return { approved: false, policyDrift: true };
  }

  if (response.decision === "reject") {
    return { approved: false, reason: response.rejectionReason };
  }

  let mutationsCommitted = false;
  const commitMutations = () => {
    if (mutationsCommitted) return;
    mutationsCommitted = true;
    commitApprovalRecording();
    for (const rule of response.rules ?? []) {
      if (rule.mode === "skip" || rule.scope === "skip" || !rule.pattern)
        continue;
      approvalManager.addCommandRule(
        sessionId,
        {
          pattern: rule.pattern,
          mode: rule.mode,
          decision: rule.decision,
        },
        rule.scope,
        cwd,
      );
    }
  };

  if (response.editedCommand) {
    return {
      approved: true,
      approval: { by: "human_edited" },
      editedCommand: response.editedCommand,
      followUp: response.followUp,
      commitMutations,
    };
  }
  return {
    approved: true,
    approval: response.recentApproval
      ? { by: "recent_approval" }
      : { by: "human" },
    followUp: response.followUp,
    commitMutations,
  };
}

function isCommandApprovalCancelled(
  sessionId: string,
  providers: ExecuteCommandProviders | undefined,
): boolean {
  return Boolean(
    providers?.toolAbortSignal?.aborted ||
    (providers?.isSessionActive && !providers.isSessionActive(sessionId)),
  );
}

function validateCommandBeforeExecution(
  command: string,
  cwd: string,
  originalCommand?: string,
): ToolResult | null {
  const malformedCommandReason = validateMalformedShellCommand(command);
  if (malformedCommandReason) {
    return malformedCommandResult(command, malformedCommandReason, {
      ...(originalCommand && { originalCommand }),
    });
  }

  const protectedWriteViolation = validateProtectedWriteCommand(command, cwd);
  if (protectedWriteViolation) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "rejected",
            command,
            ...(originalCommand && { original_command: originalCommand }),
            reason: protectedWriteViolation.message,
            protected_path: protectedWriteViolation.protectedPath,
            command_sent: false,
          }),
        },
      ],
    };
  }

  const commandViolation = validateCommand(command);
  if (commandViolation) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "rejected",
            command,
            ...(originalCommand && { original_command: originalCommand }),
            reason: commandViolation.message,
            command_sent: false,
          }),
        },
      ],
    };
  }

  const interactiveViolation = validateInteractiveCommand(command);
  if (interactiveViolation) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "rejected",
            command,
            ...(originalCommand && { original_command: originalCommand }),
            reason: interactiveViolation.message,
            command_sent: false,
          }),
        },
      ],
    };
  }

  return null;
}
