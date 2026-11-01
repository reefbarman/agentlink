// Shared harness for the indexer worker process-fixture tests. The tests are
// split across several `workerFixture*.test.ts` files so Vitest can run them
// in parallel; each file bundles the worker once in its own `beforeAll`.
import { fork, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { build } from "esbuild";
import { afterAll, beforeAll, expect, onTestFinished } from "vitest";

import type {
  ExtensionToWorkerMessage,
  IndexStats,
  WorkerToExtensionMessage,
} from "./types.js";
import { getCodeWorkspaceScopeId } from "./codeRetrievalIdentity.js";
import { createCodeIndexFingerprint } from "./retrievalFingerprint.js";
import {
  getFileIndexJournalPath,
  loadFileIndexJournal,
} from "./fileIndexJournal.js";
import { loadIndexCache } from "./workerLib.js";
import { LanceDbRetrievalRepository } from "../storage/retrieval/LanceDbRetrievalRepository.js";

export interface FixtureFetchObservation {
  type: "fixtureFetch";
  operation: "embedding";
  attempt: number;
  phase: "start" | "complete";
  activeRequests: number;
  firstInput?: string;
}

export type FixtureMessage = WorkerToExtensionMessage | FixtureFetchObservation;

export interface WorkerFixture {
  child: ChildProcess;
  messages: FixtureMessage[];
  send(message: ExtensionToWorkerMessage): void;
  waitFor<T extends FixtureMessage["type"]>(
    type: T,
    predicate?: (message: Extract<FixtureMessage, { type: T }>) => boolean,
  ): Promise<Extract<FixtureMessage, { type: T }>>;
  complete(message: ExtensionToWorkerMessage): Promise<IndexStats>;
}

export interface WorkspaceFixture {
  root: string;
  cachePath: string;
  retrievalStoreRoot: string;
}

export const TEST_TIMEOUT_MS = 60_000;
let buildRoot: string;
let workerPath: string;
let shimPath: string;

/** Bundles the worker and its fetch shim for the calling test file. */
export function setUpWorkerFixtureBuild(): void {
  beforeAll(async () => {
    buildRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "indexer-worker-fixture-"),
    );
    workerPath = path.join(buildRoot, "indexer-worker.cjs");
    shimPath = path.join(buildRoot, "fixture-fetch-shim.cjs");
    await Promise.all([
      build({
        entryPoints: [path.resolve("src/indexer/worker.ts")],
        bundle: true,
        outfile: workerPath,
        format: "cjs",
        platform: "node",
        target: "node22",
        external: ["@lancedb/lancedb", "apache-arrow"],
        alias: {
          "web-tree-sitter": path.resolve(
            "node_modules/web-tree-sitter/web-tree-sitter.cjs",
          ),
        },
      }),
      build({
        entryPoints: [path.resolve("src/indexer/workerFixtureFetchShim.ts")],
        bundle: true,
        outfile: shimPath,
        format: "cjs",
        platform: "node",
        target: "node22",
      }),
    ]);
    const wasmRoot = path.join(buildRoot, "wasm");
    fs.mkdirSync(wasmRoot);
    fs.copyFileSync(
      "node_modules/web-tree-sitter/web-tree-sitter.wasm",
      path.join(wasmRoot, "web-tree-sitter.wasm"),
    );
    for (const file of fs.readdirSync(
      "node_modules/@vscode/tree-sitter-wasm/wasm",
    )) {
      if (file.startsWith("tree-sitter-") && file.endsWith(".wasm")) {
        fs.copyFileSync(
          path.join("node_modules/@vscode/tree-sitter-wasm/wasm", file),
          path.join(wasmRoot, file),
        );
      }
    }
  }, TEST_TIMEOUT_MS);

  afterAll(() => {
    fs.rmSync(buildRoot, { recursive: true, force: true });
  });
}

export function createWorkspace(sharedStoreRoot?: string): WorkspaceFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "indexer-scenario-"));
  onTestFinished(() =>
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 25,
    }),
  );
  return {
    root,
    cachePath: path.join(root, ".cache", "index.json"),
    retrievalStoreRoot: sharedStoreRoot ?? path.join(root, ".retrieval"),
  };
}

export function writeSource(
  root: string,
  relativePath: string,
  content: string,
): string {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
}

export function sourceContent(value: number): string {
  return `select ${value} as value, '${"fixture-content-".repeat(4)}' as label;`;
}

export function workerTarget(workspace: WorkspaceFixture) {
  return {
    indexName: "fixture",
    workspaceScopeId: getCodeWorkspaceScopeId(workspace.root),
    retrievalStoreRoot: workspace.retrievalStoreRoot,
  };
}

export function startMessage(
  workspace: WorkspaceFixture,
  options: {
    files: string[];
    bearerToken?: string | null;
    force?: boolean;
  },
): ExtensionToWorkerMessage {
  return {
    type: "start",
    files: options.files,
    workspaceRoot: workspace.root,
    ...workerTarget(workspace),
    embeddingBearerToken:
      options.bearerToken === null
        ? undefined
        : (options.bearerToken ?? "success"),
    cachePath: workspace.cachePath,
    force: options.force ?? true,
    granularity: "standard",
  };
}

export function incrementalMessage(
  workspace: WorkspaceFixture,
  options: {
    added?: string[];
    removed?: string[];
    bearerToken?: string;
  },
): ExtensionToWorkerMessage {
  return {
    type: "incrementalUpdate",
    added: options.added ?? [],
    removed: options.removed ?? [],
    workspaceRoot: workspace.root,
    ...workerTarget(workspace),
    embeddingBearerToken: options.bearerToken ?? "success",
    cachePath: workspace.cachePath,
    granularity: "standard",
  };
}

export async function createFixture(
  maxOldSpaceSizeMb = 512,
): Promise<WorkerFixture> {
  const child = fork(workerPath, [], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_PATH: path.resolve("node_modules"),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    execArgv: [
      `--max-old-space-size=${maxOldSpaceSizeMb}`,
      "--require",
      shimPath,
    ],
  });
  onTestFinished(() => stopChild(child));
  const messages: FixtureMessage[] = [];
  const errors: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk.toString()));
  child.on("message", (message: FixtureMessage) => messages.push(message));

  const waitFor = <T extends FixtureMessage["type"]>(
    type: T,
    predicate: (
      message: Extract<FixtureMessage, { type: T }>,
    ) => boolean = () => true,
  ): Promise<Extract<FixtureMessage, { type: T }>> => {
    const existingIndex = messages.findIndex(
      (message) =>
        message.type === type &&
        predicate(message as Extract<FixtureMessage, { type: T }>),
    );
    if (existingIndex >= 0) {
      return Promise.resolve(
        messages.splice(existingIndex, 1)[0] as Extract<
          FixtureMessage,
          { type: T }
        >,
      );
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out waiting for ${type}; stderr=${errors.join("")}; messages=${JSON.stringify(messages)}`,
          ),
        );
      }, TEST_TIMEOUT_MS);
      const onMessage = (message: FixtureMessage) => {
        if (message.type !== type) return;
        const typed = message as Extract<FixtureMessage, { type: T }>;
        if (!predicate(typed)) return;
        cleanup();
        const queuedIndex = messages.indexOf(message);
        if (queuedIndex >= 0) messages.splice(queuedIndex, 1);
        resolve(typed);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(
          new Error(
            `Worker exited before ${type}: code=${code} signal=${signal}; stderr=${errors.join("")}`,
          ),
        );
      };
      const cleanup = () => {
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("exit", onExit);
      };
      child.on("message", onMessage);
      child.on("exit", onExit);
    });
  };

  await waitFor("ready");
  return {
    child,
    messages,
    send(message) {
      child.send(message);
    },
    waitFor,
    async complete(message) {
      const completion = waitFor("complete");
      child.send(message);
      return (await completion).stats;
    },
  };
}

export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
    forceKill.unref();
    child.once("exit", () => {
      clearTimeout(forceKill);
      resolve();
    });
    child.kill();
  });
}

export async function withRepository<T>(
  root: string,
  run: (repository: LanceDbRetrievalRepository) => Promise<T>,
): Promise<T> {
  const repository = new LanceDbRetrievalRepository({
    root,
    embeddingDimensions: 1536,
  });
  try {
    const migration = await repository.migrate(
      createCodeIndexFingerprint("standard"),
    );
    expect(migration.status).not.toBe("rebuild_required");
    return await run(repository);
  } finally {
    await repository.close();
  }
}

export function requireCache(workspace: WorkspaceFixture) {
  const loaded = loadIndexCache(workspace.cachePath);
  expect(loaded.status).toBe("valid");
  if (loaded.status !== "valid") throw new Error("Expected valid cache");
  return loaded.cache;
}

export function expectEmptyJournal(workspace: WorkspaceFixture): void {
  expect(
    loadFileIndexJournal(getFileIndexJournalPath(workspace.cachePath)),
  ).toMatchObject({
    status: "valid",
    journal: { operations: [] },
  });
}
