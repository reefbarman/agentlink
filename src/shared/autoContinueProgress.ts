interface ChatMessageLike {
  id: string;
  role: string;
  blocks?: readonly ChatMessageBlockLike[];
}

interface ChatMessageBlockLike {
  type: string;
  name?: string;
}

const PROGRESS_TOOL_NAMES = new Set([
  "apply_code_action",
  "apply_diff",
  "call_mcp_tool",
  "execute_command",
  "find_and_replace",
  "generate_image",
  "propose_memory",
  "rename_symbol",
  "spawn_background_agent",
  "start_worktree_agent",
  "todo_write",
  "write_file",
]);

export const AUTO_CONTINUE_NO_PROGRESS_REASON =
  "Auto Continue stopped: the last turn completed without making further changes.";

export function isProgressToolName(name: string): boolean {
  return (
    PROGRESS_TOOL_NAMES.has(name) || /^[a-z0-9_-]+__[a-z0-9_-]+$/i.test(name)
  );
}

export function turnMadeProgress(
  messages: readonly ChatMessageLike[],
  sinceMessageId: string,
): boolean {
  const sinceIndex = messages.findIndex(
    (message) => message.id === sinceMessageId,
  );
  if (sinceIndex < 0) return true;

  for (const message of messages.slice(sinceIndex + 1)) {
    if (message.role !== "assistant") continue;
    for (const block of message.blocks ?? []) {
      if (block.type === "bg_agent") return true;
      if (block.type !== "tool_call" || !block.name) continue;
      if (isProgressToolName(block.name)) return true;
    }
  }

  return false;
}
