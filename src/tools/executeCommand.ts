import * as vscode from "vscode";
import * as path from "path";

import { getFirstWorkspaceRoot } from "../util/paths.js";
import { getTerminalManager } from "../integrations/TerminalManager.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import type { TrackerContext } from "../server/ToolCallTracker.js";
import { splitCompoundCommand } from "../approvals/commandSplitter.js";
import { filterOutput, saveOutputTempFile } from "../util/outputFilter.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export async function handleExecuteCommand(
  params: {
    command: string;
    cwd?: string;
    terminal_id?: string;
    terminal_name?: string;
    background?: boolean;
    timeout?: number;
    output_head?: number;
    output_tail?: number;
    output_offset?: number;
    output_grep?: string;
    output_grep_context?: number;
  },
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
  trackerCtx?: TrackerContext,
): Promise<ToolResult> {
  try {
    const workspaceRoot = getFirstWorkspaceRoot();

    // Resolve cwd
    let cwd = workspaceRoot;
    if (params.cwd) {
      cwd = path.isAbsolute(params.cwd)
        ? params.cwd
        : path.resolve(workspaceRoot, params.cwd);
    }

    // Master bypass check
    const masterBypass = vscode.workspace
      .getConfiguration("native-claude")
      .get<boolean>("masterBypass", false);

    let commandToRun = params.command;

    if (!masterBypass) {
      // Split compound command and approve each sub-command
      const subCommands = splitCompoundCommand(params.command);
      const approvalResult = await approveSubCommands(
        subCommands,
        params.command,
        approvalManager,
        approvalPanel,
        sessionId,
      );

      if (!approvalResult.approved) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "rejected",
                command: params.command,
                ...(approvalResult.reason && { reason: approvalResult.reason }),
              }),
            },
          ],
        };
      }

      if (approvalResult.editedCommand) {
        commandToRun = approvalResult.editedCommand;
      }
    }

    const terminalManager = getTerminalManager();
    const result = await terminalManager.executeCommand({
      command: commandToRun,
      cwd,
      terminal_id: params.terminal_id,
      terminal_name: params.terminal_name,
      background: params.background,
      timeout: params.timeout ? params.timeout * 1000 : undefined, // seconds → ms
      onTerminalAssigned: trackerCtx
        ? (tid) => trackerCtx.setTerminalId(tid)
        : undefined,
    });

    // Apply output filtering and temp file saving
    if (result.output_captured && result.output) {
      const { filtered, totalLines, linesShown } = filterOutput(result.output, {
        output_head: params.output_head,
        output_tail: params.output_tail,
        output_offset: params.output_offset,
        output_grep: params.output_grep,
        output_grep_context: params.output_grep_context,
      });

      result.total_lines = totalLines;
      result.lines_shown = linesShown;

      // Only save temp file when output is actually being truncated
      if (linesShown < totalLines) {
        const outputFile = saveOutputTempFile(result.output);
        if (outputFile) {
          result.output_file = outputFile;
        }
      }

      result.output = filtered;
    }

    // If the user edited the command, include modification info
    if (commandToRun !== params.command) {
      result.command_modified = true;
      result.original_command = params.command;
      result.command = commandToRun;
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: message, command: params.command }),
        },
      ],
    };
  }
}

/**
 * Approve sub-commands by showing a single dialog with the full command.
 *
 * - Run/Edit/Reject applies to the whole command at once.
 * - Trust buttons (Session/Project/Always) show an inline multi-entry
 *   pattern editor so the user can set per-sub-command rules in-place.
 */
async function approveSubCommands(
  subCommands: string[],
  fullCommand: string,
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
): Promise<{ approved: boolean; reason?: string; editedCommand?: string }> {
  // Find which sub-commands still need approval
  const unapproved = subCommands.filter(
    (sub) => !approvalManager.isCommandApproved(sessionId, sub),
  );

  // All sub-commands already approved
  if (unapproved.length === 0) return { approved: true };

  // Show ONE dialog with the full command (passes sub-commands for multi-entry pattern editor)
  const { promise, id: approvalId } = approvalPanel.enqueueCommandApproval(
    fullCommand,
    fullCommand,
    { subCommands: unapproved.length > 1 ? unapproved : undefined },
  );
  const response = await promise;

  if (response.decision === "reject") {
    return { approved: false, reason: response.rejectionReason };
  }
  if (response.decision === "edit") {
    return { approved: true, editedCommand: response.editedCommand };
  }
  if (response.decision === "run-once") {
    if (response.editedCommand) {
      return { approved: true, editedCommand: response.editedCommand };
    }
    return { approved: true };
  }

  // Trust decision (session/project/global)
  const trustScope = response.decision as "session" | "project" | "global";

  // Compound command with per-sub-command rules from inline multi-entry editor
  if (response.rules && response.rules.length > 0) {
    for (const rule of response.rules) {
      if (rule.mode === "skip" || !rule.pattern) continue;
      approvalManager.addCommandRule(
        sessionId,
        { pattern: rule.pattern, mode: rule.mode },
        trustScope,
      );
    }
  } else if (response.rulePattern && response.ruleMode) {
    // Single command — rule from inline pattern editor
    approvalManager.addCommandRule(
      sessionId,
      { pattern: response.rulePattern, mode: response.ruleMode },
      trustScope,
    );
  }

  if (response.editedCommand) {
    return { approved: true, editedCommand: response.editedCommand };
  }
  return { approved: true };
}
