export interface CondenseResumeAnchor {
  latestUserMessage: string;
  currentTask: string;
}

interface CondensePromptContext {
  userMessages: string[];
  pendingTasks: string[];
  resumeAnchor: CondenseResumeAnchor;
}

export interface DeterministicCondenseSectionsOptions extends CondensePromptContext {
  preservedContext?: {
    toolNames: string[];
    mcpServerNames?: string[];
    activeSkills?: string[];
  };
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
    "## Preserved Runtime Context (reattached outside transcript)",
    "### Available tool names",
    toolLines,
    "",
    "### MCP servers with exposed tools",
    serverLines,
    "",
    "### Active loaded skills",
    skillLines,
    "</system-reminder>",
  ].join("\n");
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

  return [
    "1. **Primary Request and Intent**: Continue the active work captured in the latest user message and pending task anchor.",
    "2. **Key Technical Concepts**: Unknown from transcript.",
    "3. **Files and Code Sections**: Unknown from transcript.",
    "4. **Errors and Fixes**: Unknown from transcript.",
    "5. **Problem Solving**: Use the deterministic resume anchor and canonical user messages below as the source of truth.",
    `6. **All User Messages**:\n${allUserMessages}`,
    "7. **User Corrections & Behavioral Directives**: Unknown from transcript.",
    `8. **Pending Tasks**:\n${pendingTasks}`,
    `9. **Current Work**: Continue from this task: "${options.resumeAnchor.currentTask}". Latest user message: "${options.resumeAnchor.latestUserMessage}".`,
    `10. **Optional Next Step**: Resume work on "${options.resumeAnchor.currentTask}".`,
  ].join("\n\n");
}
