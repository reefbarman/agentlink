import {
  MAX_TERMINAL_CWD_BYTES,
  MAX_TERMINAL_DIMENSION,
  MAX_TERMINAL_IDENTIFIER_BYTES,
  MAX_TERMINAL_INPUT_BYTES,
  MAX_TERMINAL_LINK_BYTES,
  TERMINAL_SURFACE_PROTOCOL_VERSION,
  isTerminalSurfaceRequest,
} from "./terminalSurfaceProtocol.js";
import { describe, expect, it } from "vitest";

const target = {
  terminalId: "host-terminal-1",
  terminalInstanceId: "host-instance-1",
  rendererEpoch: "renderer-1",
};

describe("terminal surface protocol", () => {
  it("accepts the exact ready and epoch-bound acknowledgment contracts", () => {
    expect(
      isTerminalSurfaceRequest({
        type: "terminal-view/ready",
        protocolVersion: TERMINAL_SURFACE_PROTOCOL_VERSION,
      }),
    ).toBe(true);
    expect(
      isTerminalSurfaceRequest({
        type: "terminal-view/output-ack",
        ...target,
        sequence: 1,
      }),
    ).toBe(true);

    expect(
      isTerminalSurfaceRequest({
        type: "terminal-view/ready",
        protocolVersion: TERMINAL_SURFACE_PROTOCOL_VERSION + 1,
      }),
    ).toBe(false);
    expect(
      isTerminalSurfaceRequest({
        type: "terminal-view/output-ack",
        terminalId: target.terminalId,
        sequence: 1,
      }),
    ).toBe(false);
    expect(
      isTerminalSurfaceRequest({
        type: "terminal-view/output-ack",
        ...target,
        sequence: 0,
      }),
    ).toBe(false);
    expect(
      isTerminalSurfaceRequest({
        type: "terminal-view/output-ack",
        ...target,
        sequence: 1,
        accepted: true,
      }),
    ).toBe(false);
  });

  it("accepts bounded create and target-bound lifecycle requests", () => {
    expect(
      isTerminalSurfaceRequest({
        type: "host-terminal/create",
        requestId: "request-1",
        cwd: "/workspace",
      }),
    ).toBe(true);
    expect(
      isTerminalSurfaceRequest({
        type: "host-terminal/write",
        ...target,
        data: "echo ready\r",
      }),
    ).toBe(true);
    expect(
      isTerminalSurfaceRequest({
        type: "host-terminal/resize",
        ...target,
        dimensions: { columns: 120, rows: 40 },
      }),
    ).toBe(true);
    expect(
      isTerminalSurfaceRequest({
        type: "host-terminal/close-intent",
        ...target,
      }),
    ).toBe(true);
    expect(
      isTerminalSurfaceRequest({
        type: "host-terminal/paste-intent",
        ...target,
      }),
    ).toBe(true);
    expect(
      isTerminalSurfaceRequest({
        type: "host-terminal/paste-intent",
        ...target,
        bracketedPasteMode: true,
      }),
    ).toBe(true);
    expect(
      isTerminalSurfaceRequest({
        type: "host-terminal/paste-intent",
        ...target,
        bracketedPasteMode: "yes",
      }),
    ).toBe(false);
    expect(
      isTerminalSurfaceRequest({
        type: "terminal-view/confirm",
        ...target,
        confirmationId: "confirmation-1",
        accept: true,
        bracketedPasteMode: false,
      }),
    ).toBe(true);
    expect(
      isTerminalSurfaceRequest({
        type: "terminal-view/confirm",
        ...target,
        confirmationId: "confirmation-1",
        accept: true,
        bracketedPasteMode: "yes",
      }),
    ).toBe(false);
    expect(
      isTerminalSurfaceRequest({ type: "host-terminal/close", ...target }),
    ).toBe(false);
    expect(
      isTerminalSurfaceRequest({
        type: "terminal-view/confirm",
        ...target,
        confirmationId: "confirmation-1",
        accept: "yes",
      }),
    ).toBe(false);
  });

  it.each([
    "copy-command",
    "copy-output",
    "copy-command-and-output",
    "rerun-command",
    "interrupt-command",
  ])("accepts the Phase 1 user action %s", (action) => {
    expect(
      isTerminalSurfaceRequest({
        type: "terminal-view/action",
        ...target,
        blockId: "host-block-1",
        action,
      }),
    ).toBe(true);
  });

  it.each(["explain-command", "fix-command", "attach-output", "write-input"])(
    "rejects the deferred or unknown action %s",
    (action) => {
      expect(
        isTerminalSurfaceRequest({
          type: "terminal-view/action",
          ...target,
          blockId: "host-block-1",
          action,
        }),
      ).toBe(false);
    },
  );

  it("bounds identifiers by UTF-8 bytes", () => {
    const within = "🙂".repeat(MAX_TERMINAL_IDENTIFIER_BYTES / 4);
    const over = `${within}a`;

    expect(
      isTerminalSurfaceRequest({
        type: "host-terminal/create",
        requestId: within,
      }),
    ).toBe(true);
    expect(
      isTerminalSurfaceRequest({
        type: "host-terminal/create",
        requestId: over,
      }),
    ).toBe(false);
  });

  it("bounds cwd, input, and links by UTF-8 bytes", () => {
    expect(
      isTerminalSurfaceRequest({
        type: "host-terminal/create",
        requestId: "request-1",
        cwd: "x".repeat(MAX_TERMINAL_CWD_BYTES),
      }),
    ).toBe(true);
    expect(
      isTerminalSurfaceRequest({
        type: "host-terminal/create",
        requestId: "request-1",
        cwd: "x".repeat(MAX_TERMINAL_CWD_BYTES + 1),
      }),
    ).toBe(false);
    expect(
      isTerminalSurfaceRequest({
        type: "host-terminal/write",
        ...target,
        data: "x".repeat(MAX_TERMINAL_INPUT_BYTES),
      }),
    ).toBe(true);
    expect(
      isTerminalSurfaceRequest({
        type: "host-terminal/write",
        ...target,
        data: "",
      }),
    ).toBe(false);
    expect(
      isTerminalSurfaceRequest({
        type: "terminal-view/open-link",
        rendererEpoch: target.rendererEpoch,
        url: "x".repeat(MAX_TERMINAL_LINK_BYTES + 1),
      }),
    ).toBe(false);
  });

  it("validates exact bounded dimensions", () => {
    expect(
      isTerminalSurfaceRequest({
        type: "host-terminal/resize",
        ...target,
        dimensions: {
          columns: MAX_TERMINAL_DIMENSION,
          rows: MAX_TERMINAL_DIMENSION,
        },
      }),
    ).toBe(true);
    for (const columns of [0, -0, 1.5, Infinity, MAX_TERMINAL_DIMENSION + 1]) {
      expect(
        isTerminalSurfaceRequest({
          type: "host-terminal/resize",
          ...target,
          dimensions: { columns, rows: 24 },
        }),
      ).toBe(false);
    }
    expect(
      isTerminalSurfaceRequest({
        type: "host-terminal/resize",
        ...target,
        dimensions: { columns: 80, rows: 24, pixels: 1 },
      }),
    ).toBe(false);
  });

  it("rejects present undefined optionals and non-record shapes", () => {
    expect(
      isTerminalSurfaceRequest({
        type: "host-terminal/create",
        requestId: "request-1",
        cwd: undefined,
      }),
    ).toBe(false);
    expect(isTerminalSurfaceRequest([])).toBe(false);
    expect(isTerminalSurfaceRequest(null)).toBe(false);
    expect(isTerminalSurfaceRequest({ type: "terminal-view/unknown" })).toBe(
      false,
    );
  });

  it("validates exact terminal-view focus change requests", () => {
    expect(
      isTerminalSurfaceRequest({
        type: "terminal-view/focus-changed",
        focused: true,
      }),
    ).toBe(true);
    expect(
      isTerminalSurfaceRequest({
        type: "terminal-view/focus-changed",
        focused: "true",
      }),
    ).toBe(false);
    expect(
      isTerminalSurfaceRequest({
        type: "terminal-view/focus-changed",
        focused: false,
        rendererEpoch: target.rendererEpoch,
      }),
    ).toBe(false);
  });

  it("validates exact renderer resynchronization requests", () => {
    expect(
      isTerminalSurfaceRequest({
        type: "terminal-view/resync",
        rendererEpoch: target.rendererEpoch,
      }),
    ).toBe(true);
    expect(
      isTerminalSurfaceRequest({
        type: "terminal-view/resync",
        rendererEpoch: target.rendererEpoch,
        terminalId: target.terminalId,
      }),
    ).toBe(false);
  });

  it("requires the current renderer epoch for links and fallback gestures", () => {
    expect(
      isTerminalSurfaceRequest({
        type: "terminal-view/open-link",
        rendererEpoch: target.rendererEpoch,
        url: "file:///etc/passwd",
      }),
    ).toBe(true);
    expect(
      isTerminalSurfaceRequest({
        type: "terminal-view/open-native-fallback",
        rendererEpoch: target.rendererEpoch,
      }),
    ).toBe(true);
    expect(
      isTerminalSurfaceRequest({
        type: "terminal-view/open-native-fallback",
      }),
    ).toBe(false);
  });
});
