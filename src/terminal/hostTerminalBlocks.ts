import type {
  HostTerminalBlock,
  HostTerminalBlockState,
  HostTerminalCommandBlock,
  HostTerminalPromptBlock,
  HostTerminalRawBlock,
} from "@agentlink/protocol/terminal-surface";
import type {
  ShellIntegrationEvent,
  ShellIntegrationParseResult,
} from "./shellIntegration.js";

import { Buffer } from "node:buffer";

export type {
  HostTerminalBlock,
  HostTerminalBlockState,
  HostTerminalCommandBlock,
  HostTerminalPromptBlock,
  HostTerminalRawBlock,
} from "@agentlink/protocol/terminal-surface";

const DEFAULT_MAX_BLOCK_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_BLOCKS = 200;

interface HostTerminalBlockOutput {
  readonly output: string;
  readonly outputBytes: number;
  readonly droppedOutputBytes: number;
}

export interface HostTerminalBlockStateOptions {
  initialCwd: string;
  maxBlockOutputBytes?: number;
  maxBlocks?: number;
}

export type HostTerminalBlockAction =
  | { type: "data"; data: string }
  | { type: "shell-event"; event: ShellIntegrationEvent };

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

export function createHostTerminalBlockState(
  options: HostTerminalBlockStateOptions,
): HostTerminalBlockState {
  const maxBlockOutputBytes =
    options.maxBlockOutputBytes ?? DEFAULT_MAX_BLOCK_OUTPUT_BYTES;
  const maxBlocks = options.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  assertPositiveSafeInteger(maxBlockOutputBytes, "maxBlockOutputBytes");
  assertPositiveSafeInteger(maxBlocks, "maxBlocks");
  if (!options.initialCwd || options.initialCwd.includes("\0")) {
    throw new Error("initialCwd must be a non-empty string without NUL");
  }
  return {
    blocks: [],
    currentCwd: options.initialCwd,
    mode: "raw",
    droppedBlocks: 0,
    nextBlockNumber: 1,
    maxBlockOutputBytes,
    maxBlocks,
  };
}

function emptyOutput(): HostTerminalBlockOutput {
  return { output: "", outputBytes: 0, droppedOutputBytes: 0 };
}

function appendUtf8Tail(
  current: HostTerminalBlockOutput,
  appended: string,
  maxBytes: number,
): HostTerminalBlockOutput {
  const appendedBytes = Buffer.byteLength(appended, "utf8");
  const combined = Buffer.from(current.output + appended, "utf8");
  if (combined.byteLength <= maxBytes) {
    return {
      output: current.output + appended,
      outputBytes: combined.byteLength,
      droppedOutputBytes: current.droppedOutputBytes,
    };
  }

  let start = combined.byteLength - maxBytes;
  while (start < combined.byteLength && (combined[start] & 0xc0) === 0x80) {
    start += 1;
  }
  const output = combined.subarray(start).toString("utf8");
  const outputBytes = Buffer.byteLength(output, "utf8");
  return {
    output,
    outputBytes,
    droppedOutputBytes:
      current.droppedOutputBytes +
      current.outputBytes +
      appendedBytes -
      outputBytes,
  };
}

function replaceBlock(
  state: HostTerminalBlockState,
  blockId: string,
  update: (block: HostTerminalBlock) => HostTerminalBlock,
): HostTerminalBlockState {
  let changed = false;
  const blocks = state.blocks.map((block) => {
    if (block.id !== blockId) return block;
    changed = true;
    return update(block);
  });
  return changed ? { ...state, blocks } : state;
}

interface ActiveHostTerminalBlockIds {
  readonly activePromptBlockId?: string;
  readonly activeCommandBlockId?: string;
}

function appendBlock(
  state: HostTerminalBlockState,
  block: HostTerminalBlock,
  active: ActiveHostTerminalBlockIds,
): HostTerminalBlockState {
  const allBlocks = [...state.blocks, block];
  const droppedCount = Math.max(0, allBlocks.length - state.maxBlocks);
  const blocks = droppedCount === 0 ? allBlocks : allBlocks.slice(droppedCount);
  const retainedIds = new Set(blocks.map((candidate) => candidate.id));
  return {
    ...state,
    blocks,
    droppedBlocks: state.droppedBlocks + droppedCount,
    nextBlockNumber: state.nextBlockNumber + 1,
    ...(active.activePromptBlockId &&
    retainedIds.has(active.activePromptBlockId)
      ? { activePromptBlockId: active.activePromptBlockId }
      : { activePromptBlockId: undefined }),
    ...(active.activeCommandBlockId &&
    retainedIds.has(active.activeCommandBlockId)
      ? { activeCommandBlockId: active.activeCommandBlockId }
      : { activeCommandBlockId: undefined }),
  };
}

function closeActivePrompt(
  state: HostTerminalBlockState,
): HostTerminalBlockState {
  const activePromptBlockId = state.activePromptBlockId;
  if (!activePromptBlockId) return state;
  const next = replaceBlock(state, activePromptBlockId, (block) =>
    block.kind === "prompt" && block.status === "open"
      ? { ...block, status: "closed" }
      : block,
  );
  return { ...next, activePromptBlockId: undefined };
}

function appendData(
  state: HostTerminalBlockState,
  data: string,
): HostTerminalBlockState {
  if (!data) return state;
  const targetId =
    state.activeCommandBlockId ?? state.activePromptBlockId ?? undefined;
  if (targetId) {
    return replaceBlock(state, targetId, (block) => ({
      ...block,
      ...appendUtf8Tail(block, data, state.maxBlockOutputBytes),
    }));
  }

  const last = state.blocks.at(-1);
  if (last?.kind === "raw" && last.cwd === state.currentCwd) {
    return replaceBlock(state, last.id, (block) => ({
      ...block,
      ...appendUtf8Tail(block, data, state.maxBlockOutputBytes),
    }));
  }

  const block: HostTerminalRawBlock = {
    id: `host-block-${state.nextBlockNumber}`,
    kind: "raw",
    cwd: state.currentCwd,
    ...appendUtf8Tail(emptyOutput(), data, state.maxBlockOutputBytes),
  };
  return appendBlock(state, block, {});
}

function applyShellEvent(
  state: HostTerminalBlockState,
  event: ShellIntegrationEvent,
): HostTerminalBlockState {
  let next =
    state.mode === "integrated"
      ? state
      : { ...state, mode: "integrated" as const };

  if (event.type === "cwd") {
    return event.cwd === next.currentCwd
      ? next
      : { ...next, currentCwd: event.cwd };
  }
  if (event.type === "prompt-end") {
    return closeActivePrompt(next);
  }
  if (event.type === "command-end") {
    const activeCommandBlockId = next.activeCommandBlockId;
    if (!activeCommandBlockId) return next;
    next = replaceBlock(next, activeCommandBlockId, (block) =>
      block.kind === "command" && block.status === "running"
        ? { ...block, status: "exited", exitCode: event.exitCode }
        : block,
    );
    return { ...next, activeCommandBlockId: undefined };
  }
  if (event.type === "prompt-start") {
    if (next.activePromptBlockId) return next;
    const block: HostTerminalPromptBlock = {
      id: `host-block-${next.nextBlockNumber}`,
      kind: "prompt",
      cwd: next.currentCwd,
      status: "open",
      ...emptyOutput(),
    };
    return appendBlock({ ...next, activeCommandBlockId: undefined }, block, {
      activePromptBlockId: block.id,
    });
  }

  next = closeActivePrompt(next);
  const block: HostTerminalCommandBlock = {
    id: `host-block-${next.nextBlockNumber}`,
    kind: "command",
    cwd: next.currentCwd,
    command: event.command,
    status: "running",
    ...emptyOutput(),
  };
  return appendBlock({ ...next, activeCommandBlockId: undefined }, block, {
    activeCommandBlockId: block.id,
  });
}

export function reduceHostTerminalBlocks(
  state: HostTerminalBlockState,
  action: HostTerminalBlockAction,
): HostTerminalBlockState {
  return action.type === "data"
    ? appendData(state, action.data)
    : applyShellEvent(state, action.event);
}

export function reduceHostTerminalParseResult(
  state: HostTerminalBlockState,
  result: ShellIntegrationParseResult,
): HostTerminalBlockState {
  return result.segments.reduce(
    (next, segment) =>
      reduceHostTerminalBlocks(
        next,
        segment.type === "data"
          ? { type: "data", data: segment.data }
          : { type: "shell-event", event: segment.event },
      ),
    state,
  );
}
