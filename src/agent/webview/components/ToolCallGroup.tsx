import { useMemo, useState } from "preact/hooks";

import type { ContentBlock } from "../types";
import { normalizeProjectedToolName } from "../../../shared/chatProjection";
import {
  ToolCallBlock,
  fmtDuration,
  getToolCallVisualState,
  type ToolCallData,
} from "./ToolCallBlock";

type ToolBlock = ToolCallData;

export type BlockSegment =
  | { kind: "tool_group"; blocks: ToolBlock[] }
  | { kind: "single"; block: ContentBlock; index: number };

interface ToolCallGroupProps {
  blocks: ToolBlock[];
  onOpenFile?: (path: string, line?: number) => void;
  onCompleteToolCall?: (id: string) => void;
  onCancelToolCall?: (id: string) => void;
  onPromoteMcpToolApproval?: (promotion: {
    serverName: string;
    bareToolName: string;
    scope: "session" | "project" | "global";
  }) => void;
}

type ToolCategory =
  | "files"
  | "searches"
  | "lists"
  | "symbols"
  | "commands"
  | "edits"
  | "other";

const CATEGORY_BY_TOOL = new Map<string, ToolCategory>([
  ["read_file", "files"],
  ["get_context", "files"],
  ["open_file", "files"],
  ["search_files", "searches"],
  ["codebase_search", "searches"],
  ["list_files", "lists"],
  ["get_symbols", "symbols"],
  ["get_hover", "symbols"],
  ["get_references", "symbols"],
  ["get_code_actions", "symbols"],
  ["go_to_definition", "symbols"],
  ["go_to_implementation", "symbols"],
  ["go_to_type_definition", "symbols"],
  ["get_call_hierarchy", "symbols"],
  ["get_type_hierarchy", "symbols"],
  ["get_completions", "symbols"],
  ["get_inlay_hints", "symbols"],
  ["get_module_neighbors", "symbols"],
  ["get_repo_map", "symbols"],
  ["get_diagnostics", "symbols"],
  ["execute_command", "commands"],
  ["get_terminal_output", "commands"],
  ["write_file", "edits"],
  ["apply_diff", "edits"],
  ["find_and_replace", "edits"],
  ["rename_symbol", "edits"],
]);

const EXPLORATION_CATEGORIES: ToolCategory[] = [
  "files",
  "searches",
  "lists",
  "symbols",
];

export function segmentBlocks(
  blocks: ContentBlock[],
  opts?: {
    groupCompletedTools?: boolean;
    shouldGroupToolCall?: (block: ToolBlock) => boolean;
  },
): BlockSegment[] {
  const segments: BlockSegment[] = [];
  let pendingTools: ToolBlock[] = [];

  const flushTools = () => {
    if (pendingTools.length > 0) {
      segments.push({ kind: "tool_group", blocks: pendingTools });
    }
    pendingTools = [];
  };

  const groupCompletedTools = opts?.groupCompletedTools ?? true;

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (
      groupCompletedTools &&
      isGroupableToolCall(block) &&
      (opts?.shouldGroupToolCall?.(block) ?? true)
    ) {
      pendingTools.push(block);
      continue;
    }

    flushTools();
    segments.push({ kind: "single", block, index });
  }

  flushTools();
  return segments;
}

function isGroupableToolCall(block: ContentBlock): block is ToolBlock {
  return (
    block.type === "tool_call" &&
    block.complete &&
    !block.mcpApprovalPromotion &&
    getToolCallVisualState(block).statusClass === "tool-success"
  );
}

export function getToolGroupLabel(blocks: ToolBlock[]): string {
  const counts = countCategories(blocks);
  const explored = EXPLORATION_CATEGORIES.map((category) =>
    formatCategoryCount(category, counts[category]),
  ).filter(isPresent);
  const actions = [
    formatCategoryCount("edits", counts.edits),
    formatCategoryCount("commands", counts.commands),
    formatCategoryCount("other", counts.other),
  ].filter(isPresent);

  const parts: string[] = [];
  if (explored.length > 0) {
    parts.push(`Explored ${explored.join(", ")}`);
  }
  parts.push(...actions.map((action) => capitalize(action)));

  return parts.join(" · ");
}

export function getToolGroupStatus(blocks: ToolBlock[]): {
  statusClass: "tool-success" | "tool-warning" | "tool-error";
  statusIconClass: "codicon-check" | "codicon-warning" | "codicon-error";
  errorCount: number;
  warningCount: number;
} {
  let errorCount = 0;
  let warningCount = 0;

  for (const block of blocks) {
    const state = getToolCallVisualState(block);
    if (state.statusClass === "tool-error") errorCount += 1;
    if (state.statusClass === "tool-warning") warningCount += 1;
  }

  if (errorCount > 0) {
    return {
      statusClass: "tool-error",
      statusIconClass: "codicon-error",
      errorCount,
      warningCount,
    };
  }

  if (warningCount > 0) {
    return {
      statusClass: "tool-warning",
      statusIconClass: "codicon-warning",
      errorCount,
      warningCount,
    };
  }

  return {
    statusClass: "tool-success",
    statusIconClass: "codicon-check",
    errorCount,
    warningCount,
  };
}

export function ToolCallGroup({
  blocks,
  onOpenFile,
  onCompleteToolCall,
  onCancelToolCall,
  onPromoteMcpToolApproval,
}: ToolCallGroupProps) {
  const hasMcpPromotion = blocks.some((block) => block.mcpApprovalPromotion);
  const [expanded, setExpanded] = useState(hasMcpPromotion);
  const label = useMemo(() => getToolGroupLabel(blocks), [blocks]);
  const totalDuration = blocks.reduce(
    (sum, block) => sum + (block.durationMs ?? 0),
    0,
  );
  const status = useMemo(() => getToolGroupStatus(blocks), [blocks]);
  const statusBadge =
    status.errorCount > 0
      ? `${status.errorCount} failed`
      : status.warningCount > 0
        ? `${status.warningCount} warning${status.warningCount === 1 ? "" : "s"}`
        : null;
  const accessibleLabel = ["Tools", label, statusBadge]
    .filter(Boolean)
    .join(" ");

  return (
    <div class={`tool-group-block ${status.statusClass}`}>
      <button
        class="tool-call-header tool-group-header"
        type="button"
        aria-expanded={expanded}
        aria-label={accessibleLabel}
        onClick={() => setExpanded(!expanded)}
      >
        <i
          class={`codicon codicon-chevron-${expanded ? "down" : "right"} tool-call-chevron`}
        />
        <i class={`codicon tool-call-status-icon ${status.statusIconClass}`} />
        <span class="tool-call-name tool-group-name">Tools</span>
        <span class="tool-call-summary tool-group-summary">{label}</span>
        {statusBadge && <span class="tool-exit-badge">{statusBadge}</span>}
        {totalDuration > 0 && (
          <span class="tool-call-duration">{fmtDuration(totalDuration)}</span>
        )}
      </button>
      {expanded && (
        <div class="tool-group-children">
          {blocks.map((block) => (
            <ToolCallBlock
              key={block.id}
              toolCall={block}
              onOpenFile={onOpenFile}
              onCompleteToolCall={onCompleteToolCall}
              onCancelToolCall={onCancelToolCall}
              onPromoteMcpToolApproval={onPromoteMcpToolApproval}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function countCategories(blocks: ToolBlock[]): Record<ToolCategory, number> {
  return blocks.reduce<Record<ToolCategory, number>>(
    (counts, block) => {
      counts[getToolCategory(block.name)] += 1;
      return counts;
    },
    {
      files: 0,
      searches: 0,
      lists: 0,
      symbols: 0,
      commands: 0,
      edits: 0,
      other: 0,
    },
  );
}

function getToolCategory(name: string): ToolCategory {
  return CATEGORY_BY_TOOL.get(normalizeProjectedToolName(name)) ?? "other";
}

function formatCategoryCount(
  category: ToolCategory,
  count: number,
): string | null {
  if (count === 0) return null;

  switch (category) {
    case "files":
      return `${count} file${count === 1 ? "" : "s"}`;
    case "searches":
      return `${count} search${count === 1 ? "" : "es"}`;
    case "lists":
      return `${count} list${count === 1 ? "" : "s"}`;
    case "symbols":
      return `${count} symbol lookup${count === 1 ? "" : "s"}`;
    case "commands":
      return `ran ${count} command${count === 1 ? "" : "s"}`;
    case "edits":
      return `edited ${count} file${count === 1 ? "" : "s"}`;
    case "other":
      return `${count} other call${count === 1 ? "" : "s"}`;
  }
}

function isPresent(value: string | null): value is string {
  return value !== null;
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}
