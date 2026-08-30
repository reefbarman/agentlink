import { EMPTY_HOST_TERMINAL_STATE } from "@agentlink/protocol/terminal";
import {
  TERMINAL_SURFACE_PROTOCOL_VERSION,
  type TerminalSurfaceConfiguration,
  type TerminalSurfaceEvent,
  type TerminalSurfaceRequest,
} from "./terminalSurfaceProtocol.js";

export interface HostTerminalSurfaceConnection {
  readonly generation: number;
  readonly rendererEpoch: string;
  postMessage(event: TerminalSurfaceEvent): PromiseLike<boolean>;
}

export interface HostTerminalSurfaceController {
  attach(
    postMessage: HostTerminalSurfaceConnection["postMessage"],
  ): HostTerminalSurfaceConnection;
  detach(connection: HostTerminalSurfaceConnection): void;
  handleRequest(
    connection: HostTerminalSurfaceConnection,
    request: TerminalSurfaceRequest,
  ): Promise<void>;
}

export interface InertHostTerminalSurfaceControllerOptions {
  configuration?: TerminalSurfaceConfiguration;
  createRendererEpoch?: () => string;
  isAcceptingRequests(): boolean;
}

const DEFAULT_CONFIGURATION: TerminalSurfaceConfiguration = {
  scrollback: 1000,
};

export function createInertHostTerminalSurfaceController(
  options: InertHostTerminalSurfaceControllerOptions,
): HostTerminalSurfaceController {
  let nextGeneration = 1;
  const connections = new Set<HostTerminalSurfaceConnection>();
  const createRendererEpoch =
    options.createRendererEpoch ??
    (() => `terminal-renderer-${nextGeneration}`);

  return {
    attach(postMessage) {
      const generation = nextGeneration++;
      const connection: HostTerminalSurfaceConnection = {
        generation,
        rendererEpoch: createRendererEpoch(),
        postMessage,
      };
      connections.add(connection);
      return connection;
    },

    detach(connection) {
      connections.delete(connection);
    },

    async handleRequest(connection, request) {
      if (!connections.has(connection) || !options.isAcceptingRequests())
        return;

      if (request.type === "terminal-view/ready") {
        await connection.postMessage({
          type: "terminal-view/bootstrap",
          protocolVersion: TERMINAL_SURFACE_PROTOCOL_VERSION,
          rendererEpoch: connection.rendererEpoch,
          state: EMPTY_HOST_TERMINAL_STATE,
          configuration: options.configuration ?? DEFAULT_CONFIGURATION,
          replay: [],
        });
        return;
      }

      if (request.type === "host-terminal/create") {
        await connection.postMessage({
          type: "host-terminal/error",
          requestId: request.requestId,
          message:
            "Terminal rendering is not available until the Phase 1 renderer is installed.",
        });
      }
    },
  };
}
