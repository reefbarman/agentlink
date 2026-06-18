import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";

import { getWorkspaceRoots, tryGetFirstWorkspaceRoot } from "../util/paths.js";
import type { TerminalProvider } from "../core/capabilities/terminal.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import type { TrackerContext } from "../server/ToolCallTracker.js";
import {
  splitCompoundCommand,
  expandSubCommands,
} from "../approvals/commandSplitter.js";
import {
  classifyCommand,
  isTierAtOrBelow,
  type CommandTier,
} from "../approvals/commandTierClassifier.js";
import type { SubCommandEntry } from "../approvals/webview/types.js";
import { filterOutput, saveOutputTempFile } from "../util/outputFilter.js";
import { validateCommand } from "../util/pipeValidator.js";
import { validateInteractiveCommand } from "../util/interactiveValidator.js";
import { validateProtectedWriteCommand } from "../util/protectedWriteValidator.js";
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
  | { by: "master_bypass" }
  | { by: "explicit_rule" }
  | { by: "recent_approval" }
  | { by: "tier"; tier: CommandTier; threshold: "safe" | "sensitive" }
  | { by: "human" }
  | { by: "human_edited" };

import { type ToolResult } from "../shared/types.js";

export interface ExecuteCommandProviders {
  terminalProvider?: TerminalProvider;
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

    // Master bypass check
    const masterBypass = vscode.workspace
      .getConfiguration("agentlink")
      .get<boolean>("masterBypass", false);

    let commandToRun = params.command;
    let commandEditedByUser = false;
    let inlineRun: ReturnType<typeof materializeInlineCommandFiles> | undefined;
    let inlineFiles: InlineCommandFilePreview[] | undefined;
    let approvalFollowUp: string | undefined;
    let approvalAudit: CommandApprovalAudit | undefined = masterBypass
      ? { by: "master_bypass" }
      : undefined;
    let autoApprovedByTier:
      | { tier: CommandTier; threshold: "safe" | "sensitive" }
      | undefined;

    if (params.files && params.files.length > 0) {
      if (params.background) {
        return rejectedCommandResult(
          params.command,
          "execute_command files cannot be used with background=true because temp-file cleanup would be unsafe.",
        );
      }
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

      if (!masterBypass) {
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
            getWorkspaceRoots(),
            {
              displayCommand: commandToRun,
              inlineFiles,
              requireHumanApproval: inlineFiles !== undefined,
            },
          );

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
          }

          approvalFollowUp = approvalResult.followUp;
          approvalAudit = approvalResult.approval;
          autoApprovedByTier = approvalResult.autoApprovedByTier;
        } finally {
          releaseGate();
        }
      }

      const result = await providers.terminalProvider.executeCommand({
        command: commandToRun,
        cwd,
        terminal_id: params.terminal_id,
        terminal_name: params.terminal_name,
        split_from: params.split_from,
        background: params.background,
        timeout: params.timeout ? params.timeout * 1000 : undefined, // seconds → ms
        env: params.env,
        onTerminalAssigned: trackerCtx
          ? (tid) => trackerCtx.setTerminalId(tid)
          : undefined,
      });

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
      inlineRun?.cleanup();
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
  },
): Promise<{
  approved: boolean;
  reason?: string;
  editedCommand?: string;
  followUp?: string;
  approval?: CommandApprovalAudit;
  autoApprovedByTier?: { tier: CommandTier; threshold: "safe" | "sensitive" };
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

  const threshold = vscode.workspace
    .getConfiguration("agentlink")
    .get<"off" | "safe" | "sensitive">("commandAutoApproveTier", "off");
  const tierInfo = classifyCommand(fullCommand, { cwd, workspaceRoots });
  if (
    !options?.requireHumanApproval &&
    threshold !== "off" &&
    isTierAtOrBelow(tierInfo.tier, threshold)
  ) {
    return {
      approved: true,
      approval: { by: "tier", tier: tierInfo.tier, threshold },
      autoApprovedByTier: { tier: tierInfo.tier, threshold },
    };
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
  const { promise } = approvalPanel.enqueueCommandApproval(
    options?.displayCommand ?? fullCommand,
    fullCommand,
    { subCommands: entries, inlineFiles: options?.inlineFiles, reason, cwd },
  );
  const response = await promise;

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

function validateCommandBeforeExecution(
  command: string,
  cwd: string,
  originalCommand?: string,
): ToolResult | null {
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
