import type {
  HostTerminalBlock,
  HostTerminalBlockState,
} from "./hostTerminalBlocks.js";

import type { AlternateScreenTransition } from "./alternateScreenTracker.js";

export type HostTerminalDecorationState =
  | "hidden"
  | "undecorated"
  | "active"
  | "completed";

export type HostTerminalUserAction =
  | "copy-command"
  | "copy-output"
  | "copy-command-and-output"
  | "rerun-command"
  | "interrupt-command"
  | "explain-command"
  | "fix-command"
  | "attach-output";

export interface HostTerminalBlockPresentation {
  readonly blockId: string;
  readonly decoration: HostTerminalDecorationState;
  readonly actions: readonly HostTerminalUserAction[];
}

export interface HostTerminalPresentationState {
  readonly alternateScreen: boolean;
  readonly source: HostTerminalBlockState;
  readonly blocks: readonly HostTerminalBlockPresentation[];
}

export type HostTerminalPresentationAction =
  | { type: "blocks-changed"; state: HostTerminalBlockState }
  | { type: "alternate-screen"; transition: AlternateScreenTransition }
  | { type: "reset"; state: HostTerminalBlockState };

function decorationFor(
  source: HostTerminalBlockState,
  block: HostTerminalBlock,
): HostTerminalDecorationState {
  if (block.kind === "raw") return "undecorated";
  if (block.kind === "prompt") {
    if (block.status === "closed") return "completed";
    return block.id === source.activePromptBlockId ? "active" : "undecorated";
  }
  if (block.status === "exited") return "completed";
  return block.id === source.activeCommandBlockId ? "active" : "undecorated";
}

function actionsFor(
  source: HostTerminalBlockState,
  block: HostTerminalBlock,
): readonly HostTerminalUserAction[] {
  const hasOutput = block.outputBytes > 0;
  if (block.kind !== "command") {
    return hasOutput ? ["copy-output", "attach-output"] : [];
  }

  const actions: HostTerminalUserAction[] = ["copy-command"];
  if (hasOutput) {
    actions.push("copy-output", "copy-command-and-output", "attach-output");
  }
  if (block.status === "running" && block.id === source.activeCommandBlockId) {
    actions.push("interrupt-command");
  } else if (block.status === "exited") {
    actions.push("rerun-command", "explain-command", "fix-command");
  }
  return actions;
}

function projectBlocks(
  source: HostTerminalBlockState,
  alternateScreen: boolean,
): readonly HostTerminalBlockPresentation[] {
  return source.blocks.map((block) => ({
    blockId: block.id,
    decoration: alternateScreen ? "hidden" : decorationFor(source, block),
    actions: alternateScreen ? [] : actionsFor(source, block),
  }));
}

function createState(
  source: HostTerminalBlockState,
  alternateScreen: boolean,
): HostTerminalPresentationState {
  return {
    alternateScreen,
    source,
    blocks: projectBlocks(source, alternateScreen),
  };
}

export function createHostTerminalPresentationState(
  source: HostTerminalBlockState,
): HostTerminalPresentationState {
  return createState(source, false);
}

export function reduceHostTerminalPresentation(
  state: HostTerminalPresentationState,
  action: HostTerminalPresentationAction,
): HostTerminalPresentationState {
  if (action.type === "reset") {
    if (!state.alternateScreen && action.state === state.source) return state;
    return createState(action.state, false);
  }
  if (action.type === "blocks-changed") {
    if (action.state === state.source) return state;
    return createState(action.state, state.alternateScreen);
  }

  const alternateScreen = action.transition.type === "enter";
  if (alternateScreen === state.alternateScreen) return state;
  return createState(state.source, alternateScreen);
}
