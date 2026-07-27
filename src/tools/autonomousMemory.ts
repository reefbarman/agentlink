import type {
  ManageMemoryToolInput,
  MemoryToolExecutionContext,
  MemoryToolProvider,
  RecallMemoryToolInput,
} from "../core/capabilities/memory.js";
import { errorResult, jsonResult } from "../shared/types.js";

import type { ToolResult } from "../shared/types.js";

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
