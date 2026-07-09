import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";

import type {
  ActiveSessionMessage,
  ClientCapabilities,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
} from "@agentclientprotocol/sdk" with { "resolution-mode": "import" };

import type { AcpBackgroundAgentConfig } from "./acpAgentConfig.js";

const POST_COMPLETION_EXIT_GRACE_MS = 1_000;

export type AcpBackgroundRunnerEvent =
  | { type: "update"; update: SessionUpdate }
  | { type: "stop"; response: PromptResponse }
  | { type: "stderr"; text: string };

export interface AcpBackgroundRunRequest {
  agent: AcpBackgroundAgentConfig;
  cwd: string;
  additionalDirectories: string[];
  prompt: string;
  signal?: AbortSignal;
  onEvent(event: AcpBackgroundRunnerEvent): void;
  onRequestPermission?: (
    request: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse>;
}

export interface AcpBackgroundRunner {
  run(request: AcpBackgroundRunRequest): Promise<void>;
}

function nodeReadableToWeb(stream: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}

function nodeWritableToWeb(stream: Writable): WritableStream<Uint8Array> {
  return Writable.toWeb(stream) as WritableStream<Uint8Array>;
}

function createReadonlyClientCapabilities(): ClientCapabilities {
  return {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  };
}

function messageIsStop(
  message: ActiveSessionMessage,
): message is Extract<ActiveSessionMessage, { kind: "stop" }> {
  return message.kind === "stop";
}

function spawnAcpProcess(
  agent: AcpBackgroundAgentConfig,
  cwd: string,
): ChildProcessWithoutNullStreams {
  return spawn(agent.command, agent.args, {
    cwd,
    env: { ...process.env, ...agent.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export class StdioAcpBackgroundRunner implements AcpBackgroundRunner {
  async run(request: AcpBackgroundRunRequest): Promise<void> {
    const child = spawnAcpProcess(request.agent, request.cwd);
    const { client, methods, ndJsonStream, PROTOCOL_VERSION } =
      await import("@agentclientprotocol/sdk");
    const stream = ndJsonStream(
      nodeWritableToWeb(child.stdin),
      nodeReadableToWeb(child.stdout),
    );
    const app = client({ name: "AgentLink" }).onRequest(
      methods.client.session.requestPermission,
      async ({ params }) => {
        if (request.signal?.aborted) {
          return { outcome: { outcome: "cancelled" } };
        }
        return request.onRequestPermission
          ? request.onRequestPermission(params)
          : { outcome: { outcome: "cancelled" } };
      },
    );

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      request.onEvent({ type: "stderr", text: chunk });
    });

    let protocolCompleted = false;
    const exitPromise = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (request.signal?.aborted || protocolCompleted || code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            `ACP agent process exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}`,
          ),
        );
      });
    });
    void exitPromise.catch(() => undefined);

    const killOnAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore process cleanup races.
      }
    };
    request.signal?.addEventListener("abort", killOnAbort, { once: true });

    try {
      await app.connectWith(stream, async (ctx) => {
        await this.withTimeout(
          ctx.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: createReadonlyClientCapabilities(),
            clientInfo: { name: "AgentLink" },
          }),
          request.agent.initTimeoutMs,
          "ACP agent initialize timed out",
        );

        const builder = ctx.buildSession({
          cwd: request.cwd,
          additionalDirectories: request.additionalDirectories,
          mcpServers: [],
        });
        const session = await this.withTimeout(
          builder.start({
            cancellationSignal: request.signal,
          }),
          request.agent.initTimeoutMs,
          "ACP agent session start timed out",
        );
        try {
          const promptPromise = session.prompt(request.prompt, {
            cancellationSignal: request.signal,
          });
          while (true) {
            const message = await session.nextUpdate();
            if (messageIsStop(message)) {
              request.onEvent({ type: "stop", response: message.response });
              break;
            }
            request.onEvent({ type: "update", update: message.update });
          }
          await promptPromise;
        } finally {
          session.dispose();
        }
      });
      protocolCompleted = true;
      await this.terminateAfterCompletion(child, exitPromise);
    } finally {
      request.signal?.removeEventListener("abort", killOnAbort);
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    }
  }

  private async terminateAfterCompletion(
    child: ChildProcessWithoutNullStreams,
    exitPromise: Promise<void>,
  ): Promise<void> {
    child.kill("SIGTERM");
    const exited = await Promise.race([
      exitPromise.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), POST_COMPLETION_EXIT_GRACE_MS),
      ),
    ]);
    if (!exited) {
      child.kill("SIGKILL");
      await exitPromise;
    }
  }

  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  }
}
