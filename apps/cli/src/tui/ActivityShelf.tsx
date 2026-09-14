import { Box, Text } from "ink";

import React from "react";
import type { StandaloneSessionProjection } from "../sessionProjection.js";
import { sanitizeTerminalText } from "./terminalText.js";

const BRAND = "#4EC9B0";

export interface ActivityShelfItem {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
  readonly details: readonly string[];
  readonly attention?: boolean;
}

export function ActivityShelf({
  projection,
  selectedIndex,
  expandedIds,
  focused,
  height,
}: {
  readonly projection: StandaloneSessionProjection;
  readonly selectedIndex: number;
  readonly expandedIds: readonly string[];
  readonly focused: boolean;
  readonly height: number;
}): React.JSX.Element | null {
  const items = buildActivityShelfItems(projection);
  if (items.length === 0 || height <= 0) return null;
  const selected = Math.min(Math.max(0, selectedIndex), items.length - 1);
  const bodyRows = Math.max(1, height - 3);
  const expanded = new Set(expandedIds);
  const selectedItem = items[selected];
  const detailRows =
    selectedItem && expanded.has(selectedItem.id)
      ? Math.min(selectedItem.details.length, Math.max(0, bodyRows))
      : 0;
  const visible = visibleActivityShelfItems(
    items,
    selected,
    Math.max(1, bodyRows - detailRows),
  );

  return (
    <Box
      borderStyle="round"
      borderColor={focused ? BRAND : "gray"}
      flexDirection="column"
      height={height}
      overflow="hidden"
      paddingX={1}
    >
      <Box flexShrink={0}>
        <Text bold inverse={focused}>
          Activity{focused ? " (focused)" : ""} · {items.length} live ·
          Enter/Space expand · Ctrl+T TODOs
        </Text>
      </Box>
      {visible.map(({ item, index }) => (
        <Box key={item.id} flexDirection="column" flexShrink={0}>
          <Text color={item.attention ? "yellow" : undefined}>
            {index === selected ? "›" : " "} {expanded.has(item.id) ? "▾" : "▸"}{" "}
            {sanitizeTerminalText(item.label)} ·{" "}
            {sanitizeTerminalText(item.summary)}
          </Text>
          {expanded.has(item.id) && index === selected
            ? boundedDetails(item.details, detailRows).map(
                (detail, detailIndex) => (
                  <Text
                    key={`${item.id}:${detailIndex}`}
                    dimColor
                    wrap="truncate-end"
                  >
                    {"    "}
                    {sanitizeTerminalText(detail)}
                  </Text>
                ),
              )
            : null}
        </Box>
      ))}
    </Box>
  );
}

export function buildActivityShelfItems(
  projection: StandaloneSessionProjection,
): readonly ActivityShelfItem[] {
  const usage = projection.usage;
  const execution = projection.execution;
  const activeTools = projection.tools.filter(
    (tool) => tool.status === "requested" || tool.status === "running",
  );
  const failedTools = projection.tools.filter(
    (tool) => tool.status === "failed",
  );
  const runningCommands = projection.commands.filter(
    (command) => command.state === "running",
  );
  const noteworthyCommands = projection.commands.filter((command) =>
    ["running", "failed", "interrupted"].includes(command.state),
  );
  const foregroundApproval = projection.pendingInteraction;
  const approvalCount =
    (foregroundApproval ? 1 : 0) + projection.backgroundApprovals.length;
  const activeAgents = projection.backgroundAgents.filter((agent) =>
    ["queued", "running", "awaiting_approval"].includes(agent.lifecycle),
  );
  const currentTodo = findCurrentTodo(projection.todos);
  const items: ActivityShelfItem[] = [];

  if (usage) {
    items.push({
      id: "context",
      label: "Context",
      summary: `${formatCount(usage.inputTokens)} in · ${formatCount(usage.outputTokens)} out`,
      details: [
        `Input ${formatCount(usage.inputTokens)} · output ${formatCount(usage.outputTokens)} · cache ${formatCount(usage.cacheReadTokens ?? 0)}`,
        usage.estimated
          ? "Provider usage is locally estimated"
          : "Provider usage reported",
      ],
    });
  }

  if (
    projection.phase === "running" ||
    projection.phase === "cancelling" ||
    projection.phase === "failed" ||
    activeTools.length > 0 ||
    failedTools.length > 0
  ) {
    items.push({
      id: "work",
      label: "Active work",
      summary: `${projection.phase} · ${activeTools.length} active tools`,
      details: [
        execution
          ? `${execution.modelCalls} model calls · ${execution.toolCalls} tool calls · ${formatDuration(execution.elapsedMs)}`
          : "Execution accounting not available yet",
        ...projection.tools
          .slice(-4)
          .map(
            (tool) =>
              `${tool.status} ${tool.toolName}${tool.error ? `: ${tool.error}` : formatDisplayInput(tool.displayInput)}`,
          ),
      ],
      attention: failedTools.length > 0 || projection.phase === "failed",
    });
  }

  if (currentTodo) {
    items.push({
      id: "tasks",
      label: "TODO",
      summary: `${currentTodo.status === "in_progress" ? "●" : "○"} ${currentTodo.status === "in_progress" ? currentTodo.activeForm : currentTodo.content}`,
      details: flattenTodos(projection.todos),
    });
  }

  if (projection.queuedMessages.length > 0) {
    items.push({
      id: "queue",
      label: "Queue",
      summary: `${projection.queuedMessages.length} queued messages`,
      details: projection.queuedMessages.map(
        (message, index) => `${index + 1}. ${message}`,
      ),
    });
  }

  if (noteworthyCommands.length > 0) {
    items.push({
      id: "commands",
      label: "Commands",
      summary: `${runningCommands.length} running · ${noteworthyCommands.length} noteworthy`,
      details: noteworthyCommands
        .slice(-5)
        .map(
          (command) =>
            `${command.state} ${command.commandId.slice(0, 10)} · ${command.command}`,
        ),
      attention: noteworthyCommands.some((command) =>
        ["failed", "interrupted"].includes(command.state),
      ),
    });
  }

  if (projection.activeQuestion) {
    items.push({
      id: "questions",
      label: "Question",
      summary: projection.activeQuestion,
      details: [projection.activeQuestion],
      attention: true,
    });
  }

  if (approvalCount > 0) {
    items.push({
      id: "approvals",
      label: "Approvals",
      summary: `${approvalCount} awaiting review`,
      details: [
        ...(foregroundApproval
          ? [
              `foreground ${foregroundApproval.toolName} · ${foregroundApproval.summary}`,
            ]
          : []),
        ...projection.backgroundApprovals.map(
          (agent) =>
            `background ${agent.childSessionId.slice(0, 10)} · ${agent.approval?.summary ?? "Approval required"}`,
        ),
      ],
      attention: true,
    });
  }

  if (activeAgents.length > 0 || projection.backgroundApprovals.length > 0) {
    items.push({
      id: "agents",
      label: "Agents",
      summary: `${activeAgents.length} active`,
      details: activeAgents
        .slice(-5)
        .map(
          (agent) =>
            `${agent.lifecycle} ${agent.childSessionId.slice(0, 10)} · ${agent.task}${agent.currentTool ? ` · ${agent.currentTool}` : ""}`,
        ),
      attention: projection.backgroundApprovals.length > 0,
    });
  }

  return items;
}

export function visibleActivityShelfItems(
  items: readonly ActivityShelfItem[],
  selectedIndex: number,
  rowLimit: number,
): readonly { readonly item: ActivityShelfItem; readonly index: number }[] {
  const count = Math.max(1, rowLimit);
  const selected = Math.min(
    Math.max(0, selectedIndex),
    Math.max(0, items.length - 1),
  );
  const start = Math.min(
    Math.max(0, selected - Math.floor(count / 2)),
    Math.max(0, items.length - count),
  );
  return items.slice(start, start + count).map((item, offset) => ({
    item,
    index: start + offset,
  }));
}

function findCurrentTodo(
  todos: StandaloneSessionProjection["todos"],
): StandaloneSessionProjection["todos"][number] | undefined {
  for (const todo of todos) {
    if (todo.status === "in_progress") return todo;
    const child = findCurrentTodo(todo.children ?? []);
    if (child) return child;
  }
  for (const todo of todos) {
    if (todo.status === "pending") return todo;
    const child = findCurrentTodo(todo.children ?? []);
    if (child) return child;
  }
  return undefined;
}

function flattenTodos(
  todos: StandaloneSessionProjection["todos"],
  depth = 0,
): readonly string[] {
  return todos.flatMap((todo) => [
    `${"  ".repeat(depth)}${todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "●" : "○"} ${todo.status === "in_progress" ? todo.activeForm : todo.content}`,
    ...flattenTodos(todo.children ?? [], depth + 1),
  ]);
}

function boundedDetails(
  details: readonly string[],
  rowLimit: number,
): readonly string[] {
  if (rowLimit <= 0) return [];
  if (details.length <= rowLimit) return details;
  if (rowLimit === 1) return [`… ${details.length} details`];
  const visible = details.slice(0, rowLimit - 1);
  return [...visible, `… ${details.length - visible.length} more`];
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact" }).format(value);
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  return `${Math.round(milliseconds / 1_000)}s`;
}

function formatDisplayInput(value: unknown): string {
  if (value === undefined) return "";
  try {
    const text = JSON.stringify(value);
    return text ? ` · ${text.slice(0, 160)}` : "";
  } catch {
    return "";
  }
}
