import { useMemo, useState } from "preact/hooks";

import type { ContentBlock } from "@agentlink/protocol/chat-transcript";
import { normalizeProjectedToolName } from "../../../shared/chatProjection";
import { getSkillLoadVisualState, SkillLoadBlock } from "./SkillLoadBlock";
import {
  ToolCallBlock,
  countResultDocuments,
  countResultImages,
  fmtDuration,
  formatResultMediaLabel,
  getToolCallVisualState,
  isInterruptedToolResult,
  type ToolCallData,
} from "./ToolCallBlock";
import type { OpenImageInEditor } from "./ImagePreview";

type SkillLoadData = Extract<ContentBlock, { type: "skill_load" }>;
type ToolBlock = ToolCallData | SkillLoadData;

export type BlockSegment =
  | { kind: "tool_group"; blocks: ToolBlock[] }
  | { kind: "single"; block: ContentBlock; index: number };

export type ActivitySegment =
  | BlockSegment
  | { kind: "activity_group"; segments: BlockSegment[] };

export function groupActivitySegments(
  segments: BlockSegment[],
): ActivitySegment[] {
  const result: ActivitySegment[] = [];
  let completed: BlockSegment[] = [];

  const flush = () => {
    const thinkingCount = completed.filter(
      (segment) =>
        segment.kind === "single" && segment.block.type === "thinking",
    ).length;
    const toolGroupCount = completed.filter(
      (segment) => segment.kind === "tool_group",
    ).length;
    if (thinkingCount >= 3 && toolGroupCount >= 3) {
      result.push({ kind: "activity_group", segments: completed });
    } else {
      result.push(...completed);
    }
    completed = [];
  };

  for (const segment of segments) {
    if (
      (segment.kind === "tool_group" &&
        getToolGroupStatus(segment.blocks).statusClass === "tool-success" &&
        !segment.blocks.some(
          (block) =>
            block.type === "tool_call" &&
            (block.resultImages?.length ||
              block.resultDocuments?.length ||
              block.mcpApprovalPromotion),
        )) ||
      (segment.kind === "single" &&
        ((segment.block.type === "thinking" && segment.block.complete) ||
          (segment.block.type === "skill_load" &&
            getSkillLoadVisualState(segment.block) === "tool-success")))
    ) {
      completed.push(segment);
    } else {
      flush();
      result.push(segment);
    }
  }
  flush();
  return result;
}

interface ToolCallGroupProps {
  blocks: ToolBlock[];
  onOpenFile?: (path: string, line?: number) => void;
  onOpenImageInEditor?: OpenImageInEditor;
  onRevealToolCallTerminal?: (id: string) => void;
  onContinueToolCallInBackground?: (id: string) => void;
  onCompleteToolCall?: (id: string) => void;
  onCancelToolCall?: (id: string) => void;
  onPromoteMcpToolApproval?: (promotion: {
    serverName: string;
    bareToolName: string;
    mutationTarget?: import("@agentlink/protocol/tool-result").McpApprovalPromotionMeta["mutationTarget"];
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
  | "skills"
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
  ["load_skill", "skills"],
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
  if (block.type === "skill_load") {
    return getSkillLoadVisualState(block) === "tool-success";
  }
  if (block.type !== "tool_call" || !block.complete) return false;
  const { statusClass } = getToolCallVisualState(block);
  // Soft warnings (non-zero exits, partial edits) are routine and stay grouped;
  // errors and interruptions (rejected, cancelled, timed out) stay visible.
  return (
    statusClass === "tool-success" ||
    (statusClass === "tool-warning" && !isInterruptedToolResult(block.result))
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
    formatCategoryCount("skills", counts.skills),
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
  nonZeroExitCount: number;
} {
  let errorCount = 0;
  let warningCount = 0;
  let nonZeroExitCount = 0;

  for (const block of blocks) {
    if (block.type === "skill_load") {
      const statusClass = getSkillLoadVisualState(block);
      if (statusClass === "tool-error") errorCount += 1;
      if (statusClass === "tool-warning") warningCount += 1;
      continue;
    }
    const state = getToolCallVisualState(block);
    if (state.statusClass === "tool-error") errorCount += 1;
    if (state.statusClass === "tool-warning") {
      warningCount += 1;
      if (state.cmdExitBadge !== null) nonZeroExitCount += 1;
    }
  }

  const counts = { errorCount, warningCount, nonZeroExitCount };

  if (errorCount > 0) {
    return {
      statusClass: "tool-error",
      statusIconClass: "codicon-error",
      ...counts,
    };
  }

  if (warningCount > 0) {
    return {
      statusClass: "tool-warning",
      statusIconClass: "codicon-warning",
      ...counts,
    };
  }

  return {
    statusClass: "tool-success",
    statusIconClass: "codicon-check",
    ...counts,
  };
}

function formatGroupStatusBadge(
  status: ReturnType<typeof getToolGroupStatus>,
): string | null {
  if (status.errorCount > 0) return `${status.errorCount} failed`;
  if (status.warningCount === 0) return null;
  if (status.nonZeroExitCount === status.warningCount) {
    return `${status.warningCount} non-zero exit${status.warningCount === 1 ? "" : "s"}`;
  }
  return `${status.warningCount} warning${status.warningCount === 1 ? "" : "s"}`;
}

export function ToolCallGroup({
  blocks,
  onOpenFile,
  onOpenImageInEditor,
  onRevealToolCallTerminal,
  onContinueToolCallInBackground,
  onCompleteToolCall,
  onCancelToolCall,
  onPromoteMcpToolApproval,
}: ToolCallGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const label = useMemo(() => getToolGroupLabel(blocks), [blocks]);
  const totalDuration = blocks.reduce(
    (sum, block) => sum + (block.durationMs ?? 0),
    0,
  );
  const status = useMemo(() => getToolGroupStatus(blocks), [blocks]);
  const statusBadge = formatGroupStatusBadge(status);
  const imageCount = blocks.reduce(
    (sum, block) =>
      sum + (block.type === "tool_call" ? countResultImages(block) : 0),
    0,
  );
  const documentCount = blocks.reduce(
    (sum, block) =>
      sum + (block.type === "tool_call" ? countResultDocuments(block) : 0),
    0,
  );
  const mediaCount = imageCount + documentCount;
  const mediaLabel =
    mediaCount > 0 ? formatResultMediaLabel(imageCount, documentCount) : null;
  const approvalOfferCount = onPromoteMcpToolApproval
    ? blocks.filter(
        (block) => block.type === "tool_call" && block.mcpApprovalPromotion,
      ).length
    : 0;
  const approvalOfferLabel =
    approvalOfferCount > 0
      ? `${approvalOfferCount} always-allow offer${approvalOfferCount === 1 ? "" : "s"}`
      : null;
  const accessibleLabel = [
    "Tools",
    label,
    statusBadge,
    mediaLabel,
    approvalOfferLabel,
  ]
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
        {mediaCount > 0 && mediaLabel && (
          <span
            class="tool-image-badge"
            role="img"
            aria-label={mediaLabel}
            title={`${mediaLabel} — expand to view`}
          >
            <i class="codicon codicon-file-media" aria-hidden="true" />
            {mediaCount > 1 && mediaCount}
          </span>
        )}
        {approvalOfferLabel && (
          <span
            class="tool-approval-offer-badge"
            role="img"
            aria-label={approvalOfferLabel}
            title={`${approvalOfferLabel}, expand to choose a scope`}
          >
            <i class="codicon codicon-shield" aria-hidden="true" />
            always allow
            {approvalOfferCount > 1 && ` ${approvalOfferCount}`}
          </span>
        )}
        {totalDuration > 0 && (
          <span class="tool-call-duration">{fmtDuration(totalDuration)}</span>
        )}
      </button>
      {expanded && (
        <div class="tool-group-children">
          {blocks.map((block) =>
            block.type === "skill_load" ? (
              <SkillLoadBlock key={block.id} block={block} />
            ) : (
              <ToolCallBlock
                key={block.id}
                toolCall={block}
                onOpenFile={onOpenFile}
                onOpenImageInEditor={onOpenImageInEditor}
                onRevealToolCallTerminal={onRevealToolCallTerminal}
                onContinueToolCallInBackground={onContinueToolCallInBackground}
                onCompleteToolCall={onCompleteToolCall}
                onCancelToolCall={onCancelToolCall}
                onPromoteMcpToolApproval={onPromoteMcpToolApproval}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function countCategories(blocks: ToolBlock[]): Record<ToolCategory, number> {
  return blocks.reduce<Record<ToolCategory, number>>(
    (counts, block) => {
      counts[
        block.type === "skill_load" ? "skills" : getToolCategory(block.name)
      ] += 1;
      return counts;
    },
    {
      files: 0,
      searches: 0,
      lists: 0,
      symbols: 0,
      commands: 0,
      edits: 0,
      skills: 0,
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
    case "skills":
      return `loaded ${count} skill${count === 1 ? "" : "s"}`;
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
