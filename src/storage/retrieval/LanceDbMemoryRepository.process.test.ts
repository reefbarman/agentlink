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
  type: "ready" | "committed" | "locked" | "inspection" | "closed" | "error";
  role?: string;
  message?: string;
  result?: { disposition?: string };
  records?: Array<{
    id: string;
    revision: number;
    statement: string;
    status: string;
  }>;
  auditCount?: number;
  revisionCounts?: Record<string, number>;
  health?: {
    status?: string;
    retrieval?: string;
    recordCount?: number;
    activeRecordCount?: number;
    auditEventCount?: number;
  };
}

const TEST_TIMEOUT_MS = 60_000;
let buildRoot: string;
let fixturePath: string;

beforeAll(async () => {
  buildRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentlink-lancedb-memory-process-fixture-"),
  );
  fixturePath = path.join(buildRoot, "memory-process-fixture.cjs");
  await build({
    entryPoints: [
      path.resolve(
        "src/storage/retrieval/fixtures/lanceDbMemoryProcessFixture.ts",
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
  if (buildRoot) fs.rmSync(buildRoot, { recursive: true, force: true });
});

describe("LanceDbMemoryRepository process resilience", () => {
  it(
    "keeps an open reader current and reclaims a killed real lock owner",
    async () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "agentlink-lancedb-memory-process-"),
      );
      const children: ChildProcess[] = [];
      onTestFinished(async () => {
        await Promise.all(children.map(stopChild));
        fs.rmSync(root, { recursive: true, force: true });
      });

      const reader = startFixture(root, "reader");
      children.push(reader.child);
      expect(await reader.waitFor("ready")).toMatchObject({ role: "reader" });

      for (const role of ["writer-a", "writer-b"] as const) {
        const writer = startFixture(root, role);
        children.push(writer.child);
        expect(await writer.waitFor("committed")).toMatchObject({
          role,
          result: { disposition: "created" },
        });
        await waitForExit(writer.child);
      }

      reader.child.send({ type: "inspect" });
      const beforeCrash = await reader.waitFor("inspection");
      expect(beforeCrash).toMatchObject({
        auditCount: 2,
        health: {
          status: "ready",
          retrieval: "lexical-only",
          recordCount: 2,
          activeRecordCount: 2,
          auditEventCount: 2,
        },
      });
      expect(
        beforeCrash.records?.map((record) => record.statement).sort(),
      ).toEqual([
        "Browser instance identities are workspace scoped.",
        "The native package target is darwin arm64.",
      ]);
      expect(Object.values(beforeCrash.revisionCounts ?? {})).toEqual([1, 1]);

      const crashOwner = startFixture(root, "crash-owner");
      children.push(crashOwner.child);
      expect(await crashOwner.waitFor("locked")).toMatchObject({
        role: "crash-owner",
      });
      await killChild(crashOwner.child);
      makeActualLockOwnerStale(root);

      reader.child.send({ type: "inspect" });
      const afterCrash = await reader.waitFor("inspection");
      expect(afterCrash).toMatchObject({
        records: beforeCrash.records,
        auditCount: 2,
        revisionCounts: beforeCrash.revisionCounts,
        health: {
          status: "ready",
          retrieval: "lexical-only",
          recordCount: 2,
          activeRecordCount: 2,
          auditEventCount: 2,
        },
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
  role: "reader" | "writer-a" | "writer-b" | "crash-owner",
): {
  child: ChildProcess;
  waitFor(type: FixtureMessage["type"]): Promise<FixtureMessage>;
} {
  const child = fork(fixturePath, [], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_PATH: path.resolve("node_modules"),
      MEMORY_FIXTURE_ROOT: root,
      MEMORY_FIXTURE_ROLE: role,
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
      if (existing >= 0) {
        return Promise.resolve(messages.splice(existing, 1)[0]!);
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

function makeActualLockOwnerStale(root: string): void {
  const lockDirectory = `${root}.lock`;
  const owners = fs.readdirSync(lockDirectory);
  expect(owners).toHaveLength(1);
  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(lockDirectory, owners[0]!), stale, stale);
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
