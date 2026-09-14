import { afterEach, describe, expect, it, vi } from "vitest";

import { EventEmitter } from "node:events";
import { ManagedTypeScriptService } from "./managedTypeScriptService.js";
import type { ManagedTypeScriptStatus } from "./managedTypeScriptInstaller.js";
import { PassThrough } from "node:stream";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const roots: string[] = [];

class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly received: Array<Record<string, unknown>> = [];
  #buffer = Buffer.alloc(0);

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.#accept(chunk));
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signalCode = signal;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }

  notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  request(id: number, method: string, params: unknown): void {
    this.#send({ jsonrpc: "2.0", id, method, params });
  }

  #accept(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const separator = this.#buffer.indexOf("\r\n\r\n");
      if (separator === -1) return;
      const header = this.#buffer.subarray(0, separator).toString("ascii");
      const match = /Content-Length:\s*(\d+)/iu.exec(header);
      if (!match) throw new Error("Missing content length");
      const length = Number(match[1]);
      const end = separator + 4 + length;
      if (this.#buffer.length < end) return;
      const message = JSON.parse(
        this.#buffer.subarray(separator + 4, end).toString("utf8"),
      ) as Record<string, unknown>;
      this.#buffer = this.#buffer.subarray(end);
      this.received.push(message);
      const id = message.id;
      const method = message.method;
      if (id !== undefined && method === "initialize") {
        this.#send({
          jsonrpc: "2.0",
          id,
          result: { capabilities: { positionEncoding: "utf-16" } },
        });
      } else if (id !== undefined && method === "shutdown") {
        this.#send({ jsonrpc: "2.0", id, result: null });
      } else if (id !== undefined && typeof method === "string") {
        this.#send({ jsonrpc: "2.0", id, result: [] });
      } else if (method === "exit") {
        this.exitCode = 0;
        queueMicrotask(() => this.emit("exit", 0, null));
      }
    }
  }

  #send(message: unknown): void {
    const bytes = Buffer.from(JSON.stringify(message));
    this.stdout.write(`Content-Length: ${bytes.length}\r\n\r\n`);
    this.stdout.write(bytes);
  }
}

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "managed-typescript-service-"),
  );
  roots.push(root);
  const projectRoot = path.join(root, "project");
  const dataRoot = path.join(root, "data");
  const installationRoot = path.join(root, "installation");
  const languageServerModule = path.join(installationRoot, "cli.mjs");
  const tsserverPath = path.join(installationRoot, "tsserver.js");
  await fs.mkdir(projectRoot);
  await fs.mkdir(installationRoot);
  await fs.writeFile(languageServerModule, "// fixture\n");
  await fs.writeFile(tsserverPath, "// fixture\n");
  const source = path.join(projectRoot, "index.ts");
  await fs.writeFile(source, "export const value: string = 42;\n");
  const installation: ManagedTypeScriptStatus = {
    state: "ready",
    recipe: {
      id: "fixture",
      languageServer: {
        name: "typescript-language-server",
        version: "5.3.0",
        url: "https://registry.npmjs.org/fixture",
        integrity: "sha512-fixture",
      },
      typescript: {
        name: "typescript",
        version: "5.9.3",
        url: "https://registry.npmjs.org/fixture",
        integrity: "sha512-fixture",
      },
    },
    installedAt: "2026-01-01T00:00:00.000Z",
    installationRoot,
    languageServerModule,
    tsserverPath,
    licenses: [],
  };
  const processes: FakeProcess[] = [];
  const spawnProcess = vi.fn(() => {
    const process = new FakeProcess();
    processes.push(process);
    return process as never;
  });
  const service = new ManagedTypeScriptService({
    projectRoot,
    dataRoot,
    diagnosticWaitMs: 100,
    requestTimeoutMs: 100,
    resolveInstallation: async () => installation,
    spawnProcess: spawnProcess as never,
  });
  return { service, source, processes, spawnProcess };
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("ManagedTypeScriptService", () => {
  it("starts lazily, reports stale diagnostics without claiming zero, and synchronizes edits", async () => {
    const test = await fixture();
    expect(test.spawnProcess).not.toHaveBeenCalled();

    const first = await test.service.diagnostics("index.ts");
    expect(first).toMatchObject({
      state: "stale",
      reason: expect.stringContaining("freshness deadline"),
      metadata: { documentVersion: 1 },
    });
    expect(test.spawnProcess).toHaveBeenCalledTimes(1);
    expect(
      test.processes[0]?.received.find(
        (message) => message.method === "initialize",
      ),
    ).toMatchObject({
      params: {
        initializationOptions: {
          disableAutomaticTypingAcquisition: true,
          plugins: [],
        },
      },
    });

    await fs.writeFile(test.source, "export const value = 'fixed';\n");
    await test.service.synchronizeFile("index.ts");
    expect(
      test.processes[0]?.received.some(
        (message) => message.method === "textDocument/didChange",
      ),
    ).toBe(true);
    const query = test.service.diagnostics("index.ts");
    const open = test.processes[0]?.received.find(
      (message) => message.method === "textDocument/didOpen",
    );
    const uri = (
      open?.params as { textDocument?: { uri?: string } } | undefined
    )?.textDocument?.uri;
    expect(uri).toBeTruthy();
    test.processes[0]?.notify("textDocument/publishDiagnostics", {
      uri,
      version: 2,
      diagnostics: [],
    });
    await expect(query).resolves.toMatchObject({
      state: "ready",
      value: [],
      metadata: { documentVersion: 2 },
    });
    expect(
      test.processes[0]?.received.some(
        (message) => message.method === "workspace/didChangeWatchedFiles",
      ),
    ).toBe(true);
    await test.service.close();
  });

  it("accepts a versionless publication only after the current sync and reports the limitation", async () => {
    const test = await fixture();
    const query = test.service.diagnostics("index.ts");
    await vi.waitFor(() => {
      expect(
        test.processes[0]?.received.some(
          (message) => message.method === "textDocument/didOpen",
        ),
      ).toBe(true);
    });
    const open = test.processes[0]?.received.find(
      (message) => message.method === "textDocument/didOpen",
    );
    const uri = (
      open?.params as { textDocument?: { uri?: string } } | undefined
    )?.textDocument?.uri;
    test.processes[0]?.notify("textDocument/publishDiagnostics", {
      uri,
      diagnostics: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          message: "versionless diagnostic",
        },
      ],
    });
    await expect(query).resolves.toMatchObject({
      state: "ready",
      reason:
        "The server omitted the diagnostic document version; freshness is based on publication after the current document sync",
      value: [{ message: "versionless diagnostic" }],
    });
    await test.service.close();
  });

  it("rejects unsolicited writes and unknown server commands", async () => {
    const test = await fixture();
    await test.service.symbols("index.ts");
    const process = test.processes[0]!;
    process.request(500, "workspace/applyEdit", { edit: { changes: {} } });
    process.request(501, "workspace/executeCommand", { command: "evil" });

    await vi.waitFor(() => {
      expect(
        process.received.find((message) => message.id === 500),
      ).toMatchObject({ result: { applied: false } });
      expect(
        process.received.find((message) => message.id === 501),
      ).toMatchObject({ error: { code: -32601 } });
    });
    await test.service.close();
  });

  it("cancels requests and permits only one restart after a crash", async () => {
    const test = await fixture();
    await test.service.symbols("index.ts");
    test.processes[0]?.emit("exit", 1, null);
    await test.service.symbols("index.ts");
    expect(test.spawnProcess).toHaveBeenCalledTimes(2);
    test.processes[1]?.emit("exit", 1, null);
    await expect(test.service.symbols("index.ts")).resolves.toMatchObject({
      state: "failed",
      retryable: false,
    });
    expect(test.spawnProcess).toHaveBeenCalledTimes(2);

    const cancelled = await fixture();
    const controller = new AbortController();
    controller.abort("cancelled by test");
    await expect(
      cancelled.service.hover(
        "index.ts",
        { line: 0, character: 1 },
        controller.signal,
      ),
    ).resolves.toMatchObject({
      state: "failed",
      reason: "language_server_request_cancelled",
    });
    await cancelled.service.close();
  });
});
