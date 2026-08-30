import { describe, expect, it } from "vitest";

import type { HostTerminalBlockState } from "@agentlink/protocol/terminal-surface";
import {
  createHostTerminalBlockState,
  reduceHostTerminalBlocks,
  reduceHostTerminalParseResult,
  type HostTerminalBlockAction,
} from "./hostTerminalBlocks.js";
import {
  createShellIntegrationParser,
  encodeShellIntegrationValue,
} from "./shellIntegration.js";

function reduce(
  state: HostTerminalBlockState,
  ...actions: HostTerminalBlockAction[]
): HostTerminalBlockState {
  return actions.reduce(reduceHostTerminalBlocks, state);
}

function initial(
  overrides: Partial<{
    initialCwd: string;
    maxBlockOutputBytes: number;
    maxBlocks: number;
  }> = {},
): HostTerminalBlockState {
  return createHostTerminalBlockState({
    initialCwd: "/workspace",
    ...overrides,
  });
}

const data = (value: string): HostTerminalBlockAction => ({
  type: "data",
  data: value,
});

const shell = (
  event: Extract<HostTerminalBlockAction, { type: "shell-event" }>["event"],
): HostTerminalBlockAction => ({ type: "shell-event", event });

describe("host terminal block reducer", () => {
  it("folds ordered parser segments from one PTY chunk into the correct blocks", () => {
    const nonce = "block_parser_nonce_12345";
    const marker = (kind: string, payload?: string) =>
      `\x1b]697;AgentLink;${nonce};${kind}${payload === undefined ? "" : `;${payload}`}\x07`;
    const parser = createShellIntegrationParser(nonce);
    const result = parser.push(
      [
        marker("P", encodeShellIntegrationValue("/workspace")),
        marker("A"),
        "$ ",
        marker("B"),
        marker("C", encodeShellIntegrationValue("echo hello")),
        "hello\r\n",
        marker("D", "0"),
        marker("A"),
        "$ ",
      ].join(""),
    );

    const state = reduceHostTerminalParseResult(initial(), result);

    expect(state.blocks).toEqual([
      expect.objectContaining({
        kind: "prompt",
        status: "closed",
        output: "$ ",
      }),
      expect.objectContaining({
        kind: "command",
        command: "echo hello",
        status: "exited",
        exitCode: 0,
        output: "hello\r\n",
      }),
      expect.objectContaining({
        kind: "prompt",
        status: "open",
        output: "$ ",
      }),
    ]);
  });

  it("folds prompt, command, cwd, and output into bounded lifecycle blocks", () => {
    const state = reduce(
      initial(),
      shell({ type: "cwd", cwd: "/workspace/project" }),
      shell({ type: "prompt-start" }),
      data("project % "),
      shell({ type: "prompt-end" }),
      shell({ type: "command-start", command: "printf hello" }),
      data("hello\r\n"),
      shell({ type: "command-end", exitCode: 0 }),
      shell({ type: "cwd", cwd: "/workspace/project/next" }),
      shell({ type: "prompt-start" }),
      data("next % "),
    );

    expect(state).toMatchObject({
      currentCwd: "/workspace/project/next",
      mode: "integrated",
      activePromptBlockId: "host-block-3",
      activeCommandBlockId: undefined,
      droppedBlocks: 0,
      nextBlockNumber: 4,
    });
    expect(state.blocks).toEqual([
      {
        id: "host-block-1",
        kind: "prompt",
        cwd: "/workspace/project",
        status: "closed",
        output: "project % ",
        outputBytes: 10,
        droppedOutputBytes: 0,
      },
      {
        id: "host-block-2",
        kind: "command",
        cwd: "/workspace/project",
        command: "printf hello",
        status: "exited",
        exitCode: 0,
        output: "hello\r\n",
        outputBytes: 7,
        droppedOutputBytes: 0,
      },
      {
        id: "host-block-3",
        kind: "prompt",
        cwd: "/workspace/project/next",
        status: "open",
        output: "next % ",
        outputBytes: 7,
        droppedOutputBytes: 0,
      },
    ]);
  });

  it("coalesces degraded raw data by cwd without interpreting content", () => {
    const markerLike = "\x1b]697;AgentLink;foreign;D;0\x07";
    let state = reduce(initial(), data("one"), data(markerLike), data("two"));

    expect(state.mode).toBe("raw");
    expect(state.blocks).toEqual([
      expect.objectContaining({
        id: "host-block-1",
        kind: "raw",
        cwd: "/workspace",
        output: `one${markerLike}two`,
      }),
    ]);

    state = reduce(
      state,
      shell({ type: "cwd", cwd: "/workspace/next" }),
      data("three"),
    );
    expect(state.mode).toBe("integrated");
    expect(state.blocks).toHaveLength(2);
    expect(state.blocks[1]).toMatchObject({
      kind: "raw",
      cwd: "/workspace/next",
      output: "three",
    });
  });

  it("retains complete UTF-8 tails and accumulates dropped output bytes", () => {
    const state = reduce(
      initial({ maxBlockOutputBytes: 7 }),
      shell({ type: "command-start", command: "generate" }),
      data("abc"),
      data("🙂def"),
      data("!"),
    );

    expect(state.blocks[0]).toMatchObject({
      output: "def!",
      outputBytes: 4,
      droppedOutputBytes: 7,
    });
  });

  it("bounds historical blocks and reports evictions", () => {
    const state = reduce(
      initial({ maxBlocks: 2 }),
      data("raw"),
      shell({ type: "prompt-start" }),
      shell({ type: "prompt-end" }),
      shell({ type: "command-start", command: "one" }),
      shell({ type: "command-end", exitCode: 0 }),
      shell({ type: "prompt-start" }),
    );

    expect(state.blocks.map((block) => block.id)).toEqual([
      "host-block-3",
      "host-block-4",
    ]);
    expect(state.droppedBlocks).toBe(2);
    expect(state.nextBlockNumber).toBe(5);
    expect(state.activePromptBlockId).toBe("host-block-4");
  });

  it("does not fabricate completion when prompt or a new command follows a missing end", () => {
    let state = reduce(
      initial(),
      shell({ type: "command-start", command: "first" }),
      data("first output"),
      shell({ type: "prompt-start" }),
      data("prompt"),
      shell({ type: "prompt-end" }),
      shell({ type: "command-start", command: "second" }),
      data("second output"),
    );

    expect(state.blocks[0]).toMatchObject({
      kind: "command",
      command: "first",
      status: "running",
      output: "first output",
    });
    expect(state.blocks[2]).toMatchObject({
      kind: "command",
      command: "second",
      status: "running",
      output: "second output",
    });
    expect(state.activeCommandBlockId).toBe("host-block-3");

    state = reduce(state, shell({ type: "command-end", exitCode: 9 }));
    expect(state.blocks[0]).toMatchObject({ status: "running" });
    expect(state.blocks[2]).toMatchObject({ status: "exited", exitCode: 9 });
  });

  it("ignores stale end markers and duplicate prompt starts", () => {
    const base = initial();
    const withStaleEnds = reduce(
      base,
      shell({ type: "command-end", exitCode: 1 }),
      shell({ type: "prompt-end" }),
    );
    expect(withStaleEnds).toEqual({ ...base, mode: "integrated" });

    const prompted = reduce(
      withStaleEnds,
      shell({ type: "prompt-start" }),
      shell({ type: "prompt-start" }),
    );
    expect(prompted.blocks).toHaveLength(1);
    expect(prompted.nextBlockNumber).toBe(2);
  });

  it("captures command cwd at start while later cwd events affect future blocks", () => {
    const state = reduce(
      initial(),
      shell({ type: "command-start", command: "cd next" }),
      shell({ type: "cwd", cwd: "/workspace/next" }),
      data("output"),
      shell({ type: "command-end", exitCode: 0 }),
      shell({ type: "prompt-start" }),
    );

    expect(state.blocks[0]).toMatchObject({
      kind: "command",
      cwd: "/workspace",
      output: "output",
    });
    expect(state.blocks[1]).toMatchObject({
      kind: "prompt",
      cwd: "/workspace/next",
    });
  });

  it("preserves input state and block objects across immutable updates", () => {
    const base = initial();
    const raw = reduceHostTerminalBlocks(base, data("raw"));
    const rawBlock = raw.blocks[0];
    const commanded = reduceHostTerminalBlocks(
      raw,
      shell({ type: "command-start", command: "echo" }),
    );

    expect(base.blocks).toEqual([]);
    expect(base.nextBlockNumber).toBe(1);
    expect(raw.blocks[0]).toBe(rawBlock);
    expect(commanded.blocks[0]).toBe(rawBlock);
    expect(commanded.blocks).not.toBe(raw.blocks);
  });

  it("treats empty data as an idempotent no-op", () => {
    const state = initial();
    expect(reduceHostTerminalBlocks(state, data(""))).toBe(state);
  });

  it("validates state limits and initial cwd", () => {
    expect(() => initial({ maxBlockOutputBytes: 0 })).toThrow(
      "maxBlockOutputBytes must be a positive safe integer",
    );
    expect(() => initial({ maxBlocks: 0 })).toThrow(
      "maxBlocks must be a positive safe integer",
    );
    expect(() => initial({ initialCwd: "" })).toThrow(
      "initialCwd must be a non-empty string without NUL",
    );
    expect(() => initial({ initialCwd: "bad\0cwd" })).toThrow(
      "initialCwd must be a non-empty string without NUL",
    );
  });
});
