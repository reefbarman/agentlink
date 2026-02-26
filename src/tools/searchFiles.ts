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

const DEFAULT_MAX_RESULTS = 300;

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export async function handleSearchFiles(
  params: {
    path: string;
    regex: string;
    file_pattern?: string;
    semantic?: boolean;
    context?: number;
    case_insensitive?: boolean;
    multiline?: boolean;
    max_results?: number;
    output_mode?: string;
  },
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

    const maxResults = params.max_results ?? DEFAULT_MAX_RESULTS;
    const outputMode = params.output_mode ?? "content";

    // Ripgrep regex search
    const rgPath = await getRipgrepBinPath();
    const cwd = getFirstWorkspaceRoot();

    // --- files_with_matches mode ---
    if (outputMode === "files_with_matches") {
      return await searchFilesOnly(rgPath, dirPath, params);
    }

    // --- count mode ---
    if (outputMode === "count") {
      return await searchCount(rgPath, dirPath, params);
    }

    // --- content mode (default) ---
    const contextLines = params.context ?? 1;
    const args = ["--json", "-e", params.regex, "--context", String(contextLines), "--no-messages"];

    if (params.case_insensitive) {
      args.push("--ignore-case");
    }
    if (params.multiline) {
      args.push("--multiline", "--multiline-dotall");
    }

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
      if (matchCount >= maxResults) break;

      const relPath = path.relative(dirPath, file.file);
      const fileLines: string[] = [];
      let fileMatchCount = 0;

      for (const result of file.searchResults) {
        if (matchCount >= maxResults) break;

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
      total_matches: Math.min(totalMatches, maxResults),
      truncated: totalMatches >= maxResults,
      results: formatted.join("\n\n"),
    };

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: JSON.stringify({ error: message, path: params.path }) }] };
  }
}

// --- files_with_matches mode ---

async function searchFilesOnly(
  rgPath: string,
  dirPath: string,
  params: { regex: string; file_pattern?: string; case_insensitive?: boolean; multiline?: boolean; max_results?: number },
): Promise<ToolResult> {
  const args = ["--files-with-matches", "-e", params.regex, "--no-messages"];

  if (params.case_insensitive) args.push("--ignore-case");
  if (params.multiline) args.push("--multiline", "--multiline-dotall");
  if (params.file_pattern) args.push("--glob", params.file_pattern);
  args.push(dirPath);

  let output: string;
  try {
    output = await execRipgrepSearch(rgPath, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: JSON.stringify({ error: message, regex: params.regex }) }] };
  }

  const files = output.trim().split("\n").filter(Boolean);
  const maxResults = params.max_results ?? DEFAULT_MAX_RESULTS;
  const truncated = files.length > maxResults;
  const limited = files.slice(0, maxResults).map((f) => path.relative(dirPath, f));

  return {
    content: [{ type: "text", text: JSON.stringify({
      total_files: Math.min(files.length, maxResults),
      truncated,
      files: limited,
    }, null, 2) }],
  };
}

// --- count mode ---

async function searchCount(
  rgPath: string,
  dirPath: string,
  params: { regex: string; file_pattern?: string; case_insensitive?: boolean; multiline?: boolean; max_results?: number },
): Promise<ToolResult> {
  const args = ["--count", "-e", params.regex, "--no-messages"];

  if (params.case_insensitive) args.push("--ignore-case");
  if (params.multiline) args.push("--multiline", "--multiline-dotall");
  if (params.file_pattern) args.push("--glob", params.file_pattern);
  args.push(dirPath);

  let output: string;
  try {
    output = await execRipgrepSearch(rgPath, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: JSON.stringify({ error: message, regex: params.regex }) }] };
  }

  const lines = output.trim().split("\n").filter(Boolean);
  const maxResults = params.max_results ?? DEFAULT_MAX_RESULTS;
  let totalMatches = 0;
  const counts: Array<{ file: string; count: number }> = [];

  for (const line of lines) {
    if (counts.length >= maxResults) break;
    const sepIdx = line.lastIndexOf(":");
    if (sepIdx === -1) continue;
    const file = path.relative(dirPath, line.substring(0, sepIdx));
    const count = parseInt(line.substring(sepIdx + 1), 10);
    if (!isNaN(count)) {
      counts.push({ file, count });
      totalMatches += count;
    }
  }

  return {
    content: [{ type: "text", text: JSON.stringify({
      total_files: counts.length,
      total_matches: totalMatches,
      truncated: lines.length > maxResults,
      counts,
    }, null, 2) }],
  };
}
