import * as path from "path";

import { resolveAndValidatePath, getFirstWorkspaceRoot } from "../util/paths.js";
import {
  getRipgrepBinPath,
  execRipgrepSearch,
  parseRipgrepOutput,
} from "../util/ripgrep.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { approveOutsideWorkspaceAccess } from "./pathAccessUI.js";

const MAX_RESULTS = 300;

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export async function handleSearchFiles(
  params: { path: string; regex: string; file_pattern?: string; semantic?: boolean },
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
): Promise<ToolResult> {
  try {
    const { absolutePath: dirPath, inWorkspace } = resolveAndValidatePath(params.path);

    // Outside-workspace gate
    if (!inWorkspace && !approvalManager.isPathTrusted(sessionId, dirPath)) {
      const { approved, reason } = await approveOutsideWorkspaceAccess(dirPath, approvalManager, approvalPanel, sessionId);
      if (!approved) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "rejected", path: params.path, ...(reason && { reason }),
          }) }],
        };
      }
    }

    // Semantic search is handled separately
    if (params.semantic) {
      const { semanticSearch } = await import("../services/semanticSearch.js");
      return semanticSearch(dirPath, params.regex);
    }

    // Ripgrep regex search
    const rgPath = await getRipgrepBinPath();
    const cwd = getFirstWorkspaceRoot();

    const args = ["--json", "-e", params.regex, "--context", "1", "--no-messages"];

    // Only add --glob if a specific file pattern is provided
    // Using --glob "*" overrides .gitignore behavior
    if (params.file_pattern) {
      args.push("--glob", params.file_pattern);
    }

    args.push(dirPath);

    let output: string;
    try {
      output = await execRipgrepSearch(rgPath, args);
    } catch (error) {
      // Ripgrep error — may be invalid regex syntax etc.
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: JSON.stringify({ error: message, regex: params.regex }) }] };
    }

    if (!output.trim()) {
      return {
        content: [{ type: "text", text: JSON.stringify({ total_matches: 0, truncated: false, results: "No results found" }) }],
      };
    }

    const { results: fileResults, totalMatches } = parseRipgrepOutput(output, cwd);

    // Format output — keep ## file.ts + "> linenum | content" format
    const formatted: string[] = [];
    let matchCount = 0;

    for (const file of fileResults) {
      if (matchCount >= MAX_RESULTS) break;

      const relPath = path.relative(dirPath, file.file);
      const fileLines: string[] = [];
      let fileMatchCount = 0;

      for (const result of file.searchResults) {
        if (matchCount >= MAX_RESULTS) break;

        for (const line of result.lines) {
          const prefix = line.isMatch ? ">" : " ";
          fileLines.push(`${prefix} ${line.line} | ${line.text.trimEnd()}`);
        }
        fileLines.push("---");

        const groupMatches = result.lines.filter((l) => l.isMatch).length;
        fileMatchCount += groupMatches;
        matchCount += groupMatches;
      }

      if (fileLines.length > 0) {
        const countLabel = fileMatchCount === 1 ? "1 match" : `${fileMatchCount} matches`;
        formatted.push(`## ${relPath} (${countLabel})\n${fileLines.join("\n")}`);
      }
    }

    const result = {
      total_matches: Math.min(totalMatches, MAX_RESULTS),
      truncated: totalMatches >= MAX_RESULTS,
      results: formatted.join("\n\n"),
    };

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: JSON.stringify({ error: message, path: params.path }) }] };
  }
}
