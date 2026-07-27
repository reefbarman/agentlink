import { fork, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { build } from "esbuild";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

interface FixtureMessage {
  type:
    | "ready"
    | "committed"
    | "prepared_locked"
    | "query_result"
    | "repair_result"
    | "closed"
    | "error";
  role?: string;
  message?: string;
  publicationId?: string;
  chunkIds?: string[];
  abandonedChunkIds?: string[];
  outcome?: {
    status?: string;
    abandonedPublications?: number;
    orphanedChunksRemoved?: number;
    orphanedRelationsRemoved?: number;
  };
  health?: {
    pendingPublications?: number;
    sourceCount?: number;
    chunkCount?: number;
  };
}

const TEST_TIMEOUT_MS = 60_000;
let buildRoot: string;
let fixturePath: string;

beforeAll(async () => {
  buildRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentlink-lancedb-process-fixture-"),
  );
  fixturePath = path.join(buildRoot, "retrieval-process-fixture.cjs");
  await build({
    entryPoints: [
      path.resolve(
        "src/storage/retrieval/fixtures/lanceDbRetrievalProcessFixture.ts",
      ),
    ],
    bundle: true,
    outfile: fixturePath,
    format: "cjs",
    platform: "node",
    target: "node22",
    external: ["@lancedb/lancedb", "apache-arrow"],
  });
}, TEST_TIMEOUT_MS);

afterAll(() => {
  fs.rmSync(buildRoot, { recursive: true, force: true });
});

describe("LanceDbRetrievalRepository process resilience", () => {
  it(
    "keeps an open reader current and repairs a killed lock owner",
    async () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "agentlink-lancedb-three-process-"),
      );
      const children: ChildProcess[] = [];
      onTestFinished(async () => {
        await Promise.all(children.map(stopChild));
        fs.rmSync(root, { recursive: true, force: true });
      });

      const reader = startFixture(root, "reader");
      children.push(reader.child);
      expect(await reader.waitFor("ready")).toMatchObject({ role: "reader" });

      const writer = startFixture(root, "writer");
      children.push(writer.child);
      expect(await writer.waitFor("committed")).toMatchObject({
        outcome: { status: "published" },
      });
      await waitForExit(writer.child);

      reader.child.send({ type: "query" });
      expect(await reader.waitFor("query_result")).toMatchObject({
        chunkIds: ["chunk:writer"],
      });

      const crashOwner = startFixture(root, "crash-owner");
      children.push(crashOwner.child);
      expect(await crashOwner.waitFor("prepared_locked")).toMatchObject({
        publicationId: "abandoned",
      });
      await killChild(crashOwner.child);
      const staleTime = new Date(Date.now() - 60_000);
      fs.utimesSync(`${root}.lock`, staleTime, staleTime);

      reader.child.send({ type: "repair" });
      expect(await reader.waitFor("repair_result")).toMatchObject({
        outcome: {
          status: "repaired",
          abandonedPublications: 1,
          orphanedChunksRemoved: 0,
          orphanedRelationsRemoved: 0,
        },
        health: {
          pendingPublications: 0,
          sourceCount: 1,
          chunkCount: 1,
        },
        abandonedChunkIds: [],
      });

      reader.child.send({ type: "close" });
      expect(await reader.waitFor("closed")).toMatchObject({ type: "closed" });
      await waitForExit(reader.child);
    },
    TEST_TIMEOUT_MS,
  );
});

function startFixture(
  root: string,
  role: "reader" | "writer" | "crash-owner",
): {
  child: ChildProcess;
  waitFor(type: FixtureMessage["type"]): Promise<FixtureMessage>;
} {
  const child = fork(fixturePath, [], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_PATH: path.resolve("node_modules"),
      RETRIEVAL_FIXTURE_ROOT: root,
      RETRIEVAL_FIXTURE_ROLE: role,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages: FixtureMessage[] = [];
  const errors: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk.toString()));
  child.on("message", (message: FixtureMessage) => messages.push(message));

  return {
    child,
    waitFor(type) {
      const existing = messages.findIndex((message) => message.type === type);
      if (existing >= 0)
        return Promise.resolve(messages.splice(existing, 1)[0]!);
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
          if (message.type === "error") {
            cleanup();
            reject(new Error(message.message ?? "Fixture failed"));
            return;
          }
          if (message.type !== type) return;
          cleanup();
          const index = messages.indexOf(message);
          if (index >= 0) messages.splice(index, 1);
          resolve(message);
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          cleanup();
          reject(
            new Error(
              `Fixture exited before ${type}: code=${code} signal=${signal}; stderr=${errors.join("")}`,
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
    },
  };
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 1_000);
    timeout.unref();
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill();
  });
}
