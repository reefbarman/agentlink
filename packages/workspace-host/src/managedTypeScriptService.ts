import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  getManagedTypeScriptStatus,
  type ManagedTypeScriptStatus,
} from "./managedTypeScriptInstaller.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const DIAGNOSTIC_WAIT_MS = 2_500;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_LOG_ENTRIES = 100;
const MAX_RESULT_ITEMS = 200;
const MAX_RESTARTS = 1;

type JsonRpcId = number | string;
interface JsonRpcMessage {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
  readonly abort?: () => void;
}

interface OpenDocument {
  readonly path: string;
  readonly uri: string;
  version: number;
  hash: string;
  languageId: string;
}

export interface ManagedTypeScriptPosition {
  readonly line: number;
  readonly character: number;
}

export interface ManagedTypeScriptLocation {
  readonly uri: string;
  readonly range: {
    readonly start: ManagedTypeScriptPosition;
    readonly end: ManagedTypeScriptPosition;
  };
}

export interface ManagedTypeScriptDiagnostic {
  readonly range: ManagedTypeScriptLocation["range"];
  readonly severity?: number;
  readonly code?: string | number;
  readonly source?: string;
  readonly message: string;
}

export interface ManagedTypeScriptQueryMetadata {
  readonly provider: "typescript-language-server";
  readonly serverVersion: string;
  readonly typescriptVersion: string;
  readonly positionEncoding: "utf-16";
  readonly projectRoot: string;
  readonly readiness: "ready" | "stale";
  readonly coverage: "project";
  readonly documentVersion: number;
  readonly documentHash: string;
}

export type ManagedTypeScriptQueryResult<T> =
  | {
      readonly state: "unavailable" | "warming" | "failed";
      readonly reason: string;
      readonly retryable: boolean;
    }
  | {
      readonly state: "ready" | "stale";
      readonly value: T;
      readonly metadata: ManagedTypeScriptQueryMetadata;
      readonly reason?: string;
    };

export interface ManagedTypeScriptServiceStatus {
  readonly state: "unavailable" | "idle" | "warming" | "ready" | "failed";
  readonly reason?: string;
  readonly restarts: number;
  readonly logs: readonly string[];
  readonly installation: ManagedTypeScriptStatus;
}

export interface CreateManagedTypeScriptServiceOptions {
  readonly projectRoot: string;
  readonly dataRoot: string;
  readonly requestTimeoutMs?: number;
  readonly diagnosticWaitMs?: number;
  readonly spawnProcess?: typeof spawn;
  readonly resolveInstallation?: () => Promise<ManagedTypeScriptStatus>;
  readonly log?: (message: string) => void;
}

export class ManagedTypeScriptService {
  readonly #projectRoot: string;
  readonly #dataRoot: string;
  readonly #requestTimeoutMs: number;
  readonly #spawnProcess: typeof spawn;
  readonly #resolveInstallation: () => Promise<ManagedTypeScriptStatus>;
  readonly #diagnosticWaitMs: number;
  readonly #externalLog?: (message: string) => void;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #documents = new Map<string, OpenDocument>();
  readonly #diagnostics = new Map<
    string,
    {
      readonly version?: number;
      readonly diagnostics: readonly ManagedTypeScriptDiagnostic[];
    }
  >();
  readonly #diagnosticWaiters = new Map<string, Set<() => void>>();
  readonly #logs: string[] = [];
  #documentSyncQueue: Promise<void> = Promise.resolve();
  #installation?: ManagedTypeScriptStatus;
  #process?: ChildProcessWithoutNullStreams;
  #startPromise?: Promise<void>;
  #buffer = Buffer.alloc(0);
  #generation = 0;
  #nextRequestId = 1;
  #state: ManagedTypeScriptServiceStatus["state"] = "idle";
  #failureReason?: string;
  #positionEncoding = "utf-16" as const;
  #restarts = 0;
  #closing = false;

  constructor(options: CreateManagedTypeScriptServiceOptions) {
    if (
      !path.isAbsolute(options.projectRoot) ||
      !path.isAbsolute(options.dataRoot)
    ) {
      throw new Error("Managed TypeScript service requires absolute roots");
    }
    this.#projectRoot = path.resolve(options.projectRoot);
    this.#dataRoot = path.resolve(options.dataRoot);
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#spawnProcess = options.spawnProcess ?? spawn;
    this.#resolveInstallation =
      options.resolveInstallation ??
      (() => getManagedTypeScriptStatus(this.#dataRoot));
    this.#diagnosticWaitMs = options.diagnosticWaitMs ?? DIAGNOSTIC_WAIT_MS;
    this.#externalLog = options.log;
  }

  async status(): Promise<ManagedTypeScriptServiceStatus> {
    const installation =
      this.#installation ??
      (await this.#resolveInstallation().catch((error) => ({
        state: "corrupt" as const,
        recipe: {
          id: "unknown",
          languageServer: {
            name: "typescript-language-server" as const,
            version: "unknown",
            url: "https://registry.npmjs.org/",
            integrity: "sha512-unknown" as const,
          },
          typescript: {
            name: "typescript" as const,
            version: "unknown",
            url: "https://registry.npmjs.org/",
            integrity: "sha512-unknown" as const,
          },
        },
        reason: errorMessage(error),
      })));
    const state =
      installation.state !== "ready"
        ? "unavailable"
        : this.#state === "idle"
          ? "idle"
          : this.#state;
    return {
      state,
      ...(this.#failureReason ? { reason: this.#failureReason } : {}),
      restarts: this.#restarts,
      logs: [...this.#logs],
      installation,
    };
  }

  async diagnostics(
    filePath: string,
    signal?: AbortSignal,
  ): Promise<
    ManagedTypeScriptQueryResult<readonly ManagedTypeScriptDiagnostic[]>
  > {
    const prepared = await this.#prepareDocument(filePath, signal);
    if ("state" in prepared) return prepared;
    const published = await this.#waitForDiagnostics(
      prepared.document.uri,
      prepared.document.version,
      signal,
    );
    const current = this.#diagnostics.get(prepared.document.uri);
    if (!current) {
      return this.#queryResult(
        prepared.document,
        [],
        "stale",
        "No diagnostic publication arrived before the freshness deadline",
      );
    }
    const fresh =
      published &&
      (current.version === undefined ||
        current.version === prepared.document.version);
    return this.#queryResult(
      prepared.document,
      current.diagnostics,
      fresh ? "ready" : "stale",
      current.version === undefined
        ? "The server omitted the diagnostic document version; freshness is based on publication after the current document sync"
        : "No matching diagnostic publication arrived before the freshness deadline",
    );
  }

  async symbols(
    filePath: string,
    signal?: AbortSignal,
  ): Promise<ManagedTypeScriptQueryResult<unknown>> {
    return await this.#documentRequest(
      filePath,
      "textDocument/documentSymbol",
      (document) => ({ textDocument: { uri: document.uri } }),
      signal,
    );
  }

  async definition(
    filePath: string,
    position: ManagedTypeScriptPosition,
    signal?: AbortSignal,
  ): Promise<ManagedTypeScriptQueryResult<unknown>> {
    return await this.#documentRequest(
      filePath,
      "textDocument/definition",
      (document) => ({ textDocument: { uri: document.uri }, position }),
      signal,
    );
  }

  async references(
    filePath: string,
    position: ManagedTypeScriptPosition,
    includeDeclaration: boolean,
    signal?: AbortSignal,
  ): Promise<ManagedTypeScriptQueryResult<unknown>> {
    return await this.#documentRequest(
      filePath,
      "textDocument/references",
      (document) => ({
        textDocument: { uri: document.uri },
        position,
        context: { includeDeclaration },
      }),
      signal,
    );
  }

  async hover(
    filePath: string,
    position: ManagedTypeScriptPosition,
    signal?: AbortSignal,
  ): Promise<ManagedTypeScriptQueryResult<unknown>> {
    return await this.#documentRequest(
      filePath,
      "textDocument/hover",
      (document) => ({ textDocument: { uri: document.uri }, position }),
      signal,
    );
  }

  async synchronizeFile(filePath: string, signal?: AbortSignal): Promise<void> {
    if (
      !this.#process ||
      this.#state !== "ready" ||
      !isTypeScriptLike(filePath)
    ) {
      return;
    }
    const resolved = await this.#resolveProjectFile(filePath);
    if (!resolved.ok) return;
    await this.#withDocumentSync(
      () => this.#synchronizeResolvedDocument(resolved.path),
      signal,
    );
  }

  async close(): Promise<void> {
    this.#closing = true;
    const child = this.#process;
    if (!child) return;
    try {
      for (const document of this.#documents.values()) {
        this.#notify("textDocument/didClose", {
          textDocument: { uri: document.uri },
        });
      }
      await this.#request("shutdown", null, undefined, 2_000);
      this.#notify("exit", null);
    } catch {
      child.kill("SIGTERM");
    }
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
          resolve();
        }, 2_000),
      ),
    ]);
    this.#process = undefined;
    this.#state = "idle";
  }

  async #documentRequest(
    filePath: string,
    method: string,
    params: (document: OpenDocument) => unknown,
    signal?: AbortSignal,
  ): Promise<ManagedTypeScriptQueryResult<unknown>> {
    const prepared = await this.#prepareDocument(filePath, signal);
    if ("state" in prepared) return prepared;
    try {
      const value = boundResult(
        await this.#request(method, params(prepared.document), signal),
      );
      return this.#queryResult(prepared.document, value, "ready");
    } catch (error) {
      return {
        state: "failed",
        reason: errorMessage(error),
        retryable: this.#restarts < MAX_RESTARTS,
      };
    }
  }

  async #prepareDocument(
    filePath: string,
    signal?: AbortSignal,
  ): Promise<
    { readonly document: OpenDocument } | ManagedTypeScriptQueryResult<never>
  > {
    const resolved = await this.#resolveProjectFile(filePath);
    if (!resolved.ok) {
      return { state: "failed", reason: resolved.reason, retryable: false };
    }
    try {
      await this.#ensureStarted(signal);
    } catch (error) {
      const status = await this.status();
      return {
        state: status.state === "unavailable" ? "unavailable" : "failed",
        reason:
          status.state === "unavailable"
            ? (status.reason ?? errorMessage(error))
            : errorMessage(error),
        retryable:
          status.state !== "unavailable" && this.#restarts < MAX_RESTARTS,
      };
    }
    try {
      const document = await this.#withDocumentSync(
        () => this.#synchronizeResolvedDocument(resolved.path),
        signal,
      );
      return { document };
    } catch (error) {
      return {
        state: "failed",
        reason: signal?.aborted
          ? "language_server_request_cancelled"
          : errorCode(error),
        retryable: !signal?.aborted,
      };
    }
  }

  async #synchronizeResolvedDocument(filePath: string): Promise<OpenDocument> {
    const content = await fs.readFile(filePath, "utf8");
    const hash = createHash("sha256").update(content).digest("hex");
    let document = this.#documents.get(filePath);
    if (!document) {
      document = {
        path: filePath,
        uri: pathToFileURL(filePath).href,
        version: 1,
        hash,
        languageId: languageId(filePath),
      };
      this.#documents.set(filePath, document);
      this.#notify("textDocument/didOpen", {
        textDocument: {
          uri: document.uri,
          languageId: document.languageId,
          version: document.version,
          text: content,
        },
      });
    } else if (document.hash !== hash) {
      document.version += 1;
      document.hash = hash;
      this.#diagnostics.delete(document.uri);
      this.#notify("textDocument/didChange", {
        textDocument: { uri: document.uri, version: document.version },
        contentChanges: [{ text: content }],
      });
      this.#notify("workspace/didChangeWatchedFiles", {
        changes: [{ uri: document.uri, type: 2 }],
      });
    }
    return document;
  }

  async #withDocumentSync<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const previous = this.#documentSyncQueue;
    let release!: () => void;
    this.#documentSyncQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (signal?.aborted) throw abortError(signal);
      return await operation();
    } finally {
      release();
    }
  }

  async #ensureStarted(signal?: AbortSignal): Promise<void> {
    if (this.#process && this.#state === "ready") return;
    if (this.#startPromise) return await this.#startPromise;
    if (this.#state === "failed") {
      if (this.#restarts >= MAX_RESTARTS) {
        throw new Error(
          this.#failureReason ?? "language_server_restart_exhausted",
        );
      }
      this.#restarts += 1;
    }
    this.#startPromise = this.#start(signal).finally(() => {
      this.#startPromise = undefined;
    });
    return await this.#startPromise;
  }

  async #start(signal?: AbortSignal): Promise<void> {
    this.#closing = false;
    this.#state = "warming";
    this.#failureReason = undefined;
    const installation = await this.#resolveInstallation();
    this.#installation = installation;
    if (installation.state !== "ready") {
      this.#state = "unavailable";
      this.#failureReason =
        installation.state === "corrupt"
          ? `Managed installation is corrupt: ${installation.reason}`
          : "TypeScript intelligence is not installed";
      throw new Error(this.#failureReason);
    }
    const generation = ++this.#generation;
    const child = this.#spawnProcess(
      process.execPath,
      [installation.languageServerModule, "--stdio", "--log-level", "2"],
      {
        cwd: this.#projectRoot,
        env: minimalEnvironment(process.env),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.#process = child;
    this.#buffer = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => this.#acceptBytes(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.#log(String(chunk)));
    child.once("error", (error) =>
      this.#handleExit(`spawn_error:${error.message}`, generation),
    );
    child.once("exit", (code, exitSignal) =>
      this.#handleExit(
        `server_exit:${code ?? exitSignal ?? "unknown"}`,
        generation,
      ),
    );
    try {
      const initialize = await this.#request(
        "initialize",
        {
          processId: process.pid,
          clientInfo: { name: "AgentLink CLI", version: "0.1" },
          rootUri: pathToFileURL(this.#projectRoot).href,
          workspaceFolders: [
            {
              uri: pathToFileURL(this.#projectRoot).href,
              name: path.basename(this.#projectRoot),
            },
          ],
          capabilities: {
            general: { positionEncodings: ["utf-16"] },
            workspace: { configuration: true, workspaceFolders: true },
            textDocument: {
              synchronization: { dynamicRegistration: false, didSave: true },
              publishDiagnostics: {
                relatedInformation: true,
                versionSupport: true,
                codeDescriptionSupport: true,
              },
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              definition: { linkSupport: true },
              hover: { contentFormat: ["markdown", "plaintext"] },
            },
          },
          initializationOptions: {
            hostInfo: "AgentLink CLI",
            disableAutomaticTypingAcquisition: true,
            plugins: [],
            tsserver: { path: installation.tsserverPath },
            preferences: { includePackageJsonAutoImports: "off" },
          },
        },
        signal,
        this.#requestTimeoutMs,
      );
      const encoding = readPositionEncoding(initialize);
      if (encoding !== undefined && encoding !== "utf-16") {
        throw new Error(`unsupported_position_encoding:${encoding}`);
      }
      this.#positionEncoding = "utf-16";
      this.#notify("initialized", {});
      this.#notify("workspace/didChangeConfiguration", {
        settings: {
          typescript: {
            tsserver: { path: installation.tsserverPath },
            preferences: { includePackageJsonAutoImports: "off" },
          },
          javascript: {
            preferences: { includePackageJsonAutoImports: "off" },
          },
        },
      });
      this.#state = "ready";
    } catch (error) {
      child.kill("SIGKILL");
      this.#handleExit(
        `language_server_initialize_failed:${errorMessage(error)}`,
        generation,
      );
      throw error;
    }
  }

  #request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<unknown> {
    if (!this.#process)
      return Promise.reject(new Error("language_server_not_running"));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const id = this.#nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        this.#tryNotify("$/cancelRequest", { id });
        reject(new Error(`language_server_timeout:${method}`));
      }, timeoutMs);
      const abort = signal
        ? () => {
            clearTimeout(timeout);
            this.#pending.delete(id);
            this.#tryNotify("$/cancelRequest", { id });
            reject(abortError(signal));
          }
        : undefined;
      signal?.addEventListener("abort", abort!, { once: true });
      this.#pending.set(id, {
        method,
        resolve: (value) => {
          signal?.removeEventListener("abort", abort!);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort!);
          reject(error);
        },
        timeout,
        ...(abort ? { abort } : {}),
      });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  #notify(method: string, params: unknown): void {
    if (!this.#process) return;
    this.#send({ jsonrpc: "2.0", method, params });
  }

  #tryNotify(method: string, params: unknown): void {
    try {
      this.#notify(method, params);
    } catch (error) {
      this.#log(`Could not send ${method}: ${errorMessage(error)}`);
    }
  }

  #send(message: JsonRpcMessage): void {
    const child = this.#process;
    if (!child || child.stdin.destroyed)
      throw new Error("language_server_not_running");
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > MAX_MESSAGE_BYTES)
      throw new Error("language_server_message_too_large");
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  }

  #acceptBytes(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length > MAX_MESSAGE_BYTES * 2) {
      this.#handleExit("language_server_buffer_overflow", this.#generation);
      this.#process?.kill("SIGKILL");
      return;
    }
    for (;;) {
      const separator = this.#buffer.indexOf("\r\n\r\n");
      if (separator === -1) return;
      const header = this.#buffer.subarray(0, separator).toString("ascii");
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/iu.exec(
        header,
      );
      if (!match) {
        this.#handleExit("language_server_invalid_header", this.#generation);
        this.#process?.kill("SIGKILL");
        return;
      }
      const length = Number(match[1]);
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_MESSAGE_BYTES
      ) {
        this.#handleExit(
          "language_server_invalid_content_length",
          this.#generation,
        );
        this.#process?.kill("SIGKILL");
        return;
      }
      const messageEnd = separator + 4 + length;
      if (this.#buffer.length < messageEnd) return;
      const body = this.#buffer.subarray(separator + 4, messageEnd);
      this.#buffer = this.#buffer.subarray(messageEnd);
      try {
        this.#handleMessage(JSON.parse(body.toString("utf8")) as unknown);
      } catch (error) {
        this.#log(`Invalid language-server message: ${errorMessage(error)}`);
      }
    }
  }

  #handleMessage(value: unknown): void {
    if (!isRecord(value) || value.jsonrpc !== "2.0") {
      throw new Error("invalid_json_rpc_message");
    }
    const message = value as unknown as JsonRpcMessage;
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(
          new Error(
            `language_server_error:${pending.method}:${message.error.code ?? "unknown"}:${message.error.message ?? "unknown"}`,
          ),
        );
      } else pending.resolve(message.result);
      return;
    }
    if (message.method && message.id !== undefined) {
      this.#handleServerRequest(message);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") {
      this.#handleDiagnostics(message.params);
    } else if (
      message.method === "window/logMessage" ||
      message.method === "window/showMessage" ||
      message.method === "telemetry/event"
    ) {
      this.#log(JSON.stringify(boundResult(message.params)));
    }
  }

  #handleServerRequest(message: JsonRpcMessage): void {
    if (message.method === "workspace/configuration") {
      const items =
        isRecord(message.params) && Array.isArray(message.params.items)
          ? message.params.items
          : [];
      this.#send({
        jsonrpc: "2.0",
        id: message.id,
        result: items.map(() => ({})),
      });
      return;
    }
    if (message.method === "workspace/applyEdit") {
      this.#send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          applied: false,
          failureReason: "AgentLink rejects unsolicited language-server writes",
        },
      });
      this.#log("Rejected unsolicited workspace/applyEdit request");
      return;
    }
    if (
      message.method === "client/registerCapability" ||
      message.method === "client/unregisterCapability" ||
      message.method === "window/workDoneProgress/create"
    ) {
      this.#send({ jsonrpc: "2.0", id: message.id, result: null });
      return;
    }
    this.#send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not supported by AgentLink" },
    });
  }

  #handleDiagnostics(params: unknown): void {
    if (!isRecord(params) || typeof params.uri !== "string") return;
    const diagnostics = Array.isArray(params.diagnostics)
      ? params.diagnostics
          .filter(isDiagnostic)
          .slice(0, MAX_RESULT_ITEMS)
          .map((diagnostic) => ({
            range: diagnostic.range,
            ...(typeof diagnostic.severity === "number"
              ? { severity: diagnostic.severity }
              : {}),
            ...(typeof diagnostic.code === "string" ||
            typeof diagnostic.code === "number"
              ? { code: diagnostic.code }
              : {}),
            ...(typeof diagnostic.source === "string"
              ? { source: diagnostic.source }
              : {}),
            message: diagnostic.message.slice(0, 8_000),
          }))
      : [];
    this.#diagnostics.set(params.uri, {
      ...(typeof params.version === "number"
        ? { version: params.version }
        : {}),
      diagnostics,
    });
    for (const wake of this.#diagnosticWaiters.get(params.uri) ?? []) wake();
    this.#diagnosticWaiters.delete(params.uri);
  }

  async #waitForDiagnostics(
    uri: string,
    version: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const current = this.#diagnostics.get(uri);
    if (
      current &&
      (current.version === undefined || current.version === version)
    ) {
      return true;
    }
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", aborted);
        waiters.delete(check);
        if (waiters.size === 0) this.#diagnosticWaiters.delete(uri);
        resolve(value);
      };
      const check = () => {
        const diagnostic = this.#diagnostics.get(uri);
        if (
          diagnostic &&
          (diagnostic.version === undefined || diagnostic.version === version)
        ) {
          finish(true);
        }
      };
      const aborted = () => finish(false);
      const timeout = setTimeout(() => finish(false), this.#diagnosticWaitMs);
      const waiters = this.#diagnosticWaiters.get(uri) ?? new Set<() => void>();
      waiters.add(check);
      this.#diagnosticWaiters.set(uri, waiters);
      signal?.addEventListener("abort", aborted, { once: true });
      check();
    });
  }

  #queryResult<T>(
    document: OpenDocument,
    value: T,
    state: "ready" | "stale",
    reason?: string,
  ): ManagedTypeScriptQueryResult<T> {
    const installation = this.#installation;
    if (!installation || installation.state !== "ready") {
      return {
        state: "failed",
        reason: "Managed installation changed during query",
        retryable: true,
      };
    }
    return {
      state,
      value,
      metadata: {
        provider: "typescript-language-server",
        serverVersion: installation.recipe.languageServer.version,
        typescriptVersion: installation.recipe.typescript.version,
        positionEncoding: this.#positionEncoding,
        projectRoot: ".",
        readiness: state,
        coverage: "project",
        documentVersion: document.version,
        documentHash: document.hash,
      },
      ...(reason ? { reason } : {}),
    };
  }

  async #resolveProjectFile(
    filePath: string,
  ): Promise<
    | { readonly ok: true; readonly path: string }
    | { readonly ok: false; readonly reason: string }
  > {
    const candidate = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(this.#projectRoot, filePath);
    const relative = path.relative(this.#projectRoot, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return { ok: false, reason: "path_outside_project" };
    }
    try {
      const [root, canonical, metadata] = await Promise.all([
        fs.realpath(this.#projectRoot),
        fs.realpath(candidate),
        fs.stat(candidate),
      ]);
      const canonicalRelative = path.relative(root, canonical);
      if (
        canonicalRelative.startsWith("..") ||
        path.isAbsolute(canonicalRelative) ||
        !metadata.isFile()
      ) {
        return { ok: false, reason: "path_not_project_file" };
      }
      if (!isTypeScriptLike(canonical)) {
        return { ok: false, reason: "unsupported_language" };
      }
      return { ok: true, path: canonical };
    } catch (error) {
      return { ok: false, reason: errorCode(error) };
    }
  }

  #handleExit(reason: string, generation: number): void {
    if (this.#closing || generation !== this.#generation) return;
    this.#process = undefined;
    this.#state = "failed";
    this.#failureReason = reason;
    this.#documents.clear();
    this.#diagnostics.clear();
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
      this.#pending.delete(id);
    }
    this.#log(reason);
  }

  #log(message: string): void {
    const bounded = message
      .replaceAll(this.#projectRoot, "<project>")
      .slice(0, 4_000);
    this.#logs.push(bounded);
    if (this.#logs.length > MAX_LOG_ENTRIES) this.#logs.shift();
    this.#externalLog?.(bounded);
  }
}

function readPositionEncoding(result: unknown): string | undefined {
  if (!isRecord(result) || !isRecord(result.capabilities)) return undefined;
  return typeof result.capabilities.positionEncoding === "string"
    ? result.capabilities.positionEncoding
    : undefined;
}

function minimalEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "NO_COLOR"].flatMap((key) =>
      environment[key] === undefined ? [] : [[key, environment[key]]],
    ),
  );
}

function languageId(filePath: string): string {
  if (/\.tsx$/iu.test(filePath)) return "typescriptreact";
  if (/\.jsx$/iu.test(filePath)) return "javascriptreact";
  if (/\.(?:mts|cts|ts)$/iu.test(filePath)) return "typescript";
  return "javascript";
}

function isTypeScriptLike(filePath: string): boolean {
  return /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/iu.test(filePath);
}

function boundResult(value: unknown): unknown {
  if (Array.isArray(value))
    return value.slice(0, MAX_RESULT_ITEMS).map(boundResult);
  if (typeof value === "string") return value.slice(0, 64_000);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 200)
        .map(([key, entry]) => [key, boundResult(entry)]),
    );
  }
  return value;
}

function isDiagnostic(value: unknown): value is {
  readonly range: ManagedTypeScriptLocation["range"];
  readonly severity?: number;
  readonly code?: string | number;
  readonly source?: string;
  readonly message: string;
} {
  return (
    isRecord(value) && isRange(value.range) && typeof value.message === "string"
  );
}

function isRange(value: unknown): value is ManagedTypeScriptLocation["range"] {
  return isRecord(value) && isPosition(value.start) && isPosition(value.end);
}

function isPosition(value: unknown): value is ManagedTypeScriptPosition {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.line) &&
    Number(value.line) >= 0 &&
    Number.isSafeInteger(value.character) &&
    Number(value.character) >= 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function abortError(signal: AbortSignal): Error {
  return new Error(
    signal.reason instanceof Error
      ? signal.reason.message
      : "language_server_request_cancelled",
  );
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code?: unknown }).code);
  }
  return error instanceof Error ? error.name : "unknown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
