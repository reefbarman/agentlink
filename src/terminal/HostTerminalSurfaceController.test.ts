import { describe, expect, it, vi } from "vitest";

import { TERMINAL_SURFACE_PROTOCOL_VERSION } from "@agentlink/protocol/terminal-surface";
import { createInertHostTerminalSurfaceController } from "./HostTerminalSurfaceController.js";

describe("inert host terminal surface controller", () => {
  it("publishes an empty bootstrap only after ready", async () => {
    const postMessage = vi.fn(async () => true);
    const controller = createInertHostTerminalSurfaceController({
      isAcceptingRequests: () => true,
      createRendererEpoch: () => "renderer-1",
    });
    const connection = controller.attach(postMessage);

    expect(postMessage).not.toHaveBeenCalled();
    await controller.handleRequest(connection, {
      type: "terminal-view/ready",
      protocolVersion: TERMINAL_SURFACE_PROTOCOL_VERSION,
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: "terminal-view/bootstrap",
      protocolVersion: TERMINAL_SURFACE_PROTOCOL_VERSION,
      rendererEpoch: "renderer-1",
      state: { tabs: [] },
      configuration: { scrollback: 1000 },
      replay: [],
    });
  });

  it("returns an explicit inert error for create without invoking launch seams", async () => {
    const launch = vi.fn();
    const postMessage = vi.fn(async () => true);
    const controller = createInertHostTerminalSurfaceController({
      isAcceptingRequests: () => true,
    });
    const connection = controller.attach(postMessage);

    await controller.handleRequest(connection, {
      type: "host-terminal/create",
      requestId: "request-1",
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: "host-terminal/error",
      requestId: "request-1",
      message:
        "Terminal rendering is not available until the Phase 1 renderer is installed.",
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects detached and disabled connections without publishing", async () => {
    let accepting = true;
    const postMessage = vi.fn(async () => true);
    const controller = createInertHostTerminalSurfaceController({
      isAcceptingRequests: () => accepting,
    });
    const detached = controller.attach(postMessage);
    controller.detach(detached);
    await controller.handleRequest(detached, {
      type: "host-terminal/create",
      requestId: "detached",
    });

    const disabled = controller.attach(postMessage);
    accepting = false;
    await controller.handleRequest(disabled, {
      type: "host-terminal/create",
      requestId: "disabled",
    });

    expect(postMessage).not.toHaveBeenCalled();
  });
});
