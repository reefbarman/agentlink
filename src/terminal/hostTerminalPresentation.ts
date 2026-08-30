import type {
  AlternateScreenTransition,
  HostTerminalBlock,
  HostTerminalBlockState,
  HostTerminalSurfaceCommandSummary,
} from "@agentlink/protocol/terminal-surface";

export const MAX_SURFACE_COMMAND_LINE_CHARS = 300;

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
  readonly terminalRunning: boolean;
  readonly source: HostTerminalBlockState;
  readonly blocks: readonly HostTerminalBlockPresentation[];
}

export type HostTerminalPresentationAction =
  | { type: "blocks-changed"; state: HostTerminalBlockState }
  | { type: "alternate-screen"; transition: AlternateScreenTransition }
  | { type: "terminal-exited" }
  | { type: "reset"; state: HostTerminalBlockState };

function decorationFor(
  source: HostTerminalBlockState,
  block: HostTerminalBlock,
  terminalRunning: boolean,
): HostTerminalDecorationState {
  if (block.kind === "raw") return "undecorated";
  if (
    !terminalRunning &&
    ((block.kind === "prompt" && block.status === "open") ||
      (block.kind === "command" && block.status === "running"))
  ) {
    return "undecorated";
  }
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
  terminalRunning: boolean,
): readonly HostTerminalUserAction[] {
  const hasOutput = block.outputBytes > 0;
  if (block.kind !== "command") {
    return hasOutput ? ["copy-output", "attach-output"] : [];
  }

  const actions: HostTerminalUserAction[] = ["copy-command"];
  if (hasOutput) {
    actions.push("copy-output", "copy-command-and-output", "attach-output");
  }
  if (
    terminalRunning &&
    block.status === "running" &&
    block.id === source.activeCommandBlockId
  ) {
    actions.push("interrupt-command");
  } else if (block.status === "exited") {
    if (
      terminalRunning &&
      source.mode === "integrated" &&
      source.activeCommandBlockId === undefined &&
      source.activePromptBlockId !== undefined
    ) {
      actions.push("rerun-command");
    }
    actions.push("explain-command", "fix-command");
  }
  return actions;
}

function projectBlocks(
  source: HostTerminalBlockState,
  alternateScreen: boolean,
  terminalRunning: boolean,
): readonly HostTerminalBlockPresentation[] {
  return source.blocks.map((block) => ({
    blockId: block.id,
    decoration: alternateScreen
      ? "hidden"
      : decorationFor(source, block, terminalRunning),
    actions: alternateScreen ? [] : actionsFor(source, block, terminalRunning),
  }));
}

function createState(
  source: HostTerminalBlockState,
  alternateScreen: boolean,
  terminalRunning: boolean,
): HostTerminalPresentationState {
  return {
    alternateScreen,
    terminalRunning,
    source,
    blocks: projectBlocks(source, alternateScreen, terminalRunning),
  };
}

export function createHostTerminalPresentationState(
  source: HostTerminalBlockState,
): HostTerminalPresentationState {
  return createState(source, false, true);
}

export function reduceHostTerminalPresentation(
  state: HostTerminalPresentationState,
  action: HostTerminalPresentationAction,
): HostTerminalPresentationState {
  if (action.type === "reset") {
    if (!state.alternateScreen && action.state === state.source) return state;
    return createState(action.state, false, state.terminalRunning);
  }
  if (action.type === "blocks-changed") {
    if (action.state === state.source) return state;
    return createState(
      action.state,
      state.alternateScreen,
      state.terminalRunning,
    );
  }
  if (action.type === "terminal-exited") {
    return state.terminalRunning
      ? createState(state.source, state.alternateScreen, false)
      : state;
  }

  const alternateScreen = action.transition.type === "enter";
  if (alternateScreen === state.alternateScreen) return state;
  return createState(state.source, alternateScreen, state.terminalRunning);
}

export function summarizeHostTerminalCommand(
  block: HostTerminalBlock,
): HostTerminalSurfaceCommandSummary | undefined {
  if (block.kind !== "command" || block.command.length === 0) return undefined;
  const firstLine = block.command.split(/\r\n|\r|\n/, 1)[0];
  const commandLine = [...firstLine]
    .slice(0, MAX_SURFACE_COMMAND_LINE_CHARS)
    .join("");
  return {
    commandLine,
    truncated: commandLine.length < block.command.length,
    status: block.status,
    ...(block.exitCode === undefined ? {} : { exitCode: block.exitCode }),
  };
}

export function isHostTerminalUserActionAllowed(
  state: HostTerminalPresentationState,
  blockId: string,
  action: HostTerminalUserAction,
): boolean {
  return (
    state.blocks
      .find((block) => block.blockId === blockId)
      ?.actions.includes(action) ?? false
  );
}
