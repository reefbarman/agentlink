/**
 * Setup commands for instruction files and hooks.
 * These replace the shell scripts (inject-instructions.sh, enforce-agentlink.sh)
 * so end users don't need the repo — everything ships in the VSIX.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const BEGIN_MARKER = "<!-- BEGIN agentlink -->";
const END_MARKER = "<!-- END agentlink -->";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getResourcePath(extensionUri: vscode.Uri, filename: string): string {
  return vscode.Uri.joinPath(extensionUri, "resources", filename).fsPath;
}

/**
 * Inject content into a file wrapped in BEGIN/END markers.
 * Creates the file if it doesn't exist, replaces existing block if markers
 * are found, or appends if no markers exist.
 */
function injectContent(targetPath: string, content: string): string {
  const boundedBlock = `${BEGIN_MARKER}\n${content}\n${END_MARKER}`;
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(targetPath)) {
    fs.writeFileSync(targetPath, boundedBlock + "\n", "utf-8");
    return `Created ${targetPath}`;
  }

  const existing = fs.readFileSync(targetPath, "utf-8");

  if (existing.includes(BEGIN_MARKER)) {
    // Replace existing block between markers (inclusive)
    const regex = new RegExp(
      `${escapeRegex(BEGIN_MARKER)}[\\s\\S]*?${escapeRegex(END_MARKER)}`,
    );
    const updated = existing.replace(regex, boundedBlock);
    fs.writeFileSync(targetPath, updated, "utf-8");
    return `Updated agentlink section in ${targetPath}`;
  }

  // No markers found — append
  fs.writeFileSync(targetPath, existing + "\n" + boundedBlock + "\n", "utf-8");
  return `Appended agentlink instructions to ${targetPath}`;
}

/**
 * Determine the instruction template file and target path for an agent.
 */
function getInstructionPaths(
  extensionUri: vscode.Uri,
  agentId: string,
): { templateFile: string; targetPath: string } | null {
  if (agentId === "claude-code") {
    return {
      templateFile: getResourcePath(extensionUri, "claude-instructions.md"),
      targetPath: path.join(os.homedir(), ".claude", "CLAUDE.md"),
    };
  }

  // All other agents use the generic template at project level
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceFolder) return null;

  const templateFile = getResourcePath(extensionUri, "agents-instructions.md");
  let targetPath: string;

  switch (agentId) {
    case "copilot":
      targetPath = path.join(
        workspaceFolder,
        ".github",
        "copilot-instructions.md",
      );
      break;
    case "roo-code":
      targetPath = path.join(workspaceFolder, ".roo", "rules", "agentlink.md");
      break;
    case "cline":
      targetPath = path.join(workspaceFolder, ".clinerules");
      break;
    case "kilo-code":
      targetPath = path.join(
        workspaceFolder,
        ".kilocode",
        "rules",
        "agentlink.md",
      );
      break;
    case "codex":
      targetPath = path.join(workspaceFolder, "AGENTS.md");
      break;
    default:
      return null;
  }

  return { templateFile, targetPath };
}

interface SetupOptions {
  silent?: boolean;
}

/**
 * Set up instruction files for a specific agent.
 * Claude Code → ~/.claude/CLAUDE.md (global)
 * Others → project-level instruction file
 */
export function setupInstructions(
  extensionUri: vscode.Uri,
  agentId: string,
  log: (msg: string) => void,
  opts: SetupOptions = {},
): void {
  const paths = getInstructionPaths(extensionUri, agentId);
  if (!paths) {
    if (agentId !== "claude-code" && !opts.silent) {
      vscode.window.showWarningMessage(
        "No workspace folder open. Open a project first.",
      );
    } else {
      log(`No instruction setup available for agent: ${agentId}`);
    }
    return;
  }

  const content = fs.readFileSync(paths.templateFile, "utf-8");
  const result = injectContent(paths.targetPath, content);
  log(result);
  if (!opts.silent) {
    vscode.window.showInformationMessage(result);
  }
}

/**
 * Set up instruction files for all configured agents.
 */
export function setupAllInstructions(
  extensionUri: vscode.Uri,
  agentIds: string[],
  log: (msg: string) => void,
  opts: SetupOptions = {},
): void {
  for (const id of agentIds) {
    setupInstructions(extensionUri, id, log, opts);
  }
}

/**
 * Install the PreToolUse enforcement hook for Claude Code.
 * - Copies enforce-agentlink.sh to ~/.claude/hooks/
 * - Adds the hook entry to ~/.claude/settings.json
 */
export function installHooks(
  extensionUri: vscode.Uri,
  log: (msg: string) => void,
  opts: SetupOptions = {},
): void {
  // Copy hook script
  const hookDir = path.join(os.homedir(), ".claude", "hooks");
  fs.mkdirSync(hookDir, { recursive: true });

  const hookSrc = getResourcePath(extensionUri, "enforce-agentlink.sh");
  const hookDest = path.join(hookDir, "enforce-agentlink.sh");
  fs.copyFileSync(hookSrc, hookDest);
  fs.chmodSync(hookDest, 0o755);
  log(`Installed hook script to ${hookDest}`);

  // Update ~/.claude/settings.json
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    } catch {
      log(`Warning: could not parse ${settingsPath}, creating fresh`);
    }
  }

  type HookEntry = {
    matcher: string;
    hooks: { type: string; command: string }[];
  };

  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks as Record<string, HookEntry[]>;
  if (!hooks.PreToolUse) hooks.PreToolUse = [];

  const hookEntry: HookEntry = {
    matcher: "^(Read|Edit|Write|Bash|Glob|Grep)$",
    hooks: [
      {
        type: "command",
        command: "$HOME/.claude/hooks/enforce-agentlink.sh",
      },
    ],
  };

  const alreadyExists = hooks.PreToolUse.some(
    (h) => h.matcher === hookEntry.matcher,
  );

  if (!alreadyExists) {
    hooks.PreToolUse.push(hookEntry);
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(settings, null, 2) + "\n",
      "utf-8",
    );
    log("Added PreToolUse hook to ~/.claude/settings.json");
  } else {
    log("PreToolUse hook already exists in ~/.claude/settings.json");
  }

  if (!opts.silent) {
    vscode.window.showInformationMessage(
      "Installed AgentLink enforcement hooks.",
    );
  }
}
