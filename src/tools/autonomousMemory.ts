import type {
  ManageMemoryToolInput,
  MemoryToolExecutionContext,
  RecallMemoryToolInput,
} from "@agentlink/protocol/autonomous-memory";
import { errorResult, jsonResult } from "@agentlink/protocol/tool-result";

import type { MemoryToolProvider } from "../core/capabilities/memory.js";
import type { ToolResult } from "@agentlink/protocol/tool-result";

export async function handleManageMemory(
  input: ManageMemoryToolInput,
  context: MemoryToolExecutionContext,
  provider?: MemoryToolProvider,
): Promise<ToolResult> {
  if (!provider) return errorResult("Autonomous memory is unavailable.");
  try {
    return jsonResult(await provider.manage({ input, context }), true);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

export async function handleRecallMemory(
  input: RecallMemoryToolInput,
  context: MemoryToolExecutionContext,
  provider?: MemoryToolProvider,
): Promise<ToolResult> {
  if (!provider) return errorResult("Autonomous memory is unavailable.");
  try {
    return jsonResult(await provider.recall({ input, context }), true);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}
