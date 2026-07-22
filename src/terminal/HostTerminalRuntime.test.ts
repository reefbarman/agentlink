import {
  createRawShellIntegrationParser,
  createShellIntegrationParser,
  encodeShellIntegrationValue,
} from "./shellIntegration.js";
import { describe, expect, it, vi } from "vitest";

import { HostTerminalRuntime } from "./HostTerminalRuntime.js";

const nonce = "host_runtime_nonce_12345";
const terminalInstanceId = "host-instance-1";
const marker = (kind: string, payload?: string) =>
  `\x1b]697;AgentLink;${nonce};${kind}${payload === undefined ? "" : `;${payload}`}\x07`;

function integrated(
  overrides: Partial<ConstructorParameters<typeof HostTerminalRuntime>[0]> = {},
): HostTerminalRuntime {
  return new HostTerminalRuntime({
    terminalId: "host-terminal-1",
    terminalInstanceId,
    parser: createShellIntegrationParser(nonce),
    initialCwd: "/workspace",
    ...overrides,
  });
}

function raw(
  overrides: Partial<ConstructorParameters<typeof HostTerminalRuntime>[0]> = {},
): HostTerminalRuntime {
  return new HostTerminalRuntime({
    terminalId: "host-terminal-1",
    terminalInstanceId,
    parser: createRawShellIntegrationParser(),
    initialCwd: "/workspace",
    ...overrides,
  });
}

describe("HostTerminalRuntime", () => {
  it("strips private markers and preserves ordered writes and block boundaries", () => {
    const runtime = integrated();
    const update = runtime.processData(
      [
        marker("P", encodeShellIntegrationValue("/workspace/project")),
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

    expect(update.continueOutput).toBe(true);
    expect(update.batch?.operations).toEqual([
      {
        type: "block-boundary",
        boundary: "prompt-start",
        blockId: "host-block-1",
      },
      { type: "write", data: "$ " },
      {
        type: "block-boundary",
        boundary: "prompt-end",
        blockId: "host-block-1",
      },
      {
        type: "block-boundary",
        boundary: "command-start",
        blockId: "host-block-2",
      },
      { type: "write", data: "hello\r\n" },
      {
        type: "block-boundary",
        boundary: "command-end",
        blockId: "host-block-2",
      },
      {
        type: "block-boundary",
        boundary: "prompt-start",
        blockId: "host-block-3",
      },
      { type: "write", data: "$ " },
      expect.objectContaining({
        type: "presentation",
        alternateScreen: false,
      }),
    ]);

    const snapshot = runtime.snapshot();
    expect(snapshot.data).toBe("$ hello\r\n$ ");
    expect(snapshot.blocks.currentCwd).toBe("/workspace/project");
    expect(snapshot.blocks.blocks).toEqual([
      expect.objectContaining({
        kind: "prompt",
        status: "closed",
        output: "$ ",
      }),
      expect.objectContaining({
        kind: "command",
        status: "exited",
        command: "echo hello",
        output: "hello\r\n",
      }),
      expect.objectContaining({ kind: "prompt", status: "open", output: "$ " }),
    ]);
    expect(
      runtime.isActionAllowed(
        terminalInstanceId,
        "host-block-2",
        "rerun-command",
      ),
    ).toBe(true);
  });

  it("treats a user terminal as busy unless host state proves an idle integrated prompt", () => {
    const integratedRuntime = integrated();
    expect(integratedRuntime.userMayBeBusy).toBe(true);
    expect(integratedRuntime.closeRequiresConfirmation).toBe(true);

    integratedRuntime.processData(
      [
        marker("P", encodeShellIntegrationValue("/workspace")),
        marker("A"),
        "$ ",
      ].join(""),
    );
    expect(integratedRuntime.userMayBeBusy).toBe(false);
    expect(integratedRuntime.closeRequiresConfirmation).toBe(false);

    integratedRuntime.processData(
      [marker("B"), marker("C", encodeShellIntegrationValue("sleep 10"))].join(
        "",
      ),
    );
    expect(integratedRuntime.userMayBeBusy).toBe(true);
    expect(integratedRuntime.closeRequiresConfirmation).toBe(true);

    const tuiRuntime = raw();
    tuiRuntime.processData("\x1b[?1049h");
    expect(tuiRuntime.userMayBeBusy).toBe(true);
    expect(tuiRuntime.closeRequiresConfirmation).toBe(true);
    expect(raw().userMayBeBusy).toBe(true);
    expect(raw().closeRequiresConfirmation).toBe(true);

    integratedRuntime.finish();
    expect(integratedRuntime.userMayBeBusy).toBe(false);
    expect(integratedRuntime.closeRequiresConfirmation).toBe(false);
  });

  it("authorizes only sanitized plain-text copy payloads", () => {
    const runtime = raw();
    runtime.processData("before\x1b[31mred\x1b[0mafter");

    expect(
      runtime.authorizeAction(
        terminalInstanceId,
        "host-block-1",
        "copy-output",
      ),
    ).toEqual({
      authorized: true,
      action: "copy-output",
      clipboardText: "beforeredafter",
    });
    expect(
      runtime.authorizeAction("stale-instance", "host-block-1", "copy-output"),
    ).toEqual({ authorized: false });
    expect(
      runtime.authorizeAction(
        terminalInstanceId,
        "host-block-1",
        "copy-command",
      ),
    ).toEqual({
      authorized: false,
    });
  });

  it("denies copy when retained block output is truncated", () => {
    const runtime = raw({
      blockStateOptions: { maxBlockOutputBytes: 4 },
    });
    const update = runtime.processData("truncated");

    expect(runtime.getBlock("host-block-1")).toMatchObject({
      output: "ated",
      droppedOutputBytes: 5,
    });
    expect(
      runtime.authorizeAction(
        terminalInstanceId,
        "host-block-1",
        "copy-output",
      ),
    ).toEqual({
      authorized: false,
      reason: "copy-output-truncated",
    });
    expect(update.batch?.operations).toContainEqual({
      type: "presentation",
      alternateScreen: false,
      blocks: [
        {
          blockId: "host-block-1",
          decoration: "undecorated",
          actions: [],
        },
      ],
    });
  });

  it("reports complete copy payloads that exceed the independent copy bound", () => {
    const runtime = raw({
      blockStateOptions: { maxBlockOutputBytes: 300 * 1024 },
    });
    runtime.processData("x".repeat(256 * 1024 + 1));

    expect(
      runtime.authorizeAction(
        terminalInstanceId,
        "host-block-1",
        "copy-output",
      ),
    ).toEqual({
      authorized: false,
      reason: "copy-text-too-large",
    });
  });

  it("formats command and output as one sanitized clipboard payload", () => {
    const runtime = integrated();
    runtime.processData(
      [
        marker("C", encodeShellIntegrationValue("printf hello")),
        "\x1b[31mhello\x1b[0m\r\n",
      ].join(""),
    );

    expect(
      runtime.authorizeAction(
        terminalInstanceId,
        "host-block-1",
        "copy-command-and-output",
      ),
    ).toEqual({
      authorized: true,
      action: "copy-command-and-output",
      clipboardText: "printf hello\nhello\r\n",
    });
  });

  it("filters every host-effect OSC before writes, block output, and replay", () => {
    const runtime = raw();
    const suppressed = [
      "\x1b]9;notification\x07",
      "\x1b]52;c;c2VjcmV0\x1b\\",
      "\x1b]697;AgentLink;foreign;A\x07",
      "\x9d777;notify;title;body\x9c",
      "\x1b]1337;File=name=test:data\x07",
    ];
    const update = runtime.processData(`before${suppressed.join("")}after`);

    expect(update.batch).toMatchObject({
      operations: [
        { type: "write", data: "beforeafter" },
        { type: "presentation" },
      ],
      suppressedOutputCharacters: suppressed.join("").length,
      outputPolicyDecisions: [
        { command: 9, recommendedAction: "suppress", reason: "notification" },
        { command: 52, recommendedAction: "suppress", reason: "clipboard" },
        {
          command: 697,
          recommendedAction: "suppress",
          reason: "private-shell-integration",
        },
        {
          command: 777,
          recommendedAction: "suppress",
          reason: "notification",
        },
        {
          command: 1337,
          recommendedAction: "suppress",
          reason: "proprietary-host-integration",
        },
      ],
    });
    expect(runtime.snapshot().data).toBe("beforeafter");
    expect(runtime.snapshot().blocks.blocks[0]).toMatchObject({
      kind: "raw",
      output: "beforeafter",
    });
  });

  it("emits ordered alternate-screen transitions and restores presentation", () => {
    const runtime = raw();
    const update = runtime.processData(
      "before\x1b[?1049hinside\x1b[?1049lafter",
    );

    expect(update.batch?.operations).toEqual([
      { type: "write", data: "before\x1b[?1049h" },
      {
        type: "alternate-screen",
        transition: { type: "enter", modes: [1049] },
      },
      { type: "write", data: "inside\x1b[?1049l" },
      {
        type: "alternate-screen",
        transition: { type: "exit", modes: [1049] },
      },
      { type: "write", data: "after" },
      expect.objectContaining({
        type: "presentation",
        alternateScreen: false,
      }),
    ]);
    expect(runtime.snapshot().presentation.alternateScreen).toBe(false);
  });

  it("retains a bounded UTF-8 render tail and reports dropped bytes", () => {
    const runtime = raw({ maxRenderReplayBytes: 7 });

    runtime.processData("abc");
    runtime.processData("🙂def");
    const update = runtime.processData("!");

    expect(runtime.snapshot()).toMatchObject({
      data: "def!",
      byteLength: 4,
      droppedBytes: 7,
    });
    expect(update.batch?.droppedRenderBytes).toBe(7);
  });

  it("appends a long printable replay span once instead of once per character", () => {
    const runtime = raw({ maxRenderReplayBytes: 1024 });
    const appendReplayUnit = vi.spyOn(
      runtime as unknown as {
        appendReplayUnit(data: string, splittable: boolean): void;
      },
      "appendReplayUnit",
    );

    runtime.processData("x".repeat(1200));

    expect(appendReplayUnit).toHaveBeenCalledTimes(1);
    expect(appendReplayUnit).toHaveBeenCalledWith("x".repeat(1200), true);
    expect(runtime.snapshot()).toMatchObject({
      data: "x".repeat(1024),
      byteLength: 1024,
      droppedBytes: 176,
    });
  });

  it("requires explicit detach before a different renderer epoch attaches", () => {
    const runtime = raw();
    runtime.attachRenderer("renderer-1");
    expect(() => runtime.attachRenderer("renderer-2")).toThrow(
      "A different terminal renderer is already attached",
    );
    expect(runtime.detachRenderer(terminalInstanceId, "renderer-1")).toEqual({
      accepted: true,
      shouldResume: false,
    });
    expect(runtime.attachRenderer("renderer-2").terminalInstanceId).toBe(
      terminalInstanceId,
    );
  });

  it("distinguishes transient replay control state from truncation", () => {
    const runtime = raw();
    runtime.processData("before\x1b[");
    expect(runtime.snapshot()).toMatchObject({
      data: "before",
      replayTruncated: false,
      replayPendingControl: true,
    });

    runtime.processData("31mred");
    expect(runtime.snapshot()).toMatchObject({
      data: "before\x1b[31mred",
      replayTruncated: false,
      replayPendingControl: false,
    });
  });

  it("backpressures only an attached renderer and resumes below low water", () => {
    const runtime = raw({
      renderHighWaterBytes: 10,
      renderLowWaterBytes: 4,
    });

    expect(runtime.processData("detached output").continueOutput).toBe(true);
    const attached = runtime.attachRenderer("renderer-1");
    expect(attached.data).toBe("detached output");

    const first = runtime.processData("123456");
    const second = runtime.processData("7890");
    expect(first.continueOutput).toBe(true);
    expect(second.continueOutput).toBe(true);
    expect(
      runtime.markBatchDelivered(
        terminalInstanceId,
        "renderer-1",
        first.batch!.sequence,
      ),
    ).toEqual({ accepted: true, shouldPause: false });
    expect(
      runtime.markBatchDelivered(
        terminalInstanceId,
        "renderer-1",
        second.batch!.sequence,
      ),
    ).toEqual({ accepted: true, shouldPause: true });
    expect(
      runtime.acknowledge(
        terminalInstanceId,
        "stale-renderer",
        first.batch!.sequence,
      ),
    ).toEqual({
      accepted: false,
      shouldResume: false,
    });
    expect(runtime.acknowledge(terminalInstanceId, "renderer-1", 999)).toEqual({
      accepted: false,
      shouldResume: false,
    });
    expect(
      runtime.acknowledge(
        terminalInstanceId,
        "renderer-1",
        first.batch!.sequence,
      ),
    ).toEqual({
      accepted: true,
      shouldResume: true,
    });
    expect(
      runtime.acknowledge(
        terminalInstanceId,
        "renderer-1",
        first.batch!.sequence,
      ),
    ).toEqual({
      accepted: true,
      shouldResume: false,
    });

    expect(runtime.detachRenderer(terminalInstanceId, "renderer-1")).toEqual({
      accepted: true,
      shouldResume: false,
    });
    expect(runtime.processData("more output").continueOutput).toBe(true);
  });

  it("detaches and clears renderer debt after delivery failure", () => {
    const runtime = raw({
      renderHighWaterBytes: 4,
      renderLowWaterBytes: 2,
    });
    runtime.attachRenderer("renderer-1");
    const update = runtime.processData("1234");
    expect(
      runtime.markBatchDelivered(
        terminalInstanceId,
        "renderer-1",
        update.batch!.sequence,
      ),
    ).toEqual({ accepted: true, shouldPause: true });

    expect(
      runtime.markBatchDeliveryFailed(
        terminalInstanceId,
        "stale-renderer",
        update.batch!.sequence,
      ),
    ).toEqual({ accepted: false, shouldResume: false });
    expect(
      runtime.markBatchDeliveryFailed(
        terminalInstanceId,
        "renderer-1",
        update.batch!.sequence,
      ),
    ).toEqual({ accepted: true, shouldResume: true });
    expect(
      runtime.acknowledge(
        terminalInstanceId,
        "renderer-1",
        update.batch!.sequence,
      ),
    ).toEqual({
      accepted: false,
      shouldResume: false,
    });
    expect(runtime.processData("detached").continueOutput).toBe(true);
  });

  it("forces alternate-screen exit across fresh process boundaries", () => {
    const runtime = raw();
    runtime.processData("\x1b[?1049hinteractive");

    const reset = runtime.resetProcessBoundary();

    expect(reset.batch?.operations).toEqual([
      { type: "write", data: "\x1b[?1049l" },
      {
        type: "alternate-screen",
        transition: { type: "exit", modes: [1049] },
      },
      expect.objectContaining({
        type: "presentation",
        alternateScreen: false,
      }),
    ]);
    expect(runtime.snapshot().presentation.alternateScreen).toBe(false);
  });

  it("drops incomplete control state across fresh process boundaries", () => {
    const runtime = raw();
    runtime.processData("safe\x1b]52;c;partial");
    expect(runtime.snapshot()).toMatchObject({
      data: "safe",
      replayPendingControl: false,
    });

    runtime.resetProcessBoundary();
    const next = runtime.processData("next");

    expect(next.batch?.operations).toContainEqual({
      type: "write",
      data: "next",
    });
    expect(runtime.snapshot()).toMatchObject({
      data: "safenext",
      replayPendingControl: false,
    });
  });

  it("flushes incomplete parser/filter data and removes process actions on exit", () => {
    const runtime = integrated();
    runtime.processData(
      [
        marker("A"),
        "$ ",
        marker("B"),
        marker("C", encodeShellIntegrationValue("printf partial")),
        "partial\x1b",
      ].join(""),
    );

    const finished = runtime.finish();
    expect(finished.batch?.operations).toEqual([
      { type: "write", data: "\x1b" },
      expect.objectContaining({ type: "presentation" }),
    ]);
    expect(runtime.snapshot()).toMatchObject({
      data: "$ partial",
      droppedBytes: 1,
      replayTruncated: true,
    });
    expect(
      runtime.isActionAllowed(
        terminalInstanceId,
        "host-block-2",
        "interrupt-command",
      ),
    ).toBe(false);
    expect(runtime.processData("ignored")).toEqual({ continueOutput: true });
    expect(runtime.finish()).toEqual({ continueOutput: true });
  });

  it("does not authorize shell-reported commands beyond the input bound", () => {
    const runtime = integrated({
      parser: createShellIntegrationParser(nonce, {
        maxFrameBytes: 128 * 1024,
      }),
    });
    const command = "x".repeat(64 * 1024);
    runtime.processData(
      [
        marker("C", encodeShellIntegrationValue(command)),
        marker("D", "0"),
        marker("A"),
      ].join(""),
    );

    expect(runtime.snapshot().presentation.blocks[0]?.actions).not.toContain(
      "rerun-command",
    );
    expect(
      runtime.authorizeAction(
        terminalInstanceId,
        "host-block-1",
        "rerun-command",
      ),
    ).toEqual({ authorized: false });
  });

  it("does not offer rerun while another command is active", () => {
    const runtime = integrated();
    runtime.processData(
      [
        marker("C", encodeShellIntegrationValue("first")),
        marker("D", "0"),
        marker("A"),
        "$ ",
      ].join(""),
    );
    expect(
      runtime.isActionAllowed(
        terminalInstanceId,
        "host-block-1",
        "rerun-command",
      ),
    ).toBe(true);
    runtime.noteUserInput(terminalInstanceId);
    expect(
      runtime.isActionAllowed(
        terminalInstanceId,
        "host-block-1",
        "rerun-command",
      ),
    ).toBe(false);
    runtime.processData(`${marker("B")}${marker("A")}`);
    expect(
      runtime.authorizeAction(
        terminalInstanceId,
        "host-block-1",
        "rerun-command",
      ),
    ).toEqual({
      authorized: true,
      action: "rerun-command",
      command: "first",
    });
    expect(
      runtime.authorizeAction(
        terminalInstanceId,
        "host-block-1",
        "rerun-command",
      ),
    ).toEqual({
      authorized: false,
    });

    runtime.processData(
      [marker("B"), marker("C", encodeShellIntegrationValue("second"))].join(
        "",
      ),
    );
    expect(
      runtime.isActionAllowed(
        terminalInstanceId,
        "host-block-1",
        "rerun-command",
      ),
    ).toBe(false);
    expect(
      runtime.isActionAllowed(
        terminalInstanceId,
        "host-block-4",
        "interrupt-command",
      ),
    ).toBe(true);
  });

  it("keeps control-sequence replay units intact when truncating", () => {
    const runtime = raw({ maxRenderReplayBytes: 8 });
    runtime.processData("prefix\x1b[31mred");

    expect(runtime.snapshot()).toMatchObject({
      data: "\x1b[31mred",
      byteLength: 8,
      droppedBytes: 6,
      replayTruncated: true,
    });
  });

  it("suppresses malformed private OSC before block output and replay", () => {
    const runtime = raw();
    const privateFrame = "\x1b]697;AgentLink;foreign;D;0\x07";
    const update = runtime.processData(`before${privateFrame}after`);

    expect(runtime.snapshot().data).toBe("beforeafter");
    expect(update.batch?.outputPolicyDecisions).toEqual([
      {
        type: "osc",
        command: 697,
        recommendedAction: "suppress",
        reason: "private-shell-integration",
      },
    ]);
  });

  it("validates replay and backpressure bounds", () => {
    expect(() => raw({ maxRenderReplayBytes: 0 })).toThrow(
      "maxRenderReplayBytes must be a positive safe integer",
    );
    expect(() =>
      raw({ renderHighWaterBytes: 10, renderLowWaterBytes: 10 }),
    ).toThrow("renderLowWaterBytes must be less than renderHighWaterBytes");
  });
});
