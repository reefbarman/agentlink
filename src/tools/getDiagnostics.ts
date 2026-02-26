import * as vscode from "vscode";
import * as path from "path";

import { resolveAndValidatePath, getWorkspaceRoots } from "../util/paths.js";

export async function handleGetDiagnostics(params: {
  path?: string;
  severity?: string;
  source?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  try {
    let diagnostics: [vscode.Uri, vscode.Diagnostic[]][];

    if (params.path) {
      const { absolutePath: filePath } = resolveAndValidatePath(params.path);
      const uri = vscode.Uri.file(filePath);
      const fileDiags = vscode.languages.getDiagnostics(uri);
      diagnostics = [[uri, fileDiags]];
    } else {
      diagnostics = vscode.languages.getDiagnostics();
    }

    // Build severity filter set
    const allowedSeverities = parseSeverityFilter(params.severity);

    const roots = getWorkspaceRoots();
    const lines: string[] = [];

    for (const [uri, diags] of diagnostics) {
      if (diags.length === 0) continue;

      // Get relative path
      let relPath = uri.fsPath;
      for (const root of roots) {
        if (relPath.startsWith(root + path.sep)) {
          relPath = path.relative(root, relPath);
          break;
        }
      }

      // Build source filter set
      const allowedSources = params.source
        ? new Set(params.source.toLowerCase().split(",").map((s) => s.trim()).filter(Boolean))
        : null;

      for (const diag of diags) {
        if (allowedSeverities && !allowedSeverities.has(diag.severity)) continue;
        if (allowedSources && (!diag.source || !allowedSources.has(diag.source.toLowerCase()))) continue;

        const severity = severityToString(diag.severity);
        const line = diag.range.start.line + 1;
        const col = diag.range.start.character + 1;
        const source = diag.source ? ` (${diag.source})` : "";
        lines.push(`[${severity}] ${relPath}:${line}:${col} — ${diag.message}${source}`);
      }
    }

    if (lines.length === 0) {
      return { content: [{ type: "text", text: "No diagnostics found." }] };
    }

    const result = {
      count: lines.length,
      diagnostics: lines.join("\n"),
    };

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: JSON.stringify({ error: message }) }] };
  }
}

const VALID_SEVERITIES = new Set(["error", "warning", "info", "information", "hint"]);

function parseSeverityFilter(filter?: string): Set<vscode.DiagnosticSeverity> | null {
  if (!filter) return null; // no filter = show all

  const allowed = new Set<vscode.DiagnosticSeverity>();
  const parts = filter.toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const unknown: string[] = [];

  for (const part of parts) {
    switch (part) {
      case "error": allowed.add(vscode.DiagnosticSeverity.Error); break;
      case "warning": allowed.add(vscode.DiagnosticSeverity.Warning); break;
      case "info": case "information": allowed.add(vscode.DiagnosticSeverity.Information); break;
      case "hint": allowed.add(vscode.DiagnosticSeverity.Hint); break;
      default: unknown.push(part);
    }
  }

  if (allowed.size === 0 && unknown.length > 0) {
    throw new Error(
      `Unknown severity filter: ${unknown.join(", ")}. Valid values: error, warning, info, information, hint`,
    );
  }

  return allowed.size > 0 ? allowed : null;
}

function severityToString(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "Error";
    case vscode.DiagnosticSeverity.Warning:
      return "Warning";
    case vscode.DiagnosticSeverity.Information:
      return "Info";
    case vscode.DiagnosticSeverity.Hint:
      return "Hint";
    default:
      return "Unknown";
  }
}
