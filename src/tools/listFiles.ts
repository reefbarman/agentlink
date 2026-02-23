import * as fs from "fs/promises";
import * as path from "path";

import { resolveAndValidatePath } from "../util/paths.js";
import { getRipgrepBinPath, execRipgrepFiles } from "../util/ripgrep.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import { approveOutsideWorkspaceAccess } from "./pathAccessUI.js";

const MAX_ENTRIES = 500;

export async function handleListFiles(
  params: { path: string; recursive?: boolean; depth?: number },
  approvalManager: ApprovalManager,
  sessionId: string,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  try {
    const { absolutePath: dirPath, inWorkspace } = resolveAndValidatePath(params.path);

    // Outside-workspace gate
    if (!inWorkspace && !approvalManager.isPathTrusted(sessionId, dirPath)) {
      const { approved, reason } = await approveOutsideWorkspaceAccess(dirPath, approvalManager, sessionId);
      if (!approved) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "rejected", path: params.path, ...(reason && { reason }),
          }) }],
        };
      }
    }
    const recursive = params.recursive ?? false;

    if (recursive || params.depth) {
      return await listRecursive(dirPath, params.path, params.depth);
    } else {
      return await listShallow(dirPath, params.path);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: JSON.stringify({ error: message, path: params.path }) }] };
  }
}

async function listShallow(
  dirPath: string,
  inputPath: string
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const lines: string[] = [];
  let truncated = false;

  for (const entry of entries) {
    if (lines.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const suffix = entry.isDirectory() ? "/" : "";
    lines.push(entry.name + suffix);
  }

  const result = {
    path: inputPath,
    entries: lines.join("\n"),
    count: lines.length,
    truncated,
  };

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

async function listRecursive(
  dirPath: string,
  inputPath: string,
  depth?: number
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const rgPath = await getRipgrepBinPath();
  const args = [
    "--files",
    "--hidden",
    "--follow",
    "-g", "!**/node_modules/**",
    "-g", "!**/.git/**",
  ];

  if (depth !== undefined && depth > 0) {
    args.push("--max-depth", String(depth));
  }

  args.push(dirPath);

  const files = await execRipgrepFiles(rgPath, args, MAX_ENTRIES + 1);
  const truncated = files.length > MAX_ENTRIES;
  const entries = files.slice(0, MAX_ENTRIES).map((f) => path.relative(dirPath, f));
  entries.sort();

  const result = {
    path: inputPath,
    entries: entries.join("\n"),
    count: entries.length,
    truncated,
  };

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}
