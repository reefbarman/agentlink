import * as vscode from "vscode";
import * as path from "path";

import { getFirstWorkspaceRoot } from "../util/paths.js";
import { getTerminalManager } from "../integrations/TerminalManager.js";
import type { ApprovalManager, CommandRule } from "../approvals/ApprovalManager.js";
import { splitCompoundCommand } from "../approvals/commandSplitter.js";
import { promptRejectionReason } from "../util/rejectionReason.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export async function handleExecuteCommand(
  params: {
    command: string;
    cwd?: string;
    terminal_id?: string;
    terminal_name?: string;
    background?: boolean;
    timeout?: number;
  },
  approvalManager: ApprovalManager,
  sessionId: string,
): Promise<ToolResult> {
  try {
    const workspaceRoot = getFirstWorkspaceRoot();

    // Resolve cwd
    let cwd = workspaceRoot;
    if (params.cwd) {
      cwd = path.isAbsolute(params.cwd) ? params.cwd : path.resolve(workspaceRoot, params.cwd);
    }

    // Master bypass check
    const masterBypass = vscode.workspace
      .getConfiguration("native-claude")
      .get<boolean>("masterBypass", false);

    if (!masterBypass) {
      // Split compound command and approve each sub-command
      const subCommands = splitCompoundCommand(params.command);
      const result = await approveSubCommands(subCommands, approvalManager, sessionId);

      if (!result.approved) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "rejected",
                command: params.command,
                ...(result.reason && { reason: result.reason }),
              }),
            },
          ],
        };
      }
    }

    const terminalManager = getTerminalManager();
    const result = await terminalManager.executeCommand({
      command: params.command,
      cwd,
      terminal_id: params.terminal_id,
      terminal_name: params.terminal_name,
      background: params.background,
      timeout: params.timeout ? params.timeout * 1000 : undefined, // seconds → ms
    });

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message, command: params.command }) }],
    };
  }
}

/**
 * Approve each sub-command in sequence.
 * Returns { approved: true } if ALL are approved, or { approved: false, reason? } if any is rejected.
 */
async function approveSubCommands(
  subCommands: string[],
  approvalManager: ApprovalManager,
  sessionId: string,
): Promise<{ approved: boolean; reason?: string }> {
  for (const sub of subCommands) {
    if (approvalManager.isCommandApproved(sessionId, sub)) {
      continue;
    }

    const decision = await showCommandApproval(sub);

    if (decision === "reject") {
      const reason = await promptRejectionReason();
      return { approved: false, reason };
    }
    if (decision === "run-once") continue;

    // "session", "project", or "global" — show pattern editor
    const rule = await showPatternEditor(sub);
    if (!rule) continue; // cancelled → treat as run-once

    const scope = decision === "session" ? "session" : decision === "project" ? "project" : "global";
    approvalManager.addCommandRule(sessionId, rule, scope);
  }

  return { approved: true };
}

type ApprovalDecision = "run-once" | "session" | "project" | "global" | "reject";

/**
 * Dialog 1: Show the command with action buttons.
 */
async function showCommandApproval(command: string): Promise<ApprovalDecision> {
  const items: Array<vscode.QuickPickItem & { decision: ApprovalDecision }> = [
    {
      label: "$(play) Run Once",
      description: "Execute this command now, don't save a rule",
      decision: "run-once",
    },
    {
      label: "$(bookmark) Accept for Session",
      description: "Save a trusted pattern for this session",
      decision: "session",
    },
    {
      label: "$(folder) Accept for Project",
      description: "Save a trusted pattern in .claude/native-claude.json",
      decision: "project",
    },
    {
      label: "$(globe) Accept Always",
      description: "Save a trusted pattern permanently (~/.claude/native-claude.json)",
      decision: "global",
    },
    {
      label: "$(close) Reject",
      description: "Do not run this command",
      decision: "reject",
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: `Command: ${command}`,
    placeHolder: "Choose how to handle this command",
    ignoreFocusOut: true,
  });

  return picked?.decision ?? "reject";
}

/**
 * Dialog 2: Pattern editor — the command is pre-filled in the input field
 * (user can edit it), and the items are match modes to pick from.
 * Selecting a mode accepts the current input text as the pattern.
 */
function showPatternEditor(command: string): Promise<CommandRule | null> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { mode: CommandRule["mode"] }>();
    qp.title = "Edit pattern, then pick match mode";
    qp.placeholder = "Edit the command above → then select how to match it";
    qp.value = command;
    qp.items = [
      {
        label: "$(symbol-text) Prefix Match",
        description: "Trust commands starting with this text",
        mode: "prefix" as const,
        alwaysShow: true,
      },
      {
        label: "$(symbol-key) Exact Match",
        description: "Trust only this exact command",
        mode: "exact" as const,
        alwaysShow: true,
      },
      {
        label: "$(regex) Regex Match",
        description: "Trust commands matching this as a regex",
        mode: "regex" as const,
        alwaysShow: true,
      },
    ];
    qp.ignoreFocusOut = true;

    let resolved = false;

    qp.onDidAccept(() => {
      const selected = qp.selectedItems[0];
      if (selected && qp.value.trim()) {
        resolved = true;
        resolve({ pattern: qp.value.trim(), mode: selected.mode });
        qp.dispose();
      }
    });

    qp.onDidHide(() => {
      if (!resolved) resolve(null);
      qp.dispose();
    });

    qp.show();
  });
}
