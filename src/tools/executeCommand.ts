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
import { TerminalAdmissionCancelledError } from "../terminal/terminalAdmissionQueue.js";
import {
  SandboxPreparationDriftError,
  TerminalTargetRecoveryError,
} from "../core/capabilities/terminalTargetError.js";
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
  isRoutineApproveForMeCommand,
  type CommandReviewContextEntry,
  type CommandApprovalReviewer,
  type CommandReviewTurnCircuit,
  type RetainedCommandReviewDenials,
} from "../approvals/commandApprovalReview.js";
import { collectCommandReviewEvidence } from "../approvals/commandReviewEvidence.js";
import type {
  CommandRecoveryAttempt,
  CommandReviewSummary,
  NetworkReviewSummary,
  SubCommandEntry,
} from "../approvals/webview/types.js";
import type { NetworkApprovalReviewer } from "../approvals/networkApprovalReview.js";
import { filterOutput, saveOutputTempFile } from "../util/outputFilter.js";
import { validateCommand } from "../util/pipeValidator.js";
import { validateInteractiveCommand } from "../util/interactiveValidator.js";
import { resolveBaselineProtectedGitMetadataForCwd } from "../terminal/sandbox/gitMetadataProtection.js";
import { classifyPredictableGitMetadataWriter } from "../util/gitMetadataWriterClassifier.js";
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
  | { by: "coordinator" }
  | { by: "sandbox_verification" }
  | { by: "routine_tier"; tier: CommandTier }
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
  requireSandbox = false,
): TerminalExecutionRouteContext {
  const executionPresetSnapshot = approvalMode.executionPreset;
  const explicitEscalation = permissionIntent === "native-escalation";
  const additionalPermissions = permissionIntent === "additional-permissions";
  return Object.freeze({
    approvalPolicySnapshot: approvalMode.approvalPolicy,
    approvalReviewerSnapshot: approvalMode.approvalReviewer,
    executionPresetSnapshot,
    requiredAuthority: requireSandbox
      ? "sandbox"
      : explicitEscalation || executionPresetSnapshot === "native-manual"
        ? "native-agent"
        : "sandbox",
    permissionIntent,
    approvalRequirement: explicitEscalation
      ? "explicit-escalation"
      : additionalPermissions
        ? "explicit-permissions"
        : "policy",
    authorityReason: explicitRuleAuthority
      ? "explicit-rule"
      : explicitEscalation
        ? "explicit-escalation"
        : additionalPermissions
          ? "additional-permissions"
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

type ExecuteCommandRetryGuidance = {
  code:
    | "sandbox_cwd_outside_workspace"
    | "sandbox_missing_capabilities"
    | "sandbox_host_integration"
    | "sandbox_node_oom"
    | "sandbox_preparation_changed"
    | "managed_network_ssh_git_transport"
    | "managed_network_tls_trust";
  message: string;
  automatic_retry: false;
  options: Array<Record<string, unknown>>;
  prohibited_workarounds?: string[];
};

const GIT_NETWORK_SUBCOMMANDS = new Set([
  "clone",
  "fetch",
  "pull",
  "push",
  "ls-remote",
  "submodule",
]);

const SSH_GIT_FAILURE_PATTERNS = [
  /ssh: connect to host/i,
  /permission denied \(publickey\)/i,
  /could not read from remote repository/i,
  /could not resolve hostname/i,
];

const TLS_TRUST_FAILURE_PATTERNS = [
  /x509: certificate signed by unknown authority/i,
  /tls: failed to verify certificate: x509: OSStatus -26276\b/i,
];

const LOOPBACK_LISTEN_DENIAL_PATTERNS = [
  /listen EPERM: operation not permitted 127\.0\.0\.1(?::\d+)?\b/i,
  /listen EPERM: operation not permitted ::1(?::\d+)?\b/i,
];

const HOME_WRITE_DENIAL_PATTERNS = [
  /(?:not written|error writing|failed to write|cannot write|unable to write)/i,
  /(?:\bEPERM\b|operation not permitted|permission denied|read-only file system).*\b(?:create|mkdir|rename|truncate|unlink|write|writing)\b/i,
  /\b(?:create|mkdir|rename|truncate|unlink|write|writing)\b.*(?:\bEPERM\b|operation not permitted|permission denied|read-only file system)/i,
];

const PROCESS_INSPECTION_DENIAL_PATTERNS = [
  /(?:\/usr)?\/bin\/ps:?(?:\s+)?(?:operation not permitted|permission denied)/i,
  /(?:operation not permitted|permission denied).*\b(?:\/usr)?\/bin\/ps\b/i,
];

const CONTAINER_RUNTIME_DENIAL_PATTERNS = [
  /(?:permission denied|operation not permitted).*(?:docker\.sock|colima)/i,
  /(?:docker\.sock|colima).*(?:permission denied|operation not permitted)/i,
];

const NODE_OOM_PATTERNS = [
  /fatal error:.*(?:heap out of memory|allocation failed)/i,
  /javascript heap out of memory/i,
  /reached heap limit/i,
];

const NODE_RUNNER_COMMANDS = new Set(["node", "npm", "npx", "pnpm", "yarn"]);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function singleCommandTokens(command: string): string[] | undefined {
  const boundaryScan = scanShellLexBoundaries(command);
  const tokenScan = scanShellLexTokens(command);
  if (
    boundaryScan.boundaries.length > 0 ||
    boundaryScan.finalState.quote !== null ||
    boundaryScan.finalState.danglingEscape ||
    tokenScan.finalState.quote !== null ||
    tokenScan.finalState.danglingEscape ||
    /[`$<>&]/.test(command)
  ) {
    return undefined;
  }
  return tokenScan.tokens;
}

function directGitNetworkCommandTokens(command: string): string[] | undefined {
  const tokens = singleCommandTokens(command);
  if (
    !tokens ||
    tokens[0] !== "git" ||
    !GIT_NETWORK_SUBCOMMANDS.has(tokens[1] ?? "")
  ) {
    return undefined;
  }
  return tokens;
}

function isDirectGhCommand(command: string): boolean {
  return singleCommandTokens(command)?.[0] === "gh";
}

function isGhOnlyCommand(command: string): boolean {
  const segments = splitCompoundCommand(command);
  return (
    segments.length > 0 &&
    segments.every((segment) => isDirectGhCommand(segment))
  );
}

function isExplicitSshGitRemote(value: string): boolean {
  if (/^(?:ssh|git\+ssh):\/\//i.test(value)) return true;
  return /^(?:[^/@:\s]+@(?:\[[0-9a-f:]+\]|[^/:\s]+)|(?:\[[0-9a-f:]+\]|[a-z0-9][a-z0-9.-]*\.[a-z]{2,})):[^/\s].+$/i.test(
    value,
  );
}

function managedNetworkSshGitGuidance(): ExecuteCommandRetryGuidance {
  return {
    code: "managed_network_ssh_git_transport",
    message:
      "Git-over-SSH is not carried automatically by managed HTTP/HTTPS/SOCKS networking. Use the repository's HTTPS URL to remain sandboxed, or make a separate explicitly reviewed native request for SSH.",
    automatic_retry: false,
    options: [
      {
        transport: "https",
        sandbox_permissions: "require_managed_network",
        reason_required: true,
      },
      {
        transport: "ssh",
        sandbox_permissions: "require_escalated",
        reason_required: true,
        reviewed_native_execution: true,
      },
    ],
  };
}

function outsideWorkspaceCwdResult(input: {
  command: string;
  cwd: string;
  workspaceRoots: readonly string[];
  allowReviewedNativeOption: boolean;
}): ToolResult {
  const options: Array<Record<string, unknown>> = [
    {
      action: "open_or_add_workspace_root",
      cwd: input.cwd,
      active_workspace_roots: [...input.workspaceRoots],
    },
  ];
  if (input.allowReviewedNativeOption) {
    options.push({
      cwd: input.cwd,
      sandbox_permissions: "require_escalated",
      reason_required: true,
      reviewed_native_execution: true,
    });
  }
  const retryGuidance: ExecuteCommandRetryGuidance = {
    code: "sandbox_cwd_outside_workspace",
    message:
      "Sandbox execution requires cwd to be inside an active workspace root. Add or open the directory as a workspace root, or request native execution when command policy or review permits it.",
    automatic_retry: false,
    options,
  };
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "retry_required",
          command: input.command,
          cwd: input.cwd,
          command_sent: false,
          process_launched: false,
          retry_safe: true,
          failure_stage: "preparation",
          retry_guidance: retryGuidance,
        }),
      },
    ],
  };
}

function attachManagedNetworkFailureGuidance(input: {
  result: TerminalCommandResult;
  command: string;
  output: string;
}): void {
  const { result, command, output } = input;
  if (
    hasRetryGuidance(result) ||
    result.security?.route !== "sandbox" ||
    result.exit_code === 0 ||
    result.exit_code === null ||
    result.backgrounded ||
    result.is_running ||
    result.timed_out ||
    result.output_complete === false ||
    result.output_finalized === false
  ) {
    return;
  }

  const gitTokens = directGitNetworkCommandTokens(command);
  let guidance: ExecuteCommandRetryGuidance | undefined;
  if (
    gitTokens &&
    SSH_GIT_FAILURE_PATTERNS.some((pattern) => pattern.test(output))
  ) {
    guidance = managedNetworkSshGitGuidance();
  } else if (
    isGhOnlyCommand(command) &&
    TLS_TRUST_FAILURE_PATTERNS.some((pattern) => pattern.test(output))
  ) {
    guidance = {
      code: "managed_network_tls_trust",
      message:
        "Managed networking preserves server TLS and does not provide a replacement CA. Repair the host/client trust configuration before retrying; do not disable certificate verification or install an unverified proxy CA.",
      automatic_retry: false,
      options: [
        {
          action: "fix_trust_and_retry",
          sandbox_permissions: "require_managed_network",
          same_command: true,
        },
        {
          action: "reviewed_native_retry",
          sandbox_permissions: "require_escalated",
          reason_required: true,
          reviewed_native_execution: true,
          same_command: true,
        },
      ],
      prohibited_workarounds: [
        "disable_tls_verification",
        "inject_unverified_ca",
      ],
    };
  }

  if (guidance) {
    Object.assign(result, { retry_guidance: guidance });
  }
}

function hasRetryGuidance(result: TerminalCommandResult): boolean {
  return "retry_guidance" in result;
}

function outputHasHostHomeWriteDenial(
  output: string,
  workspaceRoots: readonly string[],
): boolean {
  const homePrefix = `${path.resolve(os.homedir())}${path.sep}`;
  const excludedRoots = [...workspaceRoots, os.tmpdir()].map((root) =>
    path.resolve(root),
  );
  return output.split(/\r?\n/).some((line) => {
    if (!line.includes(homePrefix)) return false;
    if (
      excludedRoots.some(
        (root) => line.includes(root) && line.includes(`${root}${path.sep}`),
      )
    ) {
      return false;
    }
    return HOME_WRITE_DENIAL_PATTERNS.some((pattern) => pattern.test(line));
  });
}

function attachSandboxCapabilityRetryGuidance(input: {
  result: TerminalCommandResult;
  command: string;
  output: string;
  temporaryHome: boolean;
  localBinding: boolean;
  replayable: boolean;
  hasHomeOverride: boolean;
  allowTemporaryHome: boolean;
  workspaceRoots: readonly string[];
}): void {
  const {
    result,
    command,
    output,
    temporaryHome,
    localBinding,
    replayable,
    hasHomeOverride,
    allowTemporaryHome,
    workspaceRoots,
  } = input;
  if (
    hasRetryGuidance(result) ||
    !replayable ||
    !singleCommandTokens(command) ||
    result.security?.route !== "sandbox" ||
    result.security.confinement !== "verified-baseline" ||
    result.security.permissionIntent !== "default" ||
    result.security.commandExecutionPolicySnapshot === "read-only" ||
    result.exit_code === 0 ||
    result.exit_code === null ||
    result.backgrounded ||
    result.is_running ||
    result.timed_out ||
    result.termination_reason === "interactive_prompt" ||
    result.output_complete === false ||
    result.output_finalized === false
  ) {
    return;
  }

  const needsLocalBinding =
    !localBinding &&
    LOOPBACK_LISTEN_DENIAL_PATTERNS.some((pattern) => pattern.test(output));
  const needsTemporaryHome =
    allowTemporaryHome &&
    !temporaryHome &&
    !hasHomeOverride &&
    outputHasHostHomeWriteDenial(output, workspaceRoots);
  if (!needsLocalBinding && !needsTemporaryHome) return;

  const missingCapabilities = [
    ...(needsTemporaryHome ? ["temporary_home"] : []),
    ...(needsLocalBinding ? ["network.allow_local_binding"] : []),
  ];
  const option: Record<string, unknown> = {
    action: "retry_with_missing_sandbox_capabilities",
    same_command: true,
    ...(needsTemporaryHome ? { temporary_home: true } : {}),
    ...(needsLocalBinding
      ? {
          sandbox_permissions: "with_additional_permissions",
          additional_permissions: {
            network: { allow_local_binding: true },
          },
          reason_required: true,
        }
      : {}),
  };
  const guidance: ExecuteCommandRetryGuidance = {
    code: "sandbox_missing_capabilities",
    message: `The command failed with bounded evidence that the default sandbox is missing ${missingCapabilities.join(" and ")}. Retry only if those capabilities match the intended workflow; AgentLink will not broaden the sandbox automatically.`,
    automatic_retry: false,
    options: [option],
  };
  Object.assign(result, {
    retry_guidance: guidance,
    missing_sandbox_capabilities: missingCapabilities,
  });
}

function attachSandboxNodeOomRetryGuidance(input: {
  result: TerminalCommandResult;
  command: string;
  output: string;
  replayable: boolean;
}): void {
  const { result, command, output, replayable } = input;
  const tokens = singleCommandTokens(command);
  if (
    hasRetryGuidance(result) ||
    !replayable ||
    !tokens ||
    !NODE_RUNNER_COMMANDS.has(tokens[0] ?? "") ||
    result.security?.route !== "sandbox" ||
    result.security.confinement !== "verified-baseline" ||
    result.security.permissionIntent !== "default" ||
    result.exit_code === 0 ||
    result.exit_code === null ||
    result.backgrounded ||
    result.is_running ||
    result.timed_out ||
    result.output_complete === false ||
    result.output_finalized === false ||
    !NODE_OOM_PATTERNS.some((pattern) => pattern.test(output))
  ) {
    return;
  }

  Object.assign(result, {
    retry_guidance: {
      code: "sandbox_node_oom",
      message:
        "Node exhausted its JavaScript heap. Retry the same command with a bounded larger heap only when the task needs it; AgentLink will not retry automatically.",
      automatic_retry: false,
      options: [
        {
          action: "retry_with_larger_node_heap",
          same_command: true,
          env: { NODE_OPTIONS: "--max-old-space-size=6144" },
        },
      ],
    } satisfies ExecuteCommandRetryGuidance,
  });
}

function attachSandboxHostIntegrationRetryGuidance(input: {
  result: TerminalCommandResult;
  command: string;
  output: string;
  replayable: boolean;
}): void {
  const { result, command, output, replayable } = input;
  if (
    hasRetryGuidance(result) ||
    !replayable ||
    result.security?.route !== "sandbox" ||
    result.security.confinement !== "verified-baseline" ||
    result.security.permissionIntent !== "default" ||
    result.exit_code === 0 ||
    result.exit_code === null ||
    result.backgrounded ||
    result.is_running ||
    result.timed_out ||
    result.output_complete === false ||
    result.output_finalized === false
  ) {
    return;
  }

  const tokens = singleCommandTokens(command);
  const isPsInspection =
    tokens?.[0] === "ps" &&
    PROCESS_INSPECTION_DENIAL_PATTERNS.some((pattern) => pattern.test(output));
  const isContainerRuntimeCommand =
    (tokens?.[0] === "docker" || tokens?.[0] === "colima") &&
    CONTAINER_RUNTIME_DENIAL_PATTERNS.some((pattern) => pattern.test(output));
  if (!isPsInspection && !isContainerRuntimeCommand) return;

  const capability = isPsInspection
    ? "host_process_inspection"
    : "container_runtime_socket";
  Object.assign(result, {
    retry_guidance: {
      code: "sandbox_host_integration",
      message: `The sandbox denied ${capability.replaceAll("_", " ")}. This workflow cannot be granted narrowly; use the exact reviewed native retry only when host access is necessary. AgentLink will not retry or weaken the sandbox automatically.`,
      automatic_retry: false,
      options: [
        {
          action: "reviewed_native_retry",
          same_command: true,
          sandbox_permissions: "require_escalated",
          reason_required: true,
          reviewed_native_execution: true,
        },
      ],
      prohibited_workarounds: [
        "weaken_container_socket_permissions",
        "disable_sandboxing_without_review",
      ],
    } satisfies ExecuteCommandRetryGuidance,
  });
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
    result.timed_out ||
    result.termination_reason === "interactive_prompt"
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
    : result.termination_reason === "interactive_prompt"
      ? "interactive_prompt"
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
  // tests. Legacy boolean approvals are equivalent to allow rules.
  const commands = expandSubCommands(splitCompoundCommand(command));
  const segments = (commands.length > 0 ? commands : [command.trim()]).map(
    (segment) => {
      const allowed = approvalManager.isCommandApproved(
        sessionId,
        segment,
        cwd,
      );
      return {
        command: segment,
        decision: allowed ? ("allow" as const) : ("unmatched" as const),
        matches: [],
        explicitlyAllowed: allowed,
      };
    },
  );
  const allSegmentsApprovedByRule =
    segments.length > 0 &&
    segments.every((segment) => segment.decision === "allow");
  return {
    decision: allSegmentsApprovedByRule ? "allow" : "unmatched",
    segments,
    allSegmentsExplicitlyAllowed: allSegmentsApprovedByRule,
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
  options?: { requireHumanApproval?: boolean },
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
    !options?.requireHumanApproval &&
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
  if (scope) {
    if (
      !approvalManager.addNetworkRule(
        request.sessionId,
        { pattern: currentPolicy.key, mode: "exact", decision: "allow" },
        scope,
      )
    ) {
      return "reject";
    }
    return approvalManager.evaluateNetworkRules(request.sessionId, request)
      .decision === "allow"
      ? "allow-once"
      : "reject";
  }
  return currentPolicy.decision === initialPolicy.decision
    ? "allow-once"
    : "reject";
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

async function protectedGitMetadataRetryResult(input: {
  command: string;
  originalCommand?: string;
  cwd: string;
  workspaceRoots: readonly string[];
  hasEnvironmentOverrides: boolean;
  hasInlineFiles: boolean;
}): Promise<ToolResult | undefined> {
  const classification = classifyPredictableGitMetadataWriter({
    command: input.command,
    hasEnvironmentOverrides: input.hasEnvironmentOverrides,
    hasInlineFiles: input.hasInlineFiles,
  });
  if (!classification) return undefined;
  const gitSubcommandFields =
    classification.subcommands.length === 1
      ? { git_subcommand: classification.subcommands[0] }
      : { git_subcommands: [...classification.subcommands] };
  const subcommandDescription =
    classification.subcommands.length === 1
      ? classification.subcommands[0]
      : classification.subcommands.join(" and ");
  let protection;
  try {
    protection = await resolveBaselineProtectedGitMetadataForCwd(
      input.cwd,
      input.workspaceRoots,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "rejected",
            command: input.command,
            ...(input.originalCommand && input.originalCommand !== input.command
              ? { original_command: input.originalCommand }
              : {}),
            reason: `Unable to verify protected Git metadata safely: ${message}`,
            capability_code: "protected_git_metadata",
            ...gitSubcommandFields,
            command_sent: false,
            process_launched: false,
            retry_safe: true,
            failure_stage: "validation",
          }),
        },
      ],
    };
  }
  if (!protection) return undefined;
  const suggestedReason = `Git ${subcommandDescription} ${classification.subcommands.length === 1 ? "mutates" : "mutate"} protected repository metadata and requires reviewed native execution.`;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "retry_required",
          command: input.command,
          ...(input.originalCommand && input.originalCommand !== input.command
            ? { original_command: input.originalCommand }
            : {}),
          reason:
            "The workspace sandbox keeps this repository's Git metadata read-only. Retry the exact command with native escalation; an applicable native allow rule or fresh review must authorize it.",
          capability_code: "protected_git_metadata",
          ...gitSubcommandFields,
          protected_path: protection.marker,
          required_sandbox_permissions: "require_escalated",
          suggested_reason: suggestedReason,
          command_sent: false,
          process_launched: false,
          retry_safe: true,
          failure_stage: "validation",
        }),
      },
    ],
  };
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
    temporary_home?: true;
    sandbox_permissions?:
      | "use_default"
      | "with_additional_permissions"
      | "require_managed_network"
      | "require_escalated";
    additional_permissions?: {
      network?: { allow_local_binding?: true };
    };
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
    const requestedNativeEscalation =
      params.sandbox_permissions === "require_escalated";
    const requestedManagedNetwork =
      params.sandbox_permissions === "require_managed_network";
    const requestedAdditionalPermissions =
      params.sandbox_permissions === "with_additional_permissions";
    const requestedLocalBinding =
      params.additional_permissions?.network?.allow_local_binding === true;
    const temporaryHome = params.temporary_home === true;
    if (requestedAdditionalPermissions !== requestedLocalBinding) {
      return rejectedCommandResult(
        params.command,
        requestedAdditionalPermissions
          ? 'sandbox_permissions="with_additional_permissions" currently requires additional_permissions.network.allow_local_binding=true.'
          : 'additional_permissions requires sandbox_permissions="with_additional_permissions".',
      );
    }
    if (
      (requestedNativeEscalation ||
        requestedManagedNetwork ||
        requestedAdditionalPermissions) &&
      !params.reason?.trim()
    ) {
      return rejectedCommandResult(
        params.command,
        `sandbox_permissions="${params.sandbox_permissions}" requires a non-empty reason explaining why the additional authority is needed.`,
      );
    }
    const approvalMode = approvalModeFor(providers, sessionId);
    const manualExecutionPreset =
      approvalMode.executionPreset === "native-manual";
    const nativeEscalation =
      requestedNativeEscalation ||
      (manualExecutionPreset &&
        (requestedManagedNetwork || requestedAdditionalPermissions));
    const managedNetwork = requestedManagedNetwork && !manualExecutionPreset;
    const additionalPermissions =
      requestedAdditionalPermissions && !manualExecutionPreset;
    const localBinding = requestedLocalBinding && !manualExecutionPreset;
    if (temporaryHome) {
      if (nativeEscalation) {
        return rejectedCommandResult(
          params.command,
          'temporary_home cannot be combined with sandbox_permissions="require_escalated" because native execution cannot provide a disposable sandbox-owned HOME.',
        );
      }
      if (params.background) {
        return rejectedCommandResult(
          params.command,
          "temporary_home is limited to foreground commands so its HOME remains available for the complete process lifecycle.",
        );
      }
      if (approvalMode.commandApprovalPolicy !== "approve-for-me") {
        return rejectedCommandResult(
          params.command,
          "temporary_home requires Approve for Me because it must run in the verified sandbox without native fallback.",
        );
      }
    }
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
    let expectedRulePolicyFingerprint =
      commandRulePolicyFingerprint(initialRulePolicy);
    const explicitRuleAuthority =
      initialRulePolicy.allSegmentsExplicitlyAllowed;
    const routeContext = routeContextFor(
      approvalMode,
      nativeEscalation
        ? "native-escalation"
        : managedNetwork || additionalPermissions
          ? "additional-permissions"
          : "default",
      providers.commandExecutionPolicy,
      explicitRuleAuthority,
      temporaryHome || managedNetwork || additionalPermissions,
    );
    const readOnlyPolicy =
      routeContext.commandExecutionPolicySnapshot === "read-only";
    if (
      routeContext.requiredAuthority === "sandbox" &&
      params.env &&
      Object.prototype.hasOwnProperty.call(params.env, "HOME")
    ) {
      return rejectedCommandResult(
        params.command,
        "Sandbox environment override is reserved: HOME. Use temporary_home=true only when the command needs a fresh empty writable HOME that is deleted after completion; the host home remains readable by absolute path.",
      );
    }
    if (
      routeContext.requiredAuthority === "sandbox" &&
      !isCommandPathInsideWorkspace(cwd, workspaceRoots)
    ) {
      return outsideWorkspaceCwdResult({
        command: params.command,
        cwd,
        workspaceRoots,
        allowReviewedNativeOption:
          !readOnlyPolicy &&
          !temporaryHome &&
          !managedNetwork &&
          !additionalPermissions,
      });
    }
    if (readOnlyPolicy) {
      if (requestedLocalBinding) {
        return rejectedCommandResult(
          params.command,
          "Read-only command execution cannot request local listener binding.",
        );
      }
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
      : !nativeEscalation &&
          !managedNetwork &&
          !additionalPermissions &&
          masterBypass
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

      const mediatedPublicNetwork =
        routeContext.requiredAuthority === "sandbox" &&
        routeContext.commandExecutionPolicySnapshot !== "read-only" &&
        approvalMode.commandApprovalPolicy === "approve-for-me";
      const directGitNetworkTokens = mediatedPublicNetwork
        ? directGitNetworkCommandTokens(commandToRun)
        : undefined;
      if (directGitNetworkTokens?.slice(2).some(isExplicitSshGitRemote)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "retry_required",
                command: commandToRun,
                command_sent: false,
                process_launched: false,
                retry_safe: true,
                failure_stage: "validation",
                retry_guidance: managedNetworkSshGitGuidance(),
              }),
            },
          ],
        };
      }

      const terminalOptions = (
        executionRouteContext = routeContext,
      ): TerminalExecuteOptions => {
        const routeUsesManagedNetwork =
          executionRouteContext.requiredAuthority === "sandbox" &&
          executionRouteContext.commandExecutionPolicySnapshot !==
            "read-only" &&
          approvalMode.commandApprovalPolicy === "approve-for-me";
        return {
          owner: undefined,
          command: commandToRun,
          cwd,
          terminal_id: params.terminal_id,
          terminal_name: params.terminal_name,
          split_from: params.split_from,
          background: params.background,
          timeout: params.timeout ? params.timeout * 1000 : undefined,
          admissionSignal: providers.toolAbortSignal,
          env: params.env,
          temporaryHome: temporaryHome || undefined,
          sandboxSessionId: sessionId,
          sandboxCapabilityRequest:
            routeUsesManagedNetwork || localBinding
              ? {
                  ...(routeUsesManagedNetwork
                    ? { unrestrictedPublicNetwork: true }
                    : {}),
                  ...(localBinding ? { allowLocalBinding: true } : {}),
                }
              : undefined,
          onManagedNetworkRequest: routeUsesManagedNetwork
            ? (request, signal) =>
                reviewManagedNetworkRequest(
                  request,
                  signal,
                  approvalManager,
                  approvalPanel,
                  providers,
                  approvalMode,
                  { requireHumanApproval: true },
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
        };
      };
      preparedExecution = await prepareTerminalExecution(
        providers.terminalProvider,
        terminalOptions(),
        routeContext,
      );
      if (preparedExecution.security.route === "sandbox") {
        const gitRetry = await protectedGitMetadataRetryResult({
          command: commandToRun,
          cwd,
          workspaceRoots,
          hasEnvironmentOverrides:
            temporaryHome ||
            Boolean(params.env && Object.keys(params.env).length > 0),
          hasInlineFiles: inlineFiles !== undefined,
        });
        if (gitRetry) {
          const revokedPreparation = preparedExecution;
          preparedExecution = undefined;
          revokedPreparation.dispose();
          recordExecutionAudit(
            providers.terminalProvider,
            "preparation_revoked",
            revokedPreparation.security,
            { resultStatus: "protected_git_metadata" },
          );
          return gitRetry;
        }
      }

      if (
        nativeEscalation ||
        managedNetwork ||
        additionalPermissions ||
        (!masterBypass && !readOnlyPolicy)
      ) {
        // Gate: only one command goes through approval at a time, so pending
        // dialogs aren't buried by terminals from auto-approved commands.
        const releaseGate = await approvalGate.acquire();
        try {
          const subCommands = splitCompoundCommand(params.command);
          const gatedRulePolicy = commandRulePolicyFor(
            approvalManager,
            sessionId,
            params.command,
            cwd,
          );
          expectedRulePolicyFingerprint =
            commandRulePolicyFingerprint(gatedRulePolicy);
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
              requireFreshReview: managedNetwork || additionalPermissions,
              rulePolicy: gatedRulePolicy,
              commandPolicyFingerprint:
                commandRulePolicyFingerprint(gatedRulePolicy),
              explicitNativeEscalation: nativeEscalation,
              ruleFastPathAllowed: true,
              hasEnvOverrides:
                temporaryHome ||
                Boolean(params.env && Object.keys(params.env).length > 0),
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
                    status: "rejected_by_user",
                    command: params.command,
                    reason: approvalResult.reason,
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
            if (
              commandRulePolicyFor(
                approvalManager,
                sessionId,
                commandToRun,
                cwd,
              ).decision === "forbidden"
            ) {
              return rejectedCommandResult(
                commandToRun,
                "Edited command execution is forbidden by an applicable command policy rule.",
              );
            }
            const editedGitRetry =
              preparedExecution.security.route === "sandbox"
                ? await protectedGitMetadataRetryResult({
                    command: commandToRun,
                    originalCommand: params.command,
                    cwd,
                    workspaceRoots,
                    hasEnvironmentOverrides:
                      temporaryHome ||
                      Boolean(params.env && Object.keys(params.env).length > 0),
                    hasInlineFiles: inlineFiles !== undefined,
                  })
                : undefined;
            if (editedGitRetry) {
              const revokedPreparation = preparedExecution;
              preparedExecution = undefined;
              revokedPreparation.dispose();
              recordExecutionAudit(
                providers.terminalProvider,
                "preparation_revoked",
                revokedPreparation.security,
                { resultStatus: "protected_git_metadata" },
              );
              return editedGitRetry;
            }
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
          const preCommitRulePolicy = commandRulePolicyFor(
            approvalManager,
            sessionId,
            commandEditedByUser ? commandToRun : params.command,
            cwd,
          );
          if (
            preCommitRulePolicy.decision === "forbidden" ||
            (!commandEditedByUser &&
              commandRulePolicyFingerprint(preCommitRulePolicy) !==
                expectedRulePolicyFingerprint)
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
          approvalResult.commitMutations?.();
          commitApprovalMutations = undefined;
          expectedRulePolicyFingerprint = commandRulePolicyFingerprint(
            commandRulePolicyFor(
              approvalManager,
              sessionId,
              commandEditedByUser ? commandToRun : params.command,
              cwd,
            ),
          );
        } finally {
          releaseGate();
        }
      }

      const currentRulePolicy = commandRulePolicyFor(
        approvalManager,
        sessionId,
        commandEditedByUser ? commandToRun : params.command,
        cwd,
      );
      if (currentRulePolicy.decision === "forbidden") {
        const revokedPreparation = preparedExecution;
        preparedExecution = undefined;
        revokedPreparation.dispose();
        recordExecutionAudit(
          providers.terminalProvider,
          "preparation_revoked",
          revokedPreparation.security,
          {
            failure: "policy_drift",
            resultStatus: "rejected",
          },
        );
        return rejectedCommandResult(
          commandToRun,
          "Command execution is forbidden by an applicable command policy rule.",
        );
      }
      if (
        !commandEditedByUser &&
        commandRulePolicyFingerprint(currentRulePolicy) !==
          expectedRulePolicyFingerprint
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
      const replayableWithNarrowSandboxCapabilities =
        !inlineFiles &&
        !commandEditedByUser &&
        !params.terminal_id &&
        !params.terminal_name &&
        !params.split_from;
      const hasHomeOverride = Boolean(
        params.env &&
        [
          "HOME",
          "XDG_CACHE_HOME",
          "XDG_CONFIG_HOME",
          "GOCACHE",
          "GOLANGCI_LINT_CACHE",
        ].some((name) => Object.hasOwn(params.env!, name)),
      );
      if (result.output) {
        attachSandboxCapabilityRetryGuidance({
          result,
          command: commandToRun,
          output: result.output,
          temporaryHome,
          localBinding,
          replayable: replayableWithNarrowSandboxCapabilities,
          hasHomeOverride,
          allowTemporaryHome:
            approvalMode.commandApprovalPolicy === "approve-for-me",
          workspaceRoots,
        });
        attachSandboxNodeOomRetryGuidance({
          result,
          command: commandToRun,
          output: result.output,
          replayable: replayableWithNarrowSandboxCapabilities,
        });
        attachSandboxHostIntegrationRetryGuidance({
          result,
          command: commandToRun,
          output: result.output,
          replayable: replayableWithNarrowSandboxCapabilities,
        });
      }

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
        const retryUnsupportedReason = hasRetryGuidance(result)
          ? "A narrower reviewed sandbox retry is available; native retry was not attempted."
          : temporaryHome
            ? "Commands using temporary_home cannot switch to native execution because native execution cannot preserve the disposable HOME contract."
            : !isNativeRetryEligibleDenial(
                  capabilityDenial,
                  retryClassification,
                )
              ? capabilityDenial.operation === "network-connect"
                ? "Managed network capability review is required; native retry was not attempted."
                : capabilityDenial.operation === "resource-limit"
                  ? "Resource-limit denials are not retried outside the sandbox."
                  : `Native retry was not attempted because the command is not a recognized read-only, version, or project-toolchain operation (${
                      retryClassification.perSubCommand
                        .map(
                          ({ command, result }) => `${command}: ${result.code}`,
                        )
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
          const retryRulePolicy = commandRulePolicyFor(
            approvalManager,
            sessionId,
            commandToRun,
            cwd,
          );
          const retryRouteContext = routeContextFor(
            approvalModeFor(providers, sessionId),
            "native-escalation",
            providers.commandExecutionPolicy,
            false,
          );
          const retryReason = `The sandbox denied ${capabilityDenial.operation}${
            capabilityDenial.target ? ` for ${capabilityDenial.target}` : ""
          }: ${capabilityDenial.reason}`;
          let retryExecution: PreparedTerminalExecution;
          try {
            retryExecution = await prepareTerminalExecution(
              providers.terminalProvider,
              terminalOptions(retryRouteContext),
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
                  requireHumanApproval: true,
                  ruleFastPathAllowed: false,
                  allowRuleChanges: true,
                  skipAutomaticReviewer: true,
                  recoveryAttempt: {
                    denialOperation: capabilityDenial.operation,
                    denialReason: capabilityDenial.reason,
                    firstAttemptRoute: firstAttempt.route,
                    commandSent: firstAttempt.command_sent,
                    processLaunched: firstAttempt.process_launched,
                    mayHaveSideEffects: firstAttempt.may_have_side_effects,
                  },
                  rulePolicy: retryRulePolicy,
                  commandPolicyFingerprint:
                    commandRulePolicyFingerprint(retryRulePolicy),
                  hasEnvOverrides:
                    temporaryHome ||
                    Boolean(params.env && Object.keys(params.env).length > 0),
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
            const committedRetryRulePolicy = commandRulePolicyFor(
              approvalManager,
              sessionId,
              commandToRun,
              cwd,
            );
            if (committedRetryRulePolicy.decision === "forbidden") {
              recordExecutionAudit(
                providers.terminalProvider,
                "preparation_revoked",
                retryExecution.security,
                {
                  failure: "policy_drift",
                  resultStatus: "rejected",
                },
              );
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      {
                        status: "rejected",
                        command: commandToRun,
                        cwd,
                        reason:
                          "Command execution is forbidden by an applicable command policy rule.",
                        security: retryExecution.security,
                        command_sent: firstAttempt.command_sent,
                        process_launched: firstAttempt.process_launched,
                        retry_safe: false,
                        failure_stage: "approval",
                        capability_denial: { ...capabilityDenial },
                        retry_lineage_id: retryLineageId,
                        retry_outcome: "approval_denied",
                        execution_attempts: [
                          firstAttempt,
                          unlaunchedAttemptSummary(
                            2,
                            retryExecution.security,
                            "approval_denied",
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
      const retainedOutput = providers.terminalProvider.getRetainedOutput?.({
        owner: undefined,
        terminalId: result.terminal_id,
      });
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
      if (result.output) {
        if (mediatedPublicNetwork && result.security?.route === "sandbox") {
          attachManagedNetworkFailureGuidance({
            result,
            command: commandToRun,
            output: result.output,
          });
        }
        attachSandboxCapabilityRetryGuidance({
          result,
          command: commandToRun,
          output: result.output,
          temporaryHome,
          localBinding,
          replayable: replayableWithNarrowSandboxCapabilities,
          hasHomeOverride,
          allowTemporaryHome:
            approvalMode.commandApprovalPolicy === "approve-for-me",
          workspaceRoots,
        });
        attachSandboxNodeOomRetryGuidance({
          result,
          command: commandToRun,
          output: result.output,
          replayable: replayableWithNarrowSandboxCapabilities,
        });
        attachSandboxHostIntegrationRetryGuidance({
          result,
          command: commandToRun,
          output: result.output,
          replayable: replayableWithNarrowSandboxCapabilities,
        });
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
        const { filtered, totalLines, linesShown, truncated } = filterOutput(
          fullOutput,
          filterOptions,
        );

        result.total_lines = totalLines;
        result.lines_shown = linesShown;
        result.output_truncated = truncated;
        result.total_lines_scope =
          result.output_finalized === false || result.output_complete === false
            ? "retained"
            : "complete";

        if (result.output_finalized === false) {
          result.output_warning =
            "Terminal output is still running or was closed before finalization. Filtering applies to retained output so far; no final output file is available.";
        } else if (result.output_complete === false) {
          result.output_warning = `⚠️ Terminal output exceeded the bounded capture limit. ${result.output_dropped_bytes === undefined ? "Some output" : formatBytes(result.output_dropped_bytes)} was not retained; filtering applies only to the retained tail and no full-output file is available.`;
        } else if (truncated || linesShown < totalLines) {
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
    if (err instanceof TerminalAdmissionCancelledError) {
      return cancelledCommandResult(params.command);
    }
    if (err instanceof SandboxPreparationDriftError) {
      const retryGuidance: ExecuteCommandRetryGuidance = {
        code: err.code,
        message: err.message,
        automatic_retry: false,
        options: [{ action: "retry_same_command", same_command: true }],
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "retry_required",
              error: message,
              error_code: err.code,
              changed_security_fields: err.changedFields,
              retry_guidance: retryGuidance,
              command: params.command,
              command_sent: false,
              process_launched: false,
              retry_safe: true,
              failure_stage: err.failureStage,
            }),
          },
        ],
      };
    }
    if (err instanceof TerminalTargetRecoveryError) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "retry_required",
              error: message,
              error_code: err.code,
              target_failure: err.failure,
              target_kind: err.target_kind,
              target_value: err.target_value,
              ...(err.required_authority
                ? { required_authority: err.required_authority }
                : {}),
              ...(err.target_authorities
                ? { target_authorities: err.target_authorities }
                : {}),
              compatible_terminals: err.compatible_terminals,
              available_terminals: err.available_terminals,
              retry_guidance: err.retry_guidance,
              command: params.command,
              command_sent: false,
              process_launched: false,
              retry_safe: true,
              failure_stage: "preparation",
            }),
          },
        ],
      };
    }
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
    ["temporary_home", params.temporary_home],
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
    commandPolicyFingerprint?: string;
    explicitNativeEscalation?: boolean;
    ruleFastPathAllowed?: boolean;
    allowRuleChanges?: boolean;

    skipAutomaticReviewer?: boolean;
    hasEnvOverrides?: boolean;
    forceRequested?: boolean;
    recoveryAttempt?: CommandRecoveryAttempt;
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
  let circuitInterrupted =
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
    !options?.requireHumanApproval &&
    !options?.requireFreshReview &&
    !retainedDenial &&
    rulePolicy.allSegmentsExplicitlyAllowed;
  if (allApproved) {
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
  const sandboxVerificationApproved =
    policy === "approve-for-me" &&
    rulePolicy.decision !== "prompt" &&
    !options?.requireHumanApproval &&
    !retainedDenial &&
    !options?.requireFreshReview &&
    !options?.inlineFiles?.length &&
    !options?.hasEnvOverrides &&
    !options?.forceRequested &&
    options?.security?.route === "sandbox" &&
    options.security.confinement === "verified-baseline" &&
    options.routeContext.permissionIntent === "default" &&
    workspaceRoots.some((root) => isCommandPathInsideWorkspace(cwd, [root])) &&
    tierInfo.perSubCommand.length > 0 &&
    tierInfo.perSubCommand.every(
      ({ result }) => result.code === "project_toolchain",
    );
  if (sandboxVerificationApproved) {
    return {
      approved: true,
      approval: { by: "sandbox_verification" },
    };
  }

  const deterministicallyApproved =
    rulePolicy.decision !== "prompt" &&
    !options?.requireHumanApproval &&
    !retainedDenial &&
    !options?.requireFreshReview &&
    options?.routeContext.permissionIntent !== "native-escalation" &&
    ((tierInfo.tier === "safe" && policy !== "manual") ||
      (tierInfo.tier === "sensitive" && policy === "sensitive"));
  if (deterministicallyApproved) {
    return {
      approved: true,
      approval: { by: "tier", tier: tierInfo.tier, threshold },
      autoApprovedByTier: { tier: tierInfo.tier, threshold },
    };
  }

  // In approve-for-me mode, routine development commands (recognized reads,
  // build/test/lint toolchain runs, workspace-bounded file operations, and
  // repo-local git writes) auto-approve deterministically instead of paying a
  // blocking Guardian model round-trip. Network effects, unrecognized
  // commands, escalations, and retained denials keep the full review below.
  const routineApproveForMeApproved =
    policy === "approve-for-me" &&
    rulePolicy.decision !== "prompt" &&
    !options?.requireHumanApproval &&
    !retainedDenial &&
    !options?.requireFreshReview &&
    !options?.inlineFiles?.length &&
    !options?.hasEnvOverrides &&
    !options?.forceRequested &&
    !options?.recoveryAttempt &&
    !circuitInterrupted &&
    options?.routeContext.permissionIntent === "default" &&
    workspaceRoots.some((root) => isCommandPathInsideWorkspace(cwd, [root])) &&
    isRoutineApproveForMeCommand(tierInfo);
  if (routineApproveForMeApproved) {
    return {
      approved: true,
      approval: { by: "routine_tier", tier: tierInfo.tier },
    };
  }

  const inlineFiles = options?.inlineFiles;
  const hasEnvOverrides = Boolean(options?.hasEnvOverrides);
  const forceRequested = Boolean(options?.forceRequested);
  let commandReview: CommandReviewSummary | undefined;
  let humanOnlyReason: string | undefined = options?.recoveryAttempt
    ? "This is a one-time second execution after a sandbox denial and requires your direct approval."
    : circuitInterrupted
      ? "Automatic command review stopped after repeated denials in this turn. Your direct approval is required."
      : undefined;
  const commandPolicyFingerprint =
    options?.commandPolicyFingerprint ??
    commandRulePolicyFingerprint(rulePolicy);
  const recentApprovalLookup = (
    approvalPanel as ApprovalPanelProvider & {
      isCommandRecentlyApproved?: ApprovalPanelProvider["isCommandRecentlyApproved"];
    }
  ).isCommandRecentlyApproved;
  const recentlyApproved = Boolean(
    rulePolicy.decision !== "prompt" &&
    !options?.requireHumanApproval &&
    !retainedDenial &&
    !options?.requireFreshReview &&
    !options?.inlineFiles?.length &&
    !options?.hasEnvOverrides &&
    !options?.forceRequested &&
    !circuitInterrupted &&
    options?.security &&
    recentApprovalLookup?.call(approvalPanel, {
      command: fullCommand,
      cwd,
      sessionId,
      security: options.security,
      commandPolicyFingerprint,
    }),
  );
  if (recentlyApproved) {
    return { approved: true, approval: { by: "recent_approval" } };
  }
  if (
    rulePolicy.decision !== "prompt" &&
    policy === "approve-for-me" &&
    !circuitInterrupted &&
    !options?.skipAutomaticReviewer &&
    reviewProviders?.commandApprovalReviewer
  ) {
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
        evidence: collectCommandReviewEvidence(reviewedCommand, {
          cwd,
          workspaceRoots,
        }),
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
        circuitInterrupted = true;
        humanOnlyReason =
          "Automatic command review stopped after repeated denials in this turn. Your direct approval is required.";
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
        recoveryAttempt: options?.recoveryAttempt,
        commandPolicyFingerprint,
        security: options?.security,
        sessionId,
        signal: reviewProviders?.toolAbortSignal,
        deferApprovalRecording: true,
        bypassRecentApproval:
          circuitInterrupted ||
          options?.requireFreshReview ||
          options?.requireHumanApproval ||
          Boolean(options?.inlineFiles?.length) ||
          options?.hasEnvOverrides ||
          options?.forceRequested,
        skipApprovalRecording: Boolean(options?.recoveryAttempt),
      },
    );
  const response = await promise;
  if (
    !response.coordinatorApproval &&
    options?.security &&
    options.providers?.terminalProvider
  ) {
    recordExecutionAudit(
      options.providers.terminalProvider,
      "human_approval_requested",
      options.security,
    );
  }

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
    for (const rule of options?.allowRuleChanges === false
      ? []
      : (response.rules ?? [])) {
      if (rule.mode === "skip" || rule.scope === "skip" || !rule.pattern)
        continue;
      const saved = approvalManager.addCommandRule(
        sessionId,
        {
          pattern: rule.pattern,
          mode: rule.mode,
          decision: rule.decision,
        },
        rule.scope,
        cwd,
      );
      if (!saved) {
        throw new Error(
          `Could not save the ${rule.scope} command approval. The command was not executed; check the approval config path and try again.`,
        );
      }
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
  // A direct human approval outranks an earlier guardian denial of the same
  // action, so stop the retained denial from blocking fast paths on repeats.
  if (!response.coordinatorApproval) {
    reviewProviders?.retainedCommandReviewDenials?.clear(sessionId, actionKey);
  }
  return {
    approved: true,
    approval: response.coordinatorApproval
      ? { by: "coordinator" }
      : response.recentApproval
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
