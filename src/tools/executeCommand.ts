import { randomUUID } from "node:crypto";
import * as path from "path";
import * as os from "os";

import { getConfiguredMasterBypass } from "../adapters/vscode/agentLinkConfig.js";

import { getWorkspaceRoots, tryGetFirstWorkspaceRoot } from "../util/paths.js";
import type {
  CommandExecutionPolicy,
  PreparedTerminalExecution,
  TerminalExecutionAuditEvent,
  TerminalExecutionSecuritySummary,
  TerminalExecuteOptions,
  TerminalProvider,
} from "../core/capabilities/terminal.js";
import type { SandboxCapabilityRequest } from "../core/sandboxPolicy.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import type { TrackerContext } from "../agent/AgentToolCallTracker.js";
import {
  splitCompoundCommand,
  expandSubCommands,
} from "../approvals/commandSplitter.js";
import {
  classifyCommand,
  isCommandEligibleForReadOnlyExecution,
  isCommandPathInsideWorkspace,
  type CommandTier,
} from "../approvals/commandTierClassifier.js";
import type { CommandApprovalPolicy } from "../approvals/commandApprovalPolicy.js";
import {
  getCommandAutoApprovalEligibility,
  type CommandReviewContextEntry,
  type CommandApprovalReviewer,
} from "../approvals/commandApprovalReview.js";
import type {
  CommandReviewSummary,
  SubCommandEntry,
} from "../approvals/webview/types.js";
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
      tier: "sensitive";
      confidence: "high";
      risk: "low" | "medium";
      reason: string;
    }
  | { by: "human" }
  | { by: "human_edited" };

import { type ToolResult } from "../shared/types.js";

export interface ExecuteCommandProviders {
  terminalProvider?: TerminalProvider;
  getCommandApprovalPolicy?: (sessionId: string) => CommandApprovalPolicy;
  commandApprovalReviewer?: CommandApprovalReviewer;
  isSessionActive?: (sessionId: string) => boolean;
  toolAbortSignal?: AbortSignal;
  getUserObjective?: (sessionId: string) => string | undefined;
  getReviewContext?: (sessionId: string) => CommandReviewContextEntry[];
  commandExecutionPolicy?: CommandExecutionPolicy;
}

function prepareTerminalExecution(
  provider: TerminalProvider,
  options: TerminalExecuteOptions,
): Promise<PreparedTerminalExecution> {
  if (provider.prepareExecution) return provider.prepareExecution(options);
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
  const security: TerminalExecutionSecuritySummary = {
    auditId: randomUUID(),
    route: "native",
    confinement: "native-unsandboxed",
    routeReason: "unsupported-host",
    approvalPolicy: "native-legacy-v1",
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
    left.confinement === right.confinement &&
    left.routeReason === right.routeReason &&
    left.approvalPolicy === right.approvalPolicy &&
    left.sandbox?.attestationId === right.sandbox?.attestationId &&
    left.sandbox?.attestationVersion === right.sandbox?.attestationVersion &&
    left.sandbox?.policyVersion === right.sandbox?.policyVersion &&
    left.sandbox?.profileId === right.sandbox?.profileId &&
    left.sandbox?.backend === right.sandbox?.backend &&
    left.sandbox?.architecture === right.sandbox?.architecture
  );
}

function recordExecutionAudit(
  provider: TerminalProvider,
  type: TerminalExecutionAuditEvent["type"],
  security: TerminalExecutionSecuritySummary,
  detail: Pick<
    TerminalExecutionAuditEvent,
    "approvalBasis" | "resultStatus"
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

function unavailableExecuteCommandResult(command: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error:
            "Command execution is unavailable in this runtime. Provide a TerminalProvider to enable execute_command.",
          command,
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
    sandbox_permissions?: {
      public_network?: boolean;
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
            text: JSON.stringify({ error: "Command cannot be empty" }),
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
    const readOnlyPolicy = providers.commandExecutionPolicy === "read-only";
    const sandboxCapabilityRequest: SandboxCapabilityRequest | undefined =
      params.sandbox_permissions?.public_network === true
        ? { unrestrictedPublicNetwork: true }
        : undefined;
    if (sandboxCapabilityRequest) {
      return rejectedCommandResult(
        params.command,
        "Public network capability requests are not available yet. Run without sandbox_permissions.public_network.",
      );
    }
    if (readOnlyPolicy) {
      const rejectionReason = getReadOnlyCommandRejectionReason(
        params,
        cwd,
        workspaceRoots,
      );
      if (rejectionReason) {
        return rejectedCommandResult(params.command, rejectionReason);
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
    let approvalFollowUp: string | undefined;
    let approvalAudit: CommandApprovalAudit | undefined = readOnlyPolicy
      ? { by: "readonly_policy" }
      : masterBypass
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
        sandboxInlineFiles: inlineFiles?.map((file) => ({
          name: file.name,
          path: file.path,
          bytes: file.bytes,
          sha256: file.sha256,
        })),
        sandboxCapabilityRequest,
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
      );

      if (!masterBypass && !readOnlyPolicy) {
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
              hasEnvOverrides: Boolean(
                params.env && Object.keys(params.env).length > 0,
              ),
              forceRequested: Boolean(params.force || params.force_reason),
              providers,
              security: preparedExecution.security,
            },
          );

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
                    ...(approvalResult.reason && {
                      reason: approvalResult.reason,
                    }),
                    security: preparedExecution.security,
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

      const execution = preparedExecution;
      preparedExecution = undefined;
      const result = await execution.execute();
      result.security = execution.security;

      // Apply output filtering and temp file saving
      if (result.output_captured && result.output) {
        const filterOptions = {
          output_head: params.output_head,
          output_tail: params.output_tail,
          output_offset: params.output_offset,
          output_grep: params.output_grep,
          output_grep_context: params.output_grep_context,
        };
        const { filtered, totalLines, linesShown } = filterOutput(
          result.output,
          filterOptions,
        );

        result.total_lines = totalLines;
        result.lines_shown = linesShown;

        // Only save temp file when output is actually being truncated
        if (linesShown < totalLines) {
          const outputFile = saveOutputTempFile(result.output);
          if (outputFile) {
            result.output_file = outputFile;
            result.output_warning =
              "⚠️ Output was truncated. Full output saved to output_file — use read_file(output_file) to access it. Do NOT re-run this command.";
          }
        }

        result.output = filtered;
        if (result.terminal_raw_output) {
          result.terminal_raw_output = filterOutput(
            result.terminal_raw_output,
            filterOptions,
          ).filtered;
        }
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

      if (approvalAudit) {
        result.approval = approvalAudit;
      }

      if (autoApprovedByTier) {
        result.auto_approved = {
          by: "tier",
          tier: autoApprovedByTier.tier,
          threshold: autoApprovedByTier.threshold,
        };
      }

      if (approvalFollowUp) {
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
        text: JSON.stringify({ status: "rejected", command, reason }),
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
    hasEnvOverrides?: boolean;
    forceRequested?: boolean;
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
}> {
  // Expand wrappers: ["cd /foo", "sudo npm install"] → ["cd /foo", "sudo", "npm install"]
  const expanded = expandSubCommands(subCommands);

  // Check if all expanded sub-commands are already approved,
  // or the full command was recently approved within the TTL window
  const allApproved = expanded.every((sub) =>
    approvalManager.isCommandApproved(sessionId, sub),
  );
  if (!options?.requireHumanApproval && allApproved) {
    return { approved: true, approval: { by: "explicit_rule" } };
  }
  if (
    !options?.requireHumanApproval &&
    approvalPanel.isRecentlyApproved("command", fullCommand)
  ) {
    return { approved: true, approval: { by: "recent_approval" } };
  }

  const classificationCommand = options?.inlineFiles?.length
    ? (options.displayCommand ?? fullCommand)
    : fullCommand;
  const tierInfo = classifyCommand(classificationCommand, {
    cwd,
    workspaceRoots,
  });
  const policy =
    options?.providers?.getCommandApprovalPolicy?.(sessionId) ?? "manual";
  const threshold = policy === "sensitive" ? "sensitive" : "safe";
  const deterministicallyApproved =
    !options?.requireHumanApproval &&
    ((tierInfo.tier === "safe" && policy !== "manual") ||
      (tierInfo.tier === "sensitive" && policy === "sensitive"));
  if (deterministicallyApproved) {
    return {
      approved: true,
      approval: { by: "tier", tier: tierInfo.tier, threshold },
      autoApprovedByTier: { tier: tierInfo.tier, threshold },
    };
  }

  const reviewProviders = options?.providers;
  const inlineFiles = options?.inlineFiles;
  const hasEnvOverrides = Boolean(options?.hasEnvOverrides);
  const forceRequested = Boolean(options?.forceRequested);
  let commandReview: CommandReviewSummary | undefined;
  let humanOnlyReason: string | undefined;
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
      const currentPolicy =
        reviewProviders.getCommandApprovalPolicy?.(sessionId) ?? "safe";
      const sessionActive =
        reviewProviders.isSessionActive?.(sessionId) ??
        !reviewProviders.toolAbortSignal?.aborted;
      const reviewerApproved =
        review.status === "reviewed" &&
        review.decision === "approve" &&
        review.confidence === "high" &&
        review.risk !== "high";
      if (
        reviewerApproved &&
        currentPolicy === "approve-for-me" &&
        sessionActive &&
        !reviewProviders.toolAbortSignal?.aborted &&
        reviewedCommand === fullCommand
      ) {
        return {
          approved: true,
          approval: {
            by: "model_reviewer",
            model: review.model,
            tier: "sensitive",
            confidence: "high",
            risk: review.risk === "low" ? "low" : "medium",
            reason: review.reason.slice(0, 500),
          },
        };
      }
      if (!reviewerApproved) {
        commandReview = {
          status: review.status,
          decision: review.decision,
          confidence: review.confidence,
          risk: review.risk,
          reason: review.reason.slice(0, 500),
          model: review.model,
        };
      } else if (currentPolicy !== "approve-for-me") {
        humanOnlyReason = "Approve for Me was turned off during review";
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
    const match = approvalManager.findMatchingCommandRule(sessionId, cmd);
    if (match) {
      return {
        command: cmd,
        existingRule: {
          pattern: match.rule.pattern,
          mode: match.rule.mode,
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
  const { promise } = approvalPanel.enqueueCommandApproval(
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
    },
  );
  const response = await promise;

  if (isCommandApprovalCancelled(sessionId, reviewProviders)) {
    return { approved: false, cancelled: true };
  }

  if (response.decision === "reject") {
    return { approved: false, reason: response.rejectionReason };
  }

  // Save per-sub-command rules (each with its own scope)
  if (response.rules && response.rules.length > 0) {
    for (const rule of response.rules) {
      if (rule.mode === "skip" || !rule.pattern) {
        continue;
      }
      const scope = rule.scope as "session" | "project" | "global";
      approvalManager.addCommandRule(
        sessionId,
        {
          pattern: rule.pattern,
          mode: rule.mode as "prefix" | "exact" | "regex",
        },
        scope,
      );
    }
  }

  if (response.editedCommand) {
    return {
      approved: true,
      approval: { by: "human_edited" },
      editedCommand: response.editedCommand,
      followUp: response.followUp,
    };
  }
  return {
    approved: true,
    approval: { by: "human" },
    followUp: response.followUp,
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
          }),
        },
      ],
    };
  }

  return null;
}
