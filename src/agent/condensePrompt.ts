import type { PreservedRuntimeContext } from "./types.js";

export interface CondenseResumeAnchor {
  latestUserMessage: string;
  currentTask: string;
}

interface CondensePromptContext {
  userMessages: string[];
  pendingTasks: string[];
  resumeAnchor: CondenseResumeAnchor;
  priorSummary?: string;
}

export interface CondenseRecallAnchors {
  filePaths: string[];
  errors: string[];
  commands: string[];
  toolNames: string[];
}

export interface DeterministicCondenseSectionsOptions extends CondensePromptContext {
  recallAnchors?: CondenseRecallAnchors;
  preservedContext?: PreservedRuntimeContext;
}

function renderQuotedMessages(
  messages: string[],
  style: "ordered" | "unordered",
): string {
  if (messages.length === 0) {
    return style === "ordered" ? "1. None" : "- None";
  }

  return messages
    .map((message, index) =>
      style === "ordered" ? `${index + 1}. "${message}"` : `- "${message}"`,
    )
    .join("\n");
}

function renderBulletList(items: string[], empty: string): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : empty;
}

function renderTodoState(context?: PreservedRuntimeContext): string {
  if (!context?.todos) return "Not captured for this checkpoint.";
  const serialized = JSON.stringify(context.todos, null, 2).replace(
    /</g,
    "\\u003c",
  );
  return [
    "Treat this exact list as the authoritative task-tracking starting point. Preserve every item and completed progress, then reconcile statuses against the checkpoint summary and current workspace before continuing. Repair stale statuses with `todo_write`; do not redo completed work merely because an item still says pending or in_progress. When calling `todo_write`, include the complete list because that tool replaces all prior TODO state.",
    "<todo-state>",
    serialized,
    "</todo-state>",
  ].join("\n");
}

export function extractCondenseResumeAnchor(options: {
  userMessages: string[];
  pendingTasks: string[];
}): CondenseResumeAnchor {
  const latestUserMessage =
    options.userMessages[options.userMessages.length - 1] ??
    "Unknown from transcript";
  const currentTask =
    options.pendingTasks[options.pendingTasks.length - 1] ??
    "Unknown from transcript";
  return { latestUserMessage, currentTask };
}

export function renderDeterministicSections(
  options: DeterministicCondenseSectionsOptions,
): string {
  const userLines = renderQuotedMessages(options.userMessages, "ordered");
  const pendingLines = renderBulletList(
    options.pendingTasks,
    "- None explicitly identified",
  );
  const toolLines = renderBulletList(
    options.preservedContext?.toolNames ?? [],
    "- Unknown",
  );
  const serverLines = renderBulletList(
    options.preservedContext?.mcpServerNames ?? [],
    "- None",
  );
  const skillLines = renderBulletList(
    options.preservedContext?.activeSkills ?? [],
    "- None",
  );
  const anchorLines = renderRecallAnchors(options.recallAnchors);

  return [
    "<system-reminder>",
    "## Resume Anchor (deterministic)",
    `- Latest user message: "${options.resumeAnchor.latestUserMessage}"`,
    `- Continue from this task: "${options.resumeAnchor.currentTask}"`,
    "",
    "## Canonical User Messages (deterministic)",
    userLines,
    "",
    "## Pending Tasks (deterministic heuristic)",
    pendingLines,
    "",
    "## Session Transcript Recall",
    "The full current-session transcript, including original messages retired by condensing, is searchable with `search_session_history`. Use it to recover exact historical evidence before relying on memory or re-deriving prior work.",
    "",
    "### Retired-window recall anchors (deterministic, bounded)",
    anchorLines,
    "",
    "## Preserved Runtime Context (reattached outside transcript)",
    "### Available tool names",
    toolLines,
    "",
    "### MCP servers with exposed tools",
    serverLines,
    "",
    "### Active loaded skills",
    skillLines,
    "",
    "### Current structured TODO state (authoritative)",
    renderTodoState(options.preservedContext),
    "</system-reminder>",
  ].join("\n");
}

function renderRecallAnchors(anchors?: CondenseRecallAnchors): string {
  if (!anchors) return "- None extracted";
  const sections = [
    ["Files", anchors.filePaths],
    ["Errors", anchors.errors],
    ["Commands", anchors.commands],
    ["Tools", anchors.toolNames],
  ] as const;
  const lines = sections.flatMap(([label, items]) =>
    items.length > 0 ? [`- ${label}: ${items.join("; ")}`] : [],
  );
  return lines.length > 0 ? lines.join("\n") : "- None extracted";
}

export function buildDeterministicFallbackSummary(
  options: CondensePromptContext,
): string {
  const allUserMessages = renderQuotedMessages(
    options.userMessages,
    "unordered",
  );
  const pendingTasks = renderBulletList(
    options.pendingTasks,
    "- None explicitly identified",
  );

  const priorCheckpoint = options.priorSummary?.trim()
    ? ` Preserve and consolidate this prior checkpoint:\n${options.priorSummary.trim()}`
    : "";

  return [
    "1. **Primary Request and Intent**: Continue the active work captured in the latest user message and pending task anchor.",
    "2. **Key Technical Concepts**: Unknown from transcript.",
    "3. **Files and Code Sections**: Unknown from transcript.",
    "4. **Errors and Fixes**: Unknown from transcript.",
    `5. **Problem Solving**: Use the deterministic resume anchor and canonical user messages below as the source of truth.${priorCheckpoint}`,
    `6. **All User Messages**:\n${allUserMessages}`,
    "7. **User Corrections & Behavioral Directives**: Unknown from transcript.",
    `8. **Pending Tasks**:\n${pendingTasks}`,
    `9. **Current Work**: Continue from this task: "${options.resumeAnchor.currentTask}". Latest user message: "${options.resumeAnchor.latestUserMessage}".`,
    `10. **Optional Next Step**: Resume work on "${options.resumeAnchor.currentTask}".`,
  ].join("\n\n");
}
