import {
  MAX_TERMINAL_DIMENSION,
  TERMINAL_SURFACE_PROTOCOL_VERSION,
  isTerminalSurfaceRequest,
  type AlternateScreenTransition,
  type HostTerminalBlockState,
  type HostTerminalCommandBlock,
  type HostTerminalPromptBlock,
  type HostTerminalRawBlock,
  type HostTerminalRenderBatch,
  type ShellIntegrationMode,
  type TerminalOutputPolicyDecision,
  type TerminalSurfaceEvent,
  type TerminalSurfaceRequest,
} from "./terminalSurface.js";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("terminal surface protocol", () => {
  it("pins the supporting serialized DTO closure", () => {
    expectTypeOf<ShellIntegrationMode>().toEqualTypeOf<"raw" | "integrated">();
    expectTypeOf<AlternateScreenTransition>().toEqualTypeOf<
      | { type: "enter"; modes: readonly number[] }
      | { type: "exit"; modes: readonly number[] }
    >();
    expectTypeOf<HostTerminalRawBlock>().toEqualTypeOf<{
      readonly id: string;
      readonly kind: "raw";
      readonly cwd: string;
      readonly output: string;
      readonly outputBytes: number;
      readonly droppedOutputBytes: number;
    }>();
    expectTypeOf<HostTerminalPromptBlock>().toEqualTypeOf<{
      readonly id: string;
      readonly kind: "prompt";
      readonly cwd: string;
      readonly status: "open" | "closed";
      readonly output: string;
      readonly outputBytes: number;
      readonly droppedOutputBytes: number;
    }>();
    expectTypeOf<HostTerminalCommandBlock>().toEqualTypeOf<{
      readonly id: string;
      readonly kind: "command";
      readonly cwd: string;
      readonly command: string;
      readonly status: "running" | "exited";
      readonly exitCode?: number;
      readonly output: string;
      readonly outputBytes: number;
      readonly droppedOutputBytes: number;
    }>();
    expectTypeOf<keyof HostTerminalBlockState>().toEqualTypeOf<
      | "blocks"
      | "currentCwd"
      | "mode"
      | "activePromptBlockId"
      | "activeCommandBlockId"
      | "droppedBlocks"
      | "nextBlockNumber"
      | "maxBlockOutputBytes"
      | "maxBlocks"
    >();
    expectTypeOf<TerminalOutputPolicyDecision>().toEqualTypeOf<{
      readonly type: "osc";
      readonly command: number | null;
      readonly recommendedAction: "allow" | "suppress";
      readonly reason:
        | "terminal-control"
        | "clipboard"
        | "notification"
        | "proprietary-host-integration"
        | "private-shell-integration"
        | "incomplete"
        | "oversized";
    }>();
  });

  it("validates representative host-to-surface requests", () => {
    const ready: TerminalSurfaceRequest = {
      type: "terminal-view/ready",
      protocolVersion: TERMINAL_SURFACE_PROTOCOL_VERSION,
    };
    const resize: TerminalSurfaceRequest = {
      type: "host-terminal/resize",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      rendererEpoch: "renderer-1",
      dimensions: { columns: MAX_TERMINAL_DIMENSION, rows: 24 },
    };

    expect(isTerminalSurfaceRequest(ready)).toBe(true);
    expect(isTerminalSurfaceRequest(resize)).toBe(true);
    expect(
      isTerminalSurfaceRequest({
        ...resize,
        dimensions: { columns: MAX_TERMINAL_DIMENSION + 1, rows: 24 },
      }),
    ).toBe(false);
  });

  it("keeps replay events serializable for browser/webview transport", () => {
    const batch: HostTerminalRenderBatch = {
      type: "terminal-view/render-batch",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      sequence: 1,
      operations: [
        { type: "write", data: "ready" },
        {
          type: "alternate-screen",
          transition: { type: "enter", modes: [1049] },
        },
      ],
      droppedRenderBytes: 0,
      replayTruncated: false,
      replayPendingControl: false,
      suppressedOutputCharacters: 0,
      outputPolicyDecisions: [],
    };
    const event: TerminalSurfaceEvent = batch;

    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });
});
