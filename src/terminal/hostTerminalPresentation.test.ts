import {
  createHostTerminalBlockState,
  reduceHostTerminalBlocks,
  type HostTerminalBlockAction,
  type HostTerminalBlockState,
} from "./hostTerminalBlocks.js";
import {
  createHostTerminalPresentationState,
  reduceHostTerminalPresentation,
  type HostTerminalPresentationState,
} from "./hostTerminalPresentation.js";
import { createAlternateScreenTracker } from "./alternateScreenTracker.js";
import { describe, expect, it } from "vitest";

function blocks(...actions: HostTerminalBlockAction[]): HostTerminalBlockState {
  return actions.reduce(
    reduceHostTerminalBlocks,
    createHostTerminalBlockState({ initialCwd: "/workspace" }),
  );
}

const data = (value: string): HostTerminalBlockAction => ({
  type: "data",
  data: value,
});

const shell = (
  event: Extract<HostTerminalBlockAction, { type: "shell-event" }>["event"],
): HostTerminalBlockAction => ({ type: "shell-event", event });

function applyAlternateScreenData(
  state: HostTerminalPresentationState,
  tracker: ReturnType<typeof createAlternateScreenTracker>,
  input: string,
): HostTerminalPresentationState {
  return tracker.push(input).transitions.reduce(
    (next, transition) =>
      reduceHostTerminalPresentation(next, {
        type: "alternate-screen",
        transition,
      }),
    state,
  );
}

describe("host terminal presentation policy", () => {
  it("derives decoration lifecycle and user-only command actions", () => {
    const running = blocks(
      shell({ type: "prompt-start" }),
      data("$ "),
      shell({ type: "prompt-end" }),
      shell({ type: "command-start", command: "npm test" }),
      data("running\r\n"),
    );

    const active = createHostTerminalPresentationState(running);
    expect(active.blocks).toEqual([
      {
        blockId: "host-block-1",
        decoration: "completed",
        actions: ["copy-output", "attach-output"],
      },
      {
        blockId: "host-block-2",
        decoration: "active",
        actions: [
          "copy-command",
          "copy-output",
          "copy-command-and-output",
          "attach-output",
          "interrupt-command",
        ],
      },
    ]);

    const exited = reduceHostTerminalBlocks(
      running,
      shell({ type: "command-end", exitCode: 1 }),
    );
    const completed = reduceHostTerminalPresentation(active, {
      type: "blocks-changed",
      state: exited,
    });

    expect(completed.blocks[1]).toEqual({
      blockId: "host-block-2",
      decoration: "completed",
      actions: [
        "copy-command",
        "copy-output",
        "copy-command-and-output",
        "attach-output",
        "explain-command",
        "fix-command",
      ],
    });
  });

  it("offers rerun only after an integrated idle prompt follows completion", () => {
    const exited = blocks(
      shell({ type: "command-start", command: "npm test" }),
      shell({ type: "command-end", exitCode: 0 }),
    );
    expect(
      createHostTerminalPresentationState(exited).blocks[0]?.actions,
    ).not.toContain("rerun-command");

    const idle = reduceHostTerminalBlocks(
      exited,
      shell({ type: "prompt-start" }),
    );
    expect(
      createHostTerminalPresentationState(idle).blocks[0]?.actions,
    ).toContain("rerun-command");

    const runningAgain = reduceHostTerminalBlocks(
      idle,
      shell({ type: "command-start", command: "npm test --changed" }),
    );
    expect(
      createHostTerminalPresentationState(runningAgain).blocks[0]?.actions,
    ).not.toContain("rerun-command");
  });

  it("hides stale running blocks and does not offer interrupt after missing markers", () => {
    const source = blocks(
      shell({ type: "command-start", command: "first" }),
      data("first output"),
      shell({ type: "command-start", command: "second" }),
      data("second output"),
    );

    expect(source.blocks[0]).toMatchObject({ status: "running" });
    expect(source.activeCommandBlockId).toBe("host-block-2");
    expect(createHostTerminalPresentationState(source).blocks).toEqual([
      {
        blockId: "host-block-1",
        decoration: "undecorated",
        actions: [
          "copy-command",
          "copy-output",
          "copy-command-and-output",
          "attach-output",
        ],
      },
      {
        blockId: "host-block-2",
        decoration: "active",
        actions: [
          "copy-command",
          "copy-output",
          "copy-command-and-output",
          "attach-output",
          "interrupt-command",
        ],
      },
    ]);
  });

  it("limits empty prompts and commands to actions supported by their data", () => {
    const source = blocks(
      shell({ type: "prompt-start" }),
      shell({ type: "prompt-end" }),
      shell({ type: "command-start", command: "sleep 10" }),
    );

    expect(createHostTerminalPresentationState(source).blocks).toEqual([
      {
        blockId: "host-block-1",
        decoration: "completed",
        actions: [],
      },
      {
        blockId: "host-block-2",
        decoration: "active",
        actions: ["copy-command", "interrupt-command"],
      },
    ]);
  });

  it("treats raw degraded blocks conservatively without inferred command actions", () => {
    const source = blocks(data("unstructured output"));
    const state = createHostTerminalPresentationState(source);

    expect(source.mode).toBe("raw");
    expect(state.blocks).toEqual([
      {
        blockId: "host-block-1",
        decoration: "undecorated",
        actions: ["copy-output", "attach-output"],
      },
    ]);
    expect(state.blocks[0]?.actions).not.toContain("rerun-command");
    expect(state.blocks[0]?.actions).not.toContain("interrupt-command");
  });

  it("suspends decorations and actions during TUI state and restores the latest lifecycle", () => {
    const tracker = createAlternateScreenTracker();
    const running = blocks(
      shell({ type: "command-start", command: "vim file.txt" }),
      data("screen data"),
    );
    const visible = createHostTerminalPresentationState(running);

    const suspended = applyAlternateScreenData(visible, tracker, "\x1b[?1049h");
    expect(suspended.alternateScreen).toBe(true);
    expect(suspended.blocks).toEqual([
      {
        blockId: "host-block-1",
        decoration: "hidden",
        actions: [],
      },
    ]);

    const exited = reduceHostTerminalBlocks(
      running,
      shell({ type: "command-end", exitCode: 0 }),
    );
    const updatedWhileSuspended = reduceHostTerminalPresentation(suspended, {
      type: "blocks-changed",
      state: exited,
    });
    expect(updatedWhileSuspended.blocks[0]).toEqual({
      blockId: "host-block-1",
      decoration: "hidden",
      actions: [],
    });

    const restored = applyAlternateScreenData(
      updatedWhileSuspended,
      tracker,
      "\x1b[?1049l",
    );
    expect(restored.alternateScreen).toBe(false);
    expect(restored.blocks[0]).toEqual({
      blockId: "host-block-1",
      decoration: "completed",
      actions: [
        "copy-command",
        "copy-output",
        "copy-command-and-output",
        "attach-output",
        "explain-command",
        "fix-command",
      ],
    });
  });

  it("removes process-control actions when the terminal exits", () => {
    const source = blocks(
      shell({ type: "command-start", command: "sleep 10" }),
    );
    const running = createHostTerminalPresentationState(source);
    expect(running.blocks[0]?.actions).toContain("interrupt-command");

    const exited = reduceHostTerminalPresentation(running, {
      type: "terminal-exited",
    });
    expect(exited.terminalRunning).toBe(false);
    expect(exited.blocks[0]?.decoration).toBe("undecorated");
    expect(exited.blocks[0]?.actions).not.toContain("interrupt-command");
    expect(
      reduceHostTerminalPresentation(exited, { type: "terminal-exited" }),
    ).toBe(exited);
  });

  it("handles duplicate transitions and unchanged block state as immutable no-ops", () => {
    const source = blocks(data("raw"));
    const initial = createHostTerminalPresentationState(source);
    const entered = reduceHostTerminalPresentation(initial, {
      type: "alternate-screen",
      transition: { type: "enter", modes: [1049] },
    });

    expect(
      reduceHostTerminalPresentation(entered, {
        type: "alternate-screen",
        transition: { type: "enter", modes: [47] },
      }),
    ).toBe(entered);
    expect(
      reduceHostTerminalPresentation(entered, {
        type: "blocks-changed",
        state: source,
      }),
    ).toBe(entered);
    expect(source.blocks[0]?.output).toBe("raw");
  });

  it("reset exits alternate screen and replaces the presentation source", () => {
    const first = blocks(data("raw"));
    const second = blocks(
      shell({ type: "command-start", command: "echo ready" }),
      shell({ type: "command-end", exitCode: 0 }),
    );
    const suspended = reduceHostTerminalPresentation(
      createHostTerminalPresentationState(first),
      {
        type: "alternate-screen",
        transition: { type: "enter", modes: [1049] },
      },
    );

    const reset = reduceHostTerminalPresentation(suspended, {
      type: "reset",
      state: second,
    });

    expect(reset.alternateScreen).toBe(false);
    expect(reset.source).toBe(second);
    expect(reset.blocks).toEqual([
      {
        blockId: "host-block-1",
        decoration: "completed",
        actions: ["copy-command", "explain-command", "fix-command"],
      },
    ]);
    expect(
      reduceHostTerminalPresentation(reset, { type: "reset", state: second }),
    ).toBe(reset);
  });

  it("drops presentations when bounded source blocks are evicted", () => {
    let source = createHostTerminalBlockState({
      initialCwd: "/workspace",
      maxBlocks: 1,
    });
    source = reduceHostTerminalBlocks(source, data("old raw"));
    const initial = createHostTerminalPresentationState(source);

    source = reduceHostTerminalBlocks(
      source,
      shell({ type: "command-start", command: "new command" }),
    );
    const updated = reduceHostTerminalPresentation(initial, {
      type: "blocks-changed",
      state: source,
    });

    expect(updated.blocks).toEqual([
      {
        blockId: "host-block-2",
        decoration: "active",
        actions: ["copy-command", "interrupt-command"],
      },
    ]);
  });
});
