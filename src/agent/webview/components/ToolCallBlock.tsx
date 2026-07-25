import { useCallback, useMemo, useState } from "preact/hooks";

import type { ContentBlock } from "../types";
import { InlineDiff } from "./InlineDiff";
import { JsonHighlight } from "../../../shared/ui/JsonHighlight";
import { matchFilePaths } from "./filePathLinks";

export type ToolCallData = ContentBlock & { type: "tool_call" };

const MCP_APPROVAL_SCOPE_PRESENTATION = {
  session: {
    label: "Session",
    icon: "codicon-history",
    title: "Allow for this chat session",
  },
  project: {
    label: "Project",
    icon: "codicon-folder",
    title: "Allow whenever this project uses the tool",
  },
  global: {
    label: "Global",
    icon: "codicon-globe",
    title: "Allow whenever any project uses the tool",
  },
} as const;

interface ToolCallBlockProps {
  toolCall: ToolCallData;
  onOpenFile?: (path: string, line?: number) => void;
  onRevealToolCallTerminal?: (id: string) => void;
  onContinueToolCallInBackground?: (id: string) => void;
  onCompleteToolCall?: (id: string) => void;
  onCancelToolCall?: (id: string) => void;
  onPromoteMcpToolApproval?: (promotion: {
    serverName: string;
    bareToolName: string;
    scope: "session" | "project" | "global";
  }) => void;
}

function FilePathLinkedText({
  text,
  onOpenFile,
}: {
  text: string;
  onOpenFile?: (path: string, line?: number) => void;
}) {
  const matches = useMemo(
    () => (onOpenFile ? matchFilePaths(text) : []),
    [onOpenFile, text],
  );
  if (matches.length === 0) return <>{text}</>;

  const parts = [];
  let lastIndex = 0;
  for (const match of matches) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <a
        key={`${match.index}:${match.fullMatch}`}
        class="tool-file-link"
        href="#"
        title={`Open ${match.filePath}${match.line !== undefined ? `:${match.line}` : ""}`}
        onClick={(event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenFile?.(match.filePath, match.line);
        }}
      >
        {match.fullMatch}
      </a>,
    );
    lastIndex = match.index + match.fullMatch.length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return <>{parts}</>;
}

/** Format duration as human-readable string. */
export function fmtDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Number of viewable images in a completed tool call's result. */
export function countResultImages(toolCall: ToolCallData): number {
  return toolCall.complete ? (toolCall.resultImages?.length ?? 0) : 0;
}

export function formatResultImageLabel(count: number): string {
  return count === 1 ? "1 image result" : `${count} image results`;
}

export function countResultDocuments(toolCall: ToolCallData): number {
  return toolCall.complete ? (toolCall.resultDocuments?.length ?? 0) : 0;
}

export function formatResultMediaLabel(
  imageCount: number,
  documentCount: number,
): string {
  if (documentCount === 0) return formatResultImageLabel(imageCount);
  const parts = [
    imageCount > 0
      ? imageCount === 1
        ? "1 image"
        : `${imageCount} images`
      : "",
    documentCount > 0
      ? documentCount === 1
        ? "1 document"
        : `${documentCount} documents`
      : "",
  ].filter(Boolean);
  return `${parts.join(" and ")} attached`;
}

/** Parse partial/full JSON safely. */
function tryParseJson(json: string): Record<string, unknown> | null {
  try {
    return json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
}

/** A summary part — either plain text or a clickable file link. */
type SummaryPart =
  | { type: "text"; text: string }
  | { type: "file"; display: string; path: string; line?: number }
  | { type: "badge"; text: string; title?: string };

function stripMediaPlaceholderLines(result: string): string {
  return result
    .split(/\r?\n/)
    .filter((line) => !/^\[(?:image|document)\]$/i.test(line.trim()))
    .join("\n")
    .trim();
}

function getGenericInputSummary(
  input: Record<string, unknown> | null,
): SummaryPart[] {
  if (!input) return [];
  const description = String(input.description ?? "").trim();
  if (description) {
    return [{ type: "text", text: description.slice(0, 100) }];
  }
  const command = String(input.command ?? "").trim();
  if (command) {
    return [
      {
        type: "text",
        text: command.length > 80 ? command.slice(0, 77) + "..." : command,
      },
    ];
  }
  const path = String(input.path ?? input.file_path ?? "").trim();
  if (path) return [filePart(path)];
  const query = String(input.query ?? "").trim();
  if (query) return [{ type: "text", text: query.slice(0, 100) }];
  const url = String(input.url ?? "").trim();
  return url ? [{ type: "text", text: url.slice(0, 140) }] : [];
}

/** Generate a smart one-liner summary for known tools. */
function getToolSummary(
  name: string,
  input: Record<string, unknown> | null,
  result: string,
  complete: boolean,
): SummaryPart[] {
  // While streaming input, show what we can parse
  if (!complete) {
    return getStreamingSummary(name, input);
  }

  // Completed tool — summarize based on tool name
  const p = input ?? {};
  const displayResult = stripMediaPlaceholderLines(result);
  switch (name) {
    case "web_search":
      return [{ type: "text", text: String(p.query ?? "").slice(0, 100) }];
    case "web_fetch":
      return [{ type: "text", text: String(p.url ?? "").slice(0, 140) }];
    case "read_file": {
      const path = String(p.path ?? "");
      const lines = extractField(result, "total_lines");
      const suffix = lines ? ` (${lines} lines)` : "";
      return [filePart(path), { type: "text", text: suffix }];
    }
    case "get_context": {
      const path = String(p.path ?? "");
      return [filePart(path)];
    }
    case "list_files": {
      const dir = String(p.path ?? ".");
      const count =
        extractField(result, "total_files") ??
        extractField(result, "total_results");
      const suffix = count ? ` — ${count} files` : "";
      return [filePart(dir), { type: "text", text: suffix }];
    }
    case "search_files": {
      const pat = String(p.regex ?? "");
      const matches = extractField(result, "total_matches");
      return [
        {
          type: "text",
          text: matches !== null ? `/${pat}/ — ${matches} matches` : `/${pat}/`,
        },
      ];
    }
    case "codebase_search":
      return [{ type: "text", text: String(p.query ?? "").slice(0, 60) }];
    case "write_file": {
      const path = String(p.path ?? "");
      if (extractField(result, "error")) {
        return [filePart(path), { type: "text", text: " — error" }];
      }
      const status = extractField(result, "status");
      if (status) {
        return [filePart(path), { type: "text", text: ` — ${status}` }];
      }
      const op = extractField(result, "operation") ?? "written";
      return [filePart(path), { type: "text", text: ` (${op})` }];
    }
    case "apply_diff": {
      const path = String(p.path ?? "");
      const status = extractField(result, "status") ?? "";
      const hasError = !!extractField(result, "error");
      return [
        filePart(path),
        ...(status
          ? [{ type: "text" as const, text: ` — ${status}` }]
          : hasError
            ? [{ type: "text" as const, text: " — error" }]
            : []),
      ];
    }
    case "find_and_replace": {
      const pat = String(p.file_pattern ?? "");
      return [{ type: "text", text: pat || "bulk replace" }];
    }
    case "execute_command": {
      const cmd = String(p.command ?? "");
      const exitCode = extractField(result, "exit_code");
      const resultPayload = parseResultObject(result);
      const approvalBadge = getCommandApprovalBadge(resultPayload);
      // Reserve space for exit/approval badges; truncate command to fit
      const maxLen =
        exitCode !== null && exitCode !== "0" ? 48 : approvalBadge ? 50 : 60;
      const cmdText =
        cmd.length > maxLen ? cmd.slice(0, maxLen - 3) + "..." : cmd;
      const parts: SummaryPart[] = [];
      if (exitCode !== null && exitCode !== "0") {
        parts.push({ type: "text", text: `\x00exit:${exitCode}` }); // sentinel for exit badge — rendered before command
      }
      if (approvalBadge) parts.push({ type: "badge", ...approvalBadge });
      const inlineFiles = Array.isArray(resultPayload?.inline_files)
        ? resultPayload.inline_files
        : [];
      if (inlineFiles.length > 0) {
        parts.push({
          type: "badge",
          text: `+${inlineFiles.length} files`,
          title: "Temporary inline files were attached to this command",
        });
      }
      parts.push({
        type: "text",
        text: `${parts.length ? " " : ""}${cmdText}`,
      });
      return parts;
    }
    case "get_terminal_output":
      return [
        {
          type: "text",
          text: p.terminal_id
            ? `terminal ${String(p.terminal_id).slice(0, 8)}`
            : "terminal",
        },
      ];
    case "get_diagnostics": {
      const path = String(p.path ?? "");
      return path ? [filePart(path)] : [{ type: "text", text: "workspace" }];
    }
    case "get_symbols":
    case "get_hover":
    case "get_references":
    case "get_completions":
    case "get_code_actions":
    case "go_to_definition":
    case "go_to_implementation":
    case "go_to_type_definition": {
      const path = String(p.path ?? "");
      const line = p.line ? Number(p.line) : undefined;
      return [filePart(path, line)];
    }
    case "rename_symbol": {
      const oldName = String(p.old_name ?? p.symbol ?? "");
      const newName = String(p.new_name ?? "");
      if (oldName && newName)
        return [{ type: "text", text: `${oldName} → ${newName}` }];
      return [filePart(String(p.path ?? ""))];
    }
    case "open_file":
      return [
        filePart(String(p.path ?? ""), p.line ? Number(p.line) : undefined),
      ];
    case "show_notification":
      return [{ type: "text", text: String(p.message ?? "").slice(0, 50) }];
    case "todo_write":
      return [{ type: "text", text: result || "updated" }];
    default: {
      const inputSummary = getGenericInputSummary(input);
      if (inputSummary.length > 0) return inputSummary;
      const t =
        displayResult.length > 60
          ? displayResult.slice(0, 57) + "..."
          : displayResult || "";
      return [{ type: "text", text: t }];
    }
  }
}

/** Create a file link summary part. */
function filePart(path: string, line?: number): SummaryPart {
  if (!path) return { type: "text", text: "" };
  return {
    type: "file",
    display: formatToolFileDisplayPath(path) + (line ? `:${line}` : ""),
    path,
    line,
  };
}

/** Summary while tool input is still streaming. */
function getStreamingSummary(
  name: string,
  input: Record<string, unknown> | null,
): SummaryPart[] {
  if (!input) return [];
  const path = input.path ? String(input.path) : "";
  switch (name) {
    case "write_file":
      return path
        ? [
            { type: "text", text: "Writing " },
            filePart(path),
            { type: "text", text: "..." },
          ]
        : [{ type: "text", text: "Writing..." }];
    case "apply_diff":
      return path
        ? [
            { type: "text", text: "Editing " },
            filePart(path),
            { type: "text", text: "..." },
          ]
        : [{ type: "text", text: "Editing..." }];
    case "execute_command":
      return [
        {
          type: "text",
          text: input.command
            ? String(input.command).slice(0, 50) + "..."
            : "Running...",
        },
      ];
    default:
      return getGenericInputSummary(input);
  }
}

export function formatToolFileDisplayPath(p: string): string {
  if (!p) return "";
  if (
    p.startsWith("/") ||
    p === "." ||
    p === ".." ||
    p.startsWith("./") ||
    p.startsWith("../") ||
    /^[A-Za-z]:[\\/]/.test(p) ||
    p.startsWith("\\\\")
  ) {
    return p;
  }

  const parts = p.split("/");
  return parts.length > 3
    ? ".../" + parts.slice(-2).join("/")
    : parts.join("/");
}

function extractField(text: string, field: string): string | null {
  // Try JSON parse first
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === "object" && field in obj) {
      const value = (obj as Record<string, unknown>)[field];
      if (value === null || value === undefined) return null;
      return String(value);
    }
  } catch {
    // Try regex fallback for partial JSON
    const re = new RegExp(`"${field}"\\s*:\\s*"?([^",}]+)`);
    const m = text.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

function isJson(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}

function formatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function getCommandApprovalBadge(
  resultPayload: Record<string, unknown> | null,
): { text: string; title: string } | null {
  const security = resultPayload?.security;
  const securityRecord =
    security && typeof security === "object"
      ? (security as Record<string, unknown>)
      : null;
  const route =
    securityRecord?.route === "sandbox"
      ? "sandbox"
      : securityRecord?.route === "native"
        ? "native"
        : null;
  const routeSuffix = route ? ` · ${route}` : "";
  const sandbox = securityRecord?.sandbox;
  const sandboxRecord =
    sandbox && typeof sandbox === "object"
      ? (sandbox as Record<string, unknown>)
      : null;
  const routeTitle =
    route === "sandbox"
      ? ` · Verified sandbox${typeof sandboxRecord?.profileId === "string" ? ` (${sandboxRecord.profileId})` : ""}${typeof sandboxRecord?.attestationVersion === "string" ? ` · ${sandboxRecord.attestationVersion}` : ""}`
      : route === "native"
        ? ` · Native terminal (unsandboxed)${typeof securityRecord?.routeReason === "string" ? ` · ${securityRecord.routeReason}` : ""}`
        : "";
  const reviewerTitle =
    securityRecord?.approvalReviewerSnapshot === "auto-review"
      ? " · Auto reviewer"
      : securityRecord?.approvalReviewerSnapshot === "user"
        ? " · Human reviewer"
        : "";
  const presetTitle =
    securityRecord?.executionPresetSnapshot === "workspace-write"
      ? " · Workspace-write preset"
      : securityRecord?.executionPresetSnapshot === "native-manual"
        ? " · Native manual preset"
        : "";
  const securityTitle = `${routeTitle}${reviewerTitle}${presetTitle}`;
  const approval = resultPayload?.approval;
  if (approval && typeof approval === "object" && "by" in approval) {
    const record = approval as Record<string, unknown>;
    switch (record.by) {
      case "master_bypass":
        return {
          text: `approved · bypass${routeSuffix}`,
          title: `Approved by masterBypass${securityTitle}`,
        };
      case "explicit_rule":
        return {
          text: `approved · rule${routeSuffix}`,
          title: `Approved by command rule${securityTitle}`,
        };
      case "recent_approval":
        return {
          text: `approved · recent${routeSuffix}`,
          title: `Approved by recent single-use approval TTL${securityTitle}`,
        };
      case "tier":
        return typeof record.tier === "string"
          ? {
              text: `auto · ${record.tier}${routeSuffix}`,
              title: `Auto-approved by command safety tier${securityTitle}`,
            }
          : null;
      case "model_reviewer": {
        const model = typeof record.model === "string" ? record.model : "model";
        const reason = typeof record.reason === "string" ? record.reason : "";
        const confidence =
          typeof record.confidence === "string" ? record.confidence : "";
        const risk = typeof record.risk === "string" ? record.risk : "";
        const assessment =
          confidence && risk
            ? ` · ${confidence} confidence · ${risk} risk`
            : "";
        return {
          text: `approved · reviewer${routeSuffix}`,
          title: `Approved by one-shot reviewer (${model})${assessment}${reason ? `: ${reason}` : ""}${securityTitle}`,
        };
      }
      case "human":
        return {
          text: `approved · human${routeSuffix}`,
          title: `Approved manually${securityTitle}`,
        };
      case "human_edited":
        return {
          text: `approved · edited${routeSuffix}`,
          title: `Approved manually after editing the command${securityTitle}`,
        };
      default:
        return null;
    }
  }

  const autoApproved = resultPayload?.auto_approved;
  if (
    autoApproved &&
    typeof autoApproved === "object" &&
    "by" in autoApproved &&
    (autoApproved as Record<string, unknown>).by === "tier" &&
    typeof (autoApproved as Record<string, unknown>).tier === "string"
  ) {
    return {
      text: `auto · ${String((autoApproved as Record<string, unknown>).tier)}${routeSuffix}`,
      title: `Auto-approved by command safety tier${securityTitle}`,
    };
  }
  return null;
}

function parseResultObject(result: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(result);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore parse errors — many tools return plain text.
  }
  return null;
}

function getResultStatus(
  payload: Record<string, unknown> | null,
): string | null {
  if (!payload) return null;
  const status = payload.status;
  return typeof status === "string" ? status.toLowerCase() : null;
}

function hasToolError(payload: Record<string, unknown> | null): boolean {
  if (!payload) return false;
  if (typeof payload.error === "string" && payload.error.trim()) return true;
  const status = getResultStatus(payload);
  return status === "error" || status === "failed";
}

function hasToolWarning(payload: Record<string, unknown> | null): boolean {
  if (!payload) return false;
  if (payload.partial === true) return true;

  const failedBlocks = payload.failed_blocks;
  if (Array.isArray(failedBlocks) && failedBlocks.length > 0) return true;

  const malformedBlocks = payload.malformed_blocks;
  if (typeof malformedBlocks === "number" && malformedBlocks > 0) return true;

  const status = getResultStatus(payload);
  return (
    status === "cancelled" ||
    status === "rejected" ||
    status === "rejected_by_user" ||
    status === "timed_out" ||
    status === "force-completed" ||
    status === "stopped"
  );
}

export interface ToolCallVisualState {
  statusClass: "tool-running" | "tool-success" | "tool-warning" | "tool-error";
  statusIconClass:
    | "codicon-loading codicon-modifier-spin"
    | "codicon-check"
    | "codicon-warning"
    | "codicon-error";
  cmdExitBadge: string | null;
}

export function getToolCallVisualState(toolCall: {
  name: string;
  complete: boolean;
  result: string;
}): ToolCallVisualState {
  const { complete, name, result } = toolCall;
  const resultPayload = complete ? parseResultObject(result) : null;
  const rawExitCode =
    name === "execute_command" && complete
      ? extractField(result, "exit_code")
      : null;
  const cmdExitBadge =
    rawExitCode !== null && rawExitCode !== "0" ? rawExitCode : null;

  const isError = complete && hasToolError(resultPayload);
  const isWarning =
    complete &&
    !isError &&
    (cmdExitBadge !== null || hasToolWarning(resultPayload));

  const statusClass = !complete
    ? "tool-running"
    : isError
      ? "tool-error"
      : isWarning
        ? "tool-warning"
        : "tool-success";

  const statusIconClass = !complete
    ? "codicon-loading codicon-modifier-spin"
    : isError
      ? "codicon-error"
      : isWarning
        ? "codicon-warning"
        : "codicon-check";

  return { statusClass, statusIconClass, cmdExitBadge };
}

export function ToolCallBlock({
  toolCall,
  onOpenFile,
  onRevealToolCallTerminal,
  onContinueToolCallInBackground,
  onCompleteToolCall,
  onCancelToolCall,
  onPromoteMcpToolApproval,
}: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [promotedScopes, setPromotedScopes] = useState<
    Set<"session" | "project" | "global">
  >(new Set());

  const complete = toolCall.complete;
  const input = useMemo(
    () => tryParseJson(toolCall.inputJson),
    [toolCall.inputJson],
  );
  const summaryParts = useMemo(
    () => getToolSummary(toolCall.name, input, toolCall.result, complete),
    [toolCall.name, input, toolCall.result, complete],
  );

  const { statusClass, statusIconClass, cmdExitBadge } = useMemo(
    () => getToolCallVisualState(toolCall),
    [toolCall],
  );

  const handleFileClick = useCallback(
    (e: MouseEvent, path: string, line?: number) => {
      e.stopPropagation();
      onOpenFile?.(path, line);
    },
    [onOpenFile],
  );

  // Format input JSON for the expanded view — only rendered (and only worth
  // computing) when expanded.
  const formattedInput = useMemo(() => {
    if (!expanded) return toolCall.inputJson;
    return input ? JSON.stringify(input, null, 2) : toolCall.inputJson;
  }, [expanded, input, toolCall.inputJson]);

  const hasSummary = summaryParts.some(
    (p) =>
      p.type === "file" || p.type === "badge" || (p.type === "text" && p.text),
  );
  const mcpApprovalPromotion = toolCall.mcpApprovalPromotion;
  const composeTrace = toolCall.composeTrace;
  const availablePromotionScopes =
    mcpApprovalPromotion?.scopes.filter(
      (scope) => !promotedScopes.has(scope),
    ) ?? [];
  const canContinueInBackground =
    toolCall.name === "execute_command" ||
    toolCall.name === "get_background_result";
  const showRunningActions =
    !complete &&
    (onContinueToolCallInBackground || onCompleteToolCall || onCancelToolCall);
  const resultImages =
    complete && toolCall.resultImages ? toolCall.resultImages : [];
  const resultDocuments =
    complete && toolCall.resultDocuments ? toolCall.resultDocuments : [];
  const resultMediaCount = resultImages.length + resultDocuments.length;
  const displayedResult =
    resultMediaCount > 0
      ? stripMediaPlaceholderLines(toolCall.result)
      : toolCall.result;
  const revealsRunningTerminal =
    !complete &&
    toolCall.name === "execute_command" &&
    !!onRevealToolCallTerminal;

  return (
    <div class={`tool-call-block ${statusClass}`}>
      <div
        class={`tool-call-row${showRunningActions ? " tool-call-row-with-actions" : ""}`}
      >
        <button
          class="tool-call-header"
          onClick={() => {
            if (revealsRunningTerminal) {
              onRevealToolCallTerminal(toolCall.id);
              return;
            }
            setExpanded(!expanded);
          }}
          title={
            revealsRunningTerminal ? "Show the running terminal" : undefined
          }
          type="button"
        >
          <i
            class={`codicon codicon-chevron-${expanded ? "down" : "right"} tool-call-chevron`}
          />
          <i class={`codicon tool-call-status-icon ${statusIconClass}`} />
          <span class="tool-call-name">{toolCall.name}</span>
          {cmdExitBadge !== null && (
            <span class="tool-exit-badge">exit {cmdExitBadge}</span>
          )}
          {hasSummary && (
            <span class="tool-call-summary">
              {summaryParts
                .filter(
                  (p) => !(p.type === "text" && p.text.startsWith("\x00exit:")),
                )
                .map((part, i) =>
                  part.type === "file" ? (
                    <a
                      key={i}
                      class="tool-file-link"
                      title={part.path + (part.line ? `:${part.line}` : "")}
                      onClick={(e: MouseEvent) =>
                        handleFileClick(e, part.path, part.line)
                      }
                    >
                      {part.display}
                    </a>
                  ) : part.type === "badge" ? (
                    <span
                      key={i}
                      class="tool-auto-approval-badge"
                      title={part.title}
                    >
                      {part.text}
                    </span>
                  ) : (
                    <span key={i}>{part.text}</span>
                  ),
                )}
            </span>
          )}
          {resultMediaCount > 0 && (
            <span
              class="tool-image-badge"
              role="img"
              aria-label={formatResultMediaLabel(
                resultImages.length,
                resultDocuments.length,
              )}
              title={`${formatResultMediaLabel(resultImages.length, resultDocuments.length)} — expand to view`}
            >
              <i class="codicon codicon-file-media" aria-hidden="true" />
              {resultMediaCount > 1 && resultMediaCount}
            </span>
          )}
          {complete && toolCall.durationMs != null && (
            <span class="tool-call-duration">
              {fmtDuration(toolCall.durationMs)}
            </span>
          )}
        </button>
        {showRunningActions && (
          <div
            class="tool-call-inline-actions"
            aria-label={`Actions for ${toolCall.name}`}
          >
            {canContinueInBackground && onContinueToolCallInBackground && (
              <button
                type="button"
                class="tool-call-inline-action"
                aria-label={`Continue ${toolCall.name} in background`}
                title={
                  toolCall.name === "get_background_result"
                    ? "Return control to the agent while the background agent keeps running"
                    : "Return control to the agent while the command keeps running"
                }
                onClick={() => onContinueToolCallInBackground(toolCall.id)}
              >
                <i class="codicon codicon-debug-continue" aria-hidden="true" />
              </button>
            )}
            {onCompleteToolCall && (
              <button
                type="button"
                class="tool-call-inline-action tool-call-inline-complete"
                aria-label={`Complete ${toolCall.name}`}
                title={`Complete ${toolCall.name}`}
                onClick={() => onCompleteToolCall(toolCall.id)}
              >
                <i class="codicon codicon-check" aria-hidden="true" />
              </button>
            )}
            {onCancelToolCall && (
              <button
                type="button"
                class="tool-call-inline-action tool-call-inline-cancel"
                aria-label={`Cancel ${toolCall.name}`}
                title={`Cancel ${toolCall.name}`}
                onClick={() => onCancelToolCall(toolCall.id)}
              >
                <i class="codicon codicon-close" aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </div>

      {expanded && (
        <div class="tool-call-details">
          <InlineDiff toolName={toolCall.name} input={input} />
          {formattedInput && (
            <div class="tool-call-section">
              <div class="tool-call-section-label">Input</div>
              <JsonHighlight
                json={formattedInput}
                renderTokenText={(token) => (
                  <FilePathLinkedText
                    text={token.text}
                    onOpenFile={onOpenFile}
                  />
                )}
              />
            </div>
          )}
          {composeTrace && (
            <div class="tool-call-section compose-trace">
              <div class="tool-call-section-label">
                Child tools ({composeTrace.completedChildren}/
                {composeTrace.totalChildren})
              </div>
              {composeTrace.description && (
                <div class="compose-trace-description">
                  {composeTrace.description}
                </div>
              )}
              <div class="compose-trace-children">
                {composeTrace.children.map((child) => (
                  <div class="compose-trace-child" key={child.id}>
                    <i
                      class={`codicon ${
                        child.status === "running"
                          ? "codicon-loading codicon-modifier-spin"
                          : child.status === "completed"
                            ? "codicon-pass-filled"
                            : child.status === "cancelled"
                              ? "codicon-circle-slash"
                              : "codicon-error"
                      }`}
                    />
                    <span class="compose-trace-child-name">{child.name}</span>
                    {child.inputSummary && (
                      <span class="compose-trace-child-input">
                        {child.inputSummary}
                      </span>
                    )}
                    {child.durationMs != null && (
                      <span class="compose-trace-child-duration">
                        {fmtDuration(child.durationMs)}
                      </span>
                    )}
                    {child.errorSummary && (
                      <span class="compose-trace-child-error">
                        {child.errorSummary}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {(displayedResult || resultMediaCount > 0) && (
            <div class="tool-call-section">
              <div class="tool-call-section-label">Result</div>
              {displayedResult &&
                (isJson(displayedResult) ? (
                  <JsonHighlight
                    json={formatJson(displayedResult)}
                    renderTokenText={(token) => (
                      <FilePathLinkedText
                        text={token.text}
                        onOpenFile={onOpenFile}
                      />
                    )}
                  />
                ) : (
                  <pre class="tool-call-code">
                    <FilePathLinkedText
                      text={displayedResult}
                      onOpenFile={onOpenFile}
                    />
                  </pre>
                ))}
              {resultImages.length > 0 && (
                <div class="tool-result-image-previews">
                  {resultImages.map((image, index) => (
                    <img
                      key={`${image.mimeType}-${index}`}
                      class="tool-result-image-preview"
                      src={`data:${image.mimeType};base64,${image.data}`}
                      alt={`${toolCall.name} result image ${index + 1}`}
                      loading="lazy"
                    />
                  ))}
                </div>
              )}
              {resultDocuments.length > 0 && (
                <div class="tool-result-documents">
                  {resultDocuments.map((document, index) => (
                    <div
                      class="tool-result-document"
                      key={`${document.name}-${document.mimeType}-${index}`}
                      title={document.mimeType}
                    >
                      <i class="codicon codicon-file-pdf" aria-hidden="true" />
                      <span>{document.name}</span>
                      <code>{document.mimeType}</code>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {complete &&
            mcpApprovalPromotion &&
            onPromoteMcpToolApproval &&
            availablePromotionScopes.length > 0 && (
              <div class="tool-call-section">
                <div class="tool-call-section-label">Permissions</div>
                <div class="tool-call-permission-card">
                  <div class="tool-call-permission-copy">
                    <i
                      class="codicon codicon-shield tool-call-permission-icon"
                      aria-hidden="true"
                    />
                    <div>
                      <div class="tool-call-permission-title">
                        Remember this approval
                      </div>
                      <div class="tool-call-permission-hint">
                        Skip future prompts for this MCP tool in:
                      </div>
                    </div>
                  </div>
                  <div
                    class="tool-call-permission-actions"
                    role="group"
                    aria-label="Remember MCP tool approval"
                  >
                    {availablePromotionScopes.map((scope) => {
                      const presentation =
                        MCP_APPROVAL_SCOPE_PRESENTATION[scope];
                      return (
                        <button
                          key={scope}
                          type="button"
                          class="tool-call-permission-button"
                          title={presentation.title}
                          aria-label={presentation.title}
                          onClick={(e: MouseEvent) => {
                            e.stopPropagation();
                            onPromoteMcpToolApproval({
                              serverName: mcpApprovalPromotion.serverName,
                              bareToolName: mcpApprovalPromotion.bareToolName,
                              scope,
                            });
                            setPromotedScopes((prev) =>
                              new Set(prev).add(scope),
                            );
                          }}
                        >
                          <i
                            class={`codicon ${presentation.icon}`}
                            aria-hidden="true"
                          />
                          {presentation.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
        </div>
      )}
    </div>
  );
}
