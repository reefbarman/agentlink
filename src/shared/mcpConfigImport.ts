import { parseJsonWithComments } from "../util/jsonc.js";
import {
  type McpCanonicalServerDraft,
  type McpConfigDiagnostic,
  type McpConfigDiagnosticCode,
  type McpConfigDiagnosticSeverity,
  validateMcpServerConfig,
} from "./mcpConfigValidation.js";

export type McpConfigImportRootKind =
  | "mcpServers"
  | "servers"
  | "named"
  | "bare";

export interface McpConfigImportReviewRow {
  sourceName: string;
  name: string;
  selected: boolean;
  valid: boolean;
  draft?: McpCanonicalServerDraft;
  diagnostics: McpConfigDiagnostic[];
}

export interface McpConfigImportReview {
  valid: boolean;
  rootKind?: McpConfigImportRootKind;
  rows: McpConfigImportReviewRow[];
  diagnostics: McpConfigDiagnostic[];
}

interface ImportCandidate {
  sourceName: unknown;
  config: unknown;
  path: string;
  namePath: string;
}

interface ExtractedCandidates {
  rootKind: McpConfigImportRootKind;
  candidates: ImportCandidate[];
  diagnostics: McpConfigDiagnostic[];
}

function diagnostic(
  severity: McpConfigDiagnosticSeverity,
  code: McpConfigDiagnosticCode,
  path: string,
  message: string,
): McpConfigDiagnostic {
  return { severity, code, path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function pathSegment(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key)
    ? `.${key}`
    : `[${JSON.stringify(key)}]`;
}

function unwrapCompleteFence(
  raw: string,
): { ok: true; text: string } | { ok: false; diagnostic: McpConfigDiagnostic } {
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const trimmed = withoutBom.trim();
  if (!trimmed.startsWith("```")) return { ok: true, text: trimmed };

  const match = /^```([^\r\n`]*)\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
  if (!match || match[2].includes("```")) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "error",
        "invalid_fence",
        "$",
        "Input may contain at most one complete Markdown code fence.",
      ),
    };
  }

  const language = match[1].trim().toLowerCase();
  if (language && language !== "json" && language !== "jsonc") {
    return {
      ok: false,
      diagnostic: diagnostic(
        "error",
        "invalid_fence",
        "$",
        "Markdown code fence must be unlabeled, json, or jsonc.",
      ),
    };
  }
  return { ok: true, text: match[2] };
}

function wrapperCandidates(
  wrapper: "mcpServers" | "servers",
  value: unknown,
  root: Record<string, unknown>,
): ExtractedCandidates | undefined {
  if (!isRecord(value)) return undefined;
  const diagnostics: McpConfigDiagnostic[] = [];
  for (const key of Object.keys(root)) {
    if (key !== wrapper) {
      diagnostics.push(
        diagnostic(
          "warning",
          "unknown_root_field",
          `$${pathSegment(key)}`,
          "Unsupported top-level field was not imported.",
        ),
      );
    }
  }
  return {
    rootKind: wrapper,
    candidates: Object.entries(value).map(([name, config]) => ({
      sourceName: name,
      config,
      path: `$${pathSegment(wrapper)}${pathSegment(name)}`,
      namePath: `$${pathSegment(wrapper)}${pathSegment(name)}`,
    })),
    diagnostics,
  };
}

function extractCandidates(value: unknown): ExtractedCandidates | undefined {
  if (!isRecord(value)) return undefined;

  const hasMcpServers = hasOwn(value, "mcpServers");
  const hasServers = hasOwn(value, "servers");
  if (hasMcpServers && hasServers) return undefined;
  if (hasMcpServers)
    return wrapperCandidates("mcpServers", value.mcpServers, value);
  if (hasServers) return wrapperCandidates("servers", value.servers, value);

  if (hasOwn(value, "name") && typeof value.name === "string") {
    const { name, ...config } = value;
    return {
      rootKind: "named",
      candidates: [
        {
          sourceName: name,
          config,
          path: "$",
          namePath: "$.name",
        },
      ],
      diagnostics: [],
    };
  }

  if (
    Object.keys(value).length > 0 &&
    Object.values(value).every((entry) => isRecord(entry))
  ) {
    return {
      rootKind: "bare",
      candidates: Object.entries(value).map(([name, config]) => ({
        sourceName: name,
        config,
        path: `$${pathSegment(name)}`,
        namePath: `$${pathSegment(name)}`,
      })),
      diagnostics: [],
    };
  }
  return undefined;
}

function safeSourceName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Parses pasted MCP configuration into an in-memory review model. It accepts
 * JSON/JSONC/BOM and, optionally, exactly one complete Markdown code fence.
 */
export function parseMcpConfigImport(raw: string): McpConfigImportReview {
  const unfenced = unwrapCompleteFence(raw);
  if (!unfenced.ok) {
    return {
      valid: false,
      rows: [],
      diagnostics: [unfenced.diagnostic],
    };
  }

  let parsed: unknown;
  try {
    parsed = parseJsonWithComments(unfenced.text);
  } catch {
    return {
      valid: false,
      rows: [],
      diagnostics: [
        diagnostic(
          "error",
          "invalid_json",
          "$",
          "Input is not valid JSON or JSONC.",
        ),
      ],
    };
  }

  const extracted = extractCandidates(parsed);
  if (!extracted) {
    return {
      valid: false,
      rows: [],
      diagnostics: [
        diagnostic(
          "error",
          "invalid_root",
          "$",
          "Expected mcpServers, servers, one named server, or a bare server map.",
        ),
      ],
    };
  }

  if (extracted.candidates.length === 0) {
    return {
      valid: false,
      rootKind: extracted.rootKind,
      rows: [],
      diagnostics: [
        ...extracted.diagnostics,
        diagnostic(
          "error",
          "no_servers",
          "$",
          "No MCP server configurations were found.",
        ),
      ],
    };
  }

  const rows: McpConfigImportReviewRow[] = extracted.candidates.map(
    (candidate) => {
      const result = validateMcpServerConfig(
        candidate.sourceName,
        candidate.config,
        {
          path: candidate.path,
          namePath: candidate.namePath,
        },
      );
      const name = result.draft?.name ?? safeSourceName(candidate.sourceName);
      return {
        sourceName: safeSourceName(candidate.sourceName),
        name,
        selected: result.valid,
        valid: result.valid,
        draft: result.draft,
        diagnostics: result.diagnostics,
      };
    },
  );

  const byName = new Map<string, McpConfigImportReviewRow[]>();
  for (const row of rows) {
    if (!row.name) continue;
    const matches = byName.get(row.name) ?? [];
    matches.push(row);
    byName.set(row.name, matches);
  }
  for (const matches of byName.values()) {
    if (matches.length < 2) continue;
    for (const row of matches) {
      row.valid = false;
      row.selected = false;
      row.draft = undefined;
      row.diagnostics.push(
        diagnostic(
          "error",
          "duplicate_server_name",
          "$",
          "Multiple imported servers normalize to the same name.",
        ),
      );
    }
  }

  const valid =
    !extracted.diagnostics.some((entry) => entry.severity === "error") &&
    rows.every((row) => row.valid);
  return {
    valid,
    rootKind: extracted.rootKind,
    rows,
    diagnostics: extracted.diagnostics,
  };
}
